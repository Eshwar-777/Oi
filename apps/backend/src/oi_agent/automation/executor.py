from __future__ import annotations

import asyncio
import base64
import copy
import hashlib
import json
import logging
import platform
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, cast
from urllib.parse import urlparse

from oi_agent.automation.events import publish_activity_event, publish_event
from oi_agent.api.websocket import connection_manager
from oi_agent.automation.events import publish_event
from oi_agent.automation.models import (
    AgentBrowserStep,
    AutomationPlan,
    AutomationRun,
    AutomationStep,
    BrowserStateSnapshot,
    EvidenceQualityScores,
    ExecutionModeDecision,
    ExecutionPhaseState,
    ExecutionProgress,
    ResumeDecision,
    RunArtifact,
    RunError,
    RunState,
    RuntimeActionPlan,
    RuntimeBlock,
    RuntimeIncident,
    RunTransition,
    UnifiedEvidenceBundle,
)
from oi_agent.automation.response_composer import (
    compose_cancellation_payload,
    compose_completion_payload,
)
from oi_agent.automation.runtime_client import (
    automation_runtime_enabled,
    execute_browser_prompt_via_runtime,
    execute_browser_steps_via_runtime,
)
from oi_agent.automation.state_machine import is_terminal_state
from oi_agent.automation.store import (
    get_browser_session,
    get_plan,
    get_run,
    save_artifacts,
    save_plan,
    save_run_transition,
    update_run,
)
from oi_agent.config import settings
from oi_agent.services.tools.base import ToolResult
from oi_agent.services.tools.navigator.action_contract import (
    browser_action_target_supported,
)
from oi_agent.services.tools.navigator.site_playbooks import build_playbook_context
from oi_agent.services.tools.navigator.visual_fallback import (
    ScreenshotBasis,
    build_screenshot_basis,
    verify_visual_fallback,
)
from oi_agent.services.tools.step_planner import plan_runtime_action

_tasks: dict[str, asyncio.Task[None]] = {}
_task_lock = asyncio.Lock()
logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def _publish_run_activity(
    *,
    user_id: str,
    session_id: str,
    run_id: str,
    summary: str | None,
    tone: str = "neutral",
) -> None:
    cleaned = str(summary or "").strip()
    if not cleaned:
        return
    await publish_activity_event(
        user_id=user_id,
        session_id=session_id,
        run_id=run_id,
        summary=cleaned,
        tone=tone,
    )


def _truncate_log_value(value: Any, *, limit: int = 240) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return f"{text[: limit - 3]}..."


def _agent_progress_phrase(command: str) -> str:
    normalized = str(command or "").strip().lower()
    mapping = {
        "open": "opening the next page",
        "navigate": "opening the next page",
        "snapshot": "checking the current page",
        "read_dom": "checking the current page",
        "extract_structured": "reading the current page",
        "extract": "reviewing the current page details",
        "screenshot": "checking the current page",
        "diagnostics": "diagnosing the current page",
        "scan_ui_blockers": "checking for blockers",
        "click": "interacting with the page",
        "hover": "interacting with the page",
        "select": "choosing an option on the page",
        "press": "using the page controls",
        "keyboard": "using the page controls",
        "tab": "switching browser context",
        "frame": "switching browser context",
        "type": "filling in the required fields",
        "upload": "adding the required file",
        "scroll": "looking for the right area on the page",
        "wait": "waiting for the page to update",
    }
    return mapping.get(normalized, "working through the next browser step")


_MAX_SOFT_NO_PROGRESS_RECOVERIES = 1


def _agent_progress_message(
    *,
    command: str,
    label: str,
    status: str,
) -> str:
    trimmed_label = str(label or "").strip().rstrip(".")
    phrase = _agent_progress_phrase(command)
    if status == "running":
        return f"I’m {phrase}: {trimmed_label}." if trimmed_label else f"I’m {phrase}."
    if status == "completed":
        return f"I finished: {trimmed_label}." if trimmed_label else "I finished that step."
    if status == "failed":
        return f"I hit an issue while {phrase}." if not trimmed_label else f"I hit an issue while working on: {trimmed_label}."
    return trimmed_label or "I’m continuing with the task."


def _runtime_log_message_visible(payload: dict[str, Any]) -> bool:
    return _sanitize_runtime_user_message(payload) is not None


def _sanitize_runtime_user_message(payload: dict[str, Any]) -> str | None:
    source = str(payload.get("source", "") or "").strip().lower()
    message = str(payload.get("message", "") or "").strip()
    if not message:
        return None
    if source in {"runtime-stdout", "runtime-stderr"} and "[dotenv@" in message:
        return None
    if "dotenv@" in message:
        return None
    if source in {"runtime-stdout", "runtime-stderr"} and (
        message.startswith("[diagnostic]")
        or "maxlistenersexceededwarning" in message.lower()
        or message.startswith("(Use `node --trace-warnings")
    ):
        return None
    lowered = message.lower()
    if (
        lowered.startswith("[runtime/")
        or lowered.startswith("[agent-browser")
        or lowered.startswith("at async ")
        or lowered.startswith("error:")
        or lowered.startswith("{\"phase\":")
        or lowered.startswith("{\"text\":")
        or "embedded run prompt end" in lowered
        or "seeded runtime config" in lowered
        or "/node_modules/" in message
        or "/users/" in lowered
    ):
        return None
    if "prepared runtime session" in lowered:
        return "I’m preparing the browser session."
    if "invoking runembeddedbrowserpiagent" in lowered:
        return None
    if "api rate limit reached" in lowered:
        return "The run is temporarily blocked by a model rate limit and needs a retry."
    if "peer closed connection" in lowered:
        return "The run lost its live connection and is retrying."
    return message


def _runtime_browser_args(payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], str]:
    args = payload.get("args", {}) if isinstance(payload.get("args"), dict) else {}
    request = args.get("request", {}) if isinstance(args.get("request"), dict) else {}
    meta = str(payload.get("meta", "") or "").strip().lower()
    action = str(args.get("action", "") or "").strip().lower()
    if action == "act":
        nested_kind = str(request.get("kind", "") or "").strip().lower()
        if nested_kind:
            action = nested_kind
        elif meta.startswith("kind "):
            action = meta.split(" ", 1)[1].strip().lower()
    if not action and meta.startswith("kind "):
        action = meta.split(" ", 1)[1].strip().lower()
    return args, request, action


def _runtime_tool_progress_entry(
    *,
    payload: dict[str, Any],
    status: str,
) -> dict[str, Any]:
    args, request, action = _runtime_browser_args(payload)
    result = payload.get("result", {}) if isinstance(payload.get("result"), dict) else {}
    tool_name = str(payload.get("toolName", "") or "tool").strip()
    if not action and tool_name == "browser":
        if isinstance(args.get("url"), str) and str(args.get("url", "")).strip():
            action = "navigate"
        elif isinstance(args.get("text"), str):
            action = "type"
        elif isinstance(args.get("key"), str):
            action = "press"
        elif "x" in args or "y" in args:
            action = "scroll"
        elif args.get("interactive") is not None or args.get("compact") is not None:
            action = "snapshot"
    if not action:
        action = tool_name.lower()
    label = ""
    if tool_name == "browser":
        target_ref = str(request.get("ref", "") or args.get("ref", "") or "").strip()
        target_selector = str(
            request.get("selector", "") or args.get("selector", "") or ""
        ).strip()
        typed_text = str(request.get("text", "") or args.get("text", "") or "").strip()
        pressed_key = str(request.get("key", "") or args.get("key", "") or "").strip()
        if action == "navigate":
            label = f"Open {str(args.get('url', '') or '').strip()}".strip()
        elif action == "snapshot":
            label = "Inspect the current page state"
        elif action == "type":
            label = f'Type "{typed_text}"' if typed_text else "Fill the current field"
        elif action == "press":
            key = pressed_key or "a key"
            label = "Submit the current input" if key.lower() == "enter" else f"Press {key}"
        elif action == "scroll":
            label = "Scroll through the current page"
        elif action == "click":
            selector_looks_internal = any(token in target_selector for token in (":", "[", "]", ">", ".", "#", "has-text"))
            if target_selector and not selector_looks_internal:
                label = f"Click {target_selector}"
            elif target_ref or target_selector:
                label = "Click the current page control"
            else:
                label = "Click the current target"
        elif action == "select":
            label = "Choose an option on the page"
        elif action == "hover":
            label = "Hover the current target"
        elif action == "fill":
            label = "Fill the current form"
    if not label:
        label = f"{tool_name} {action}".strip()
    entry = {
        "step_id": str(payload.get("toolCallId", "") or ""),
        "command": action or tool_name,
        "label": label,
        "status": status,
        "started_at": _now_iso() if status == "running" else None,
        "finished_at": _now_iso() if status != "running" else None,
        "message": _agent_progress_message(
            command=action or tool_name,
            label=label,
            status="running" if status == "running" else "completed" if status == "completed" else "failed",
        ),
    }
    if status != "running":
        is_error = bool(payload.get("isError", False))
        if is_error:
            entry["status"] = "failed"
            entry["message"] = _agent_progress_message(
                command=action or tool_name,
                label=label,
                status="failed",
            )
        elif action == "navigate":
            details = result.get("details", {}) if isinstance(result.get("details"), dict) else {}
            url = str(details.get("url", "") or args.get("url", "") or "").strip()
            if url:
                entry["message"] = f"I opened {url}."
    return {key: value for key, value in entry.items() if value not in (None, "")}


def _runtime_browser_snapshot_text(payload: dict[str, Any]) -> str:
    result = payload.get("result", {}) if isinstance(payload.get("result"), dict) else {}
    content = result.get("content", [])
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        if str(item.get("type", "") or "") != "text":
            continue
        text = str(item.get("text", "") or "").strip()
        if text:
            parts.append(text)
    return "\n".join(parts).strip()


def _runtime_observation_matches_previous(
    previous: dict[str, Any] | None,
    *,
    target_id: str,
    url: str,
    title: str,
) -> bool:
    if not isinstance(previous, dict) or not previous:
        return False
    previous_target_id = str(previous.get("targetId", "") or "").strip()
    previous_url = str(previous.get("url", "") or "").strip()
    previous_title = str(previous.get("title", "") or "").strip()
    if previous_target_id and target_id:
        return previous_target_id == target_id
    if previous_target_id and not target_id:
        url_conflicts = bool(previous_url and url) and previous_url != url
        title_conflicts = bool(previous_title and title) and previous_title != title
        return not (url_conflicts and title_conflicts)
    if target_id and not previous_target_id:
        return True
    return True


def _runtime_browser_observation_from_payload(
    payload: dict[str, Any],
    previous: dict[str, Any] | None = None,
) -> dict[str, Any]:
    args, request, action = _runtime_browser_args(payload)
    result = payload.get("result", {}) if isinstance(payload.get("result"), dict) else {}
    details = result.get("details", {}) if isinstance(result.get("details"), dict) else {}
    target_id = str(
        details.get("targetId", "")
        or request.get("targetId", "")
        or args.get("targetId", "")
        or ""
    ).strip()
    raw_url = str(details.get("url", "") or args.get("url", "") or "").strip()
    raw_title = str(details.get("title", "") or "").strip()
    observation = (
        dict(previous or {})
        if _runtime_observation_matches_previous(
            previous,
            target_id=target_id,
            url=raw_url,
            title=raw_title,
        )
        else {}
    )
    url = str(raw_url or observation.get("url", "") or "").strip()
    title = str(raw_title or observation.get("title", "") or "").strip()
    snapshot_text = observation.get("snapshot_text", "") if isinstance(observation.get("snapshot_text", ""), str) else ""
    if action == "snapshot":
        snapshot_text = _runtime_browser_snapshot_text(payload)
    observation.update(
        {
            "url": url or None,
            "title": title or None,
            "targetId": target_id or None,
            "snapshot_text": snapshot_text or None,
        }
    )
    return observation


def _runtime_snapshot_payload(observation: dict[str, Any]) -> dict[str, Any] | None:
    snapshot_text = str(observation.get("snapshot_text", "") or "").strip()
    if not snapshot_text:
        return None
    return {"snapshot": snapshot_text}


def _runtime_action_signature(payload: dict[str, Any]) -> str:
    args, request, action = _runtime_browser_args(payload)
    result = payload.get("result", {}) if isinstance(payload.get("result"), dict) else {}
    details = result.get("details", {}) if isinstance(result.get("details"), dict) else {}
    signature_parts = [
        action,
        str(request.get("ref", "") or args.get("ref", "") or "").strip(),
        str(request.get("selector", "") or args.get("selector", "") or "").strip(),
        str(request.get("text", "") or args.get("text", "") or "").strip()[:80],
        str(request.get("key", "") or args.get("key", "") or "").strip(),
        str(details.get("url", "") or args.get("url", "") or "").strip(),
    ]
    return "|".join(signature_parts)


def _soft_incident_signature(incident: RuntimeIncident) -> str:
    snapshot = incident.browser_snapshot
    raw = "|".join(
        [
            str(incident.code or "").strip(),
            str(snapshot.url or "") if snapshot else "",
            str(snapshot.title or "") if snapshot else "",
            str(snapshot.page_id or "") if snapshot else "",
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _register_soft_runtime_incident(
    *,
    tracker: dict[str, Any],
    incident: RuntimeIncident | None,
) -> tuple[dict[str, Any], RuntimeIncident | None]:
    next_tracker = dict(tracker or {})
    if incident is None:
        return next_tracker, None
    signature = _soft_incident_signature(incident)
    repeated_count = int(next_tracker.get("repeated_soft_incident_count", 0) or 0)
    if (
        signature
        and signature == str(next_tracker.get("last_soft_incident_signature", "") or "")
        and str(incident.code or "").strip() == str(next_tracker.get("last_soft_incident_code", "") or "")
    ):
        repeated_count += 1
    else:
        repeated_count = 1
    next_tracker.update(
        {
            "last_soft_incident_signature": signature or None,
            "last_soft_incident_code": str(incident.code or "").strip() or None,
            "repeated_soft_incident_count": repeated_count,
            "last_updated_at": _now_iso(),
        }
    )
    if incident.code not in {"RUNTIME_NO_PROGRESS", "RUNTIME_EVENT_NO_PROGRESS"}:
        return next_tracker, incident
    if repeated_count <= _MAX_SOFT_NO_PROGRESS_RECOVERIES:
        return next_tracker, incident
    blocking_incident = incident.model_copy(
        update={
            "severity": "critical",
            "code": "RUNTIME_NO_PROGRESS_PERSISTED",
            "summary": "The run is still stuck on the same page after retrying once.",
            "details": "The agent retried from the current live browser state but still could not make meaningful progress.",
            "replannable": False,
            "user_visible": True,
        }
    )
    return next_tracker, blocking_incident


def _track_runtime_event_progress(
    *,
    tracker: dict[str, Any],
    payload: dict[str, Any],
    observation: dict[str, Any],
) -> tuple[dict[str, Any], RuntimeIncident | None]:
    next_tracker = dict(tracker or {})
    args = payload.get("args", {}) if isinstance(payload.get("args"), dict) else {}
    action = str(args.get("action", "") or "").strip().lower()
    current_url = str(observation.get("url", "") or "").strip()
    current_title = str(observation.get("title", "") or "").strip()
    current_snapshot_hash = _screenshot_hash(str(observation.get("snapshot_text", "") or ""))
    repeated_snapshot_count = int(next_tracker.get("repeated_runtime_snapshot_count", 0) or 0)
    if action == "snapshot" and current_snapshot_hash:
        if (
            current_snapshot_hash == str(next_tracker.get("last_runtime_snapshot_hash", "") or "")
            and current_url == str(next_tracker.get("last_url", "") or current_url)
            and current_title == str(next_tracker.get("last_title", "") or current_title)
        ):
            repeated_snapshot_count += 1
        else:
            repeated_snapshot_count = 0
        next_tracker["last_runtime_snapshot_hash"] = current_snapshot_hash
        next_tracker["repeated_runtime_snapshot_count"] = repeated_snapshot_count

    action_signature = _runtime_action_signature(payload)
    repeated_action_count = int(next_tracker.get("repeated_runtime_action_count", 0) or 0)
    if action_signature and action_signature == str(next_tracker.get("last_runtime_action_signature", "") or ""):
        repeated_action_count += 1
    else:
        repeated_action_count = 0
    next_tracker["last_runtime_action_signature"] = action_signature or None
    next_tracker["repeated_runtime_action_count"] = repeated_action_count
    if current_url:
        next_tracker["last_url"] = current_url
    if current_title:
        next_tracker["last_title"] = current_title
    next_tracker["last_updated_at"] = _now_iso()

    if repeated_snapshot_count < 2 and repeated_action_count < 3:
        return next_tracker, None

    incident = RuntimeIncident(
        incident_id=str(uuid.uuid4()),
        category="blocker",
        severity="warning",
        code="RUNTIME_EVENT_NO_PROGRESS",
        summary="The browser is repeating the same observation cycle without clear progress.",
        details=f"The agent is still on {current_title or current_url or 'the current page'} and has repeated similar browser actions.",
        visible_signals=["runtime_repeated_snapshot", "runtime_repeated_action", "no_progress"],
        requires_human=False,
        replannable=True,
        user_visible=True,
        browser_snapshot=BrowserStateSnapshot(
            captured_at=_now_iso(),
            url=current_url or None,
            title=current_title or None,
            page_id=(str(observation.get("targetId", "") or "").strip() or None),
            metadata={"source": "runtime-event"},
        ),
        created_at=_now_iso(),
    )
    return next_tracker, incident


def _log_workflow_trace(event: str, **fields: Any) -> None:
    logger.info(event, extra=fields)


async def _prepare_runtime_browser_surface(
    browser_session_id: str | None,
    *,
    page_registry: dict[str, dict[str, Any]] | None = None,
    active_page_ref: str | None = None,
    target_app: str | None = None,
    goal_text: str | None = None,
) -> None:
    session_id = str(browser_session_id or "").strip()
    if not session_id:
        return
    runner_id = connection_manager.get_runner_for_session(session_id)
    if not runner_id:
        return
    resolved_page_ref, target = _resolve_runtime_target_page(
        page_registry=page_registry,
        active_page_ref=active_page_ref,
        target_app=target_app,
        goal_text=goal_text,
    )
    if not target:
        return
    session_row = await get_browser_session(session_id)
    session_pages = list((session_row or {}).get("pages", []) or []) if isinstance(session_row, dict) else []
    matched_page_id = str(target.get("page_id") or "").strip()
    matched_tab_index: int | None = None
    if not matched_page_id and session_pages:
        target_url = str(target.get("url") or "").strip()
        target_title = str(target.get("title") or "").strip()
        best_match: tuple[int, int, dict[str, Any]] | None = None
        for index, page in enumerate(session_pages):
            if not isinstance(page, dict):
                continue
            page_url = str(page.get("url") or "").strip()
            page_title = str(page.get("title") or "").strip()
            score = 0
            if target_url and page_url == target_url:
                score += 100
            elif target_url and page_url and target_url in page_url:
                score += 60
            if target_title and page_title == target_title:
                score += 40
            elif target_title and page_title and target_title in page_title:
                score += 20
            if score <= 0:
                continue
            if best_match is None or score > best_match[0]:
                best_match = (score, index, page)
        if best_match is not None:
            _, matched_tab_index, matched_page = best_match
            matched_page_id = str(matched_page.get("page_id") or "").strip()
    sent = await connection_manager.send_to_runner(
        runner_id,
        {
            "type": "session_control",
            "payload": {
                "session_id": session_id,
                "action": "activate_page",
                "url": str(target.get("url") or ""),
                "page_title": str(target.get("title") or ""),
                "page_id": matched_page_id or str(target.get("page_id") or resolved_page_ref or ""),
                "tab_index": (
                    matched_tab_index
                    if matched_tab_index is not None
                    else int(target.get("tab_index", 0) or 0)
                    if str(target.get("tab_index", "")).strip().isdigit()
                    else None
                ),
            },
        },
    )
    logger.info(
        "Prepared runtime browser surface",
        extra={
            "session_id": session_id,
            "runner_id": runner_id,
            "resolved_page_ref": resolved_page_ref,
            "target_url": str(target.get("url") or ""),
            "target_title": str(target.get("title") or ""),
            "matched_page_id": matched_page_id,
            "matched_tab_index": matched_tab_index,
            "sent": sent,
        },
    )
    if sent:
        await asyncio.sleep(0.6)


def _coerce_run_state(value: str | None) -> RunState | None:
    known_states: set[str] = {
        "draft",
        "awaiting_clarification",
        "awaiting_execution_mode",
        "awaiting_confirmation",
        "scheduled",
        "queued",
        "starting",
        "running",
        "paused",
        "waiting_for_user_action",
        "waiting_for_human",
        "human_controlling",
        "reconciling",
        "resuming",
        "retrying",
        "completed",
        "succeeded",
        "failed",
        "cancelled",
        "canceled",
        "timed_out",
        "expired",
    }
    return cast(RunState | None, value) if value in known_states else None


async def _complete_run_from_planner(
    *,
    run_id: str,
    user_id: str,
    session_id: str,
    plan: AutomationPlan,
    completed_steps: int,
    completion_message: str,
) -> None:
    await _update_run_progress(run_id, min(completed_steps - 1, len(plan.steps) - 1) if completed_steps > 0 and plan.steps else None)
    await _set_run_state(run_id, "completed")
    await _publish_run_activity(
        user_id=user_id,
        session_id=session_id,
        run_id=run_id,
        summary=completion_message,
        tone="success",
    )
    _log_workflow_trace(
        "automation_run_execution_completed",
        run_id=run_id,
        session_id=session_id,
        plan_id=plan.plan_id,
        completed_steps=completed_steps,
        total_steps=len(plan.steps),
        overall_success=True,
    )
    await publish_event(
        user_id=user_id,
        session_id=session_id,
        run_id=run_id,
        event_type="run.completed",
        payload={"run_id": run_id, **compose_completion_payload(completion_message)},
    )


_DOMAIN_PATTERN = re.compile(r"(https?://[^\s]+|(?:[a-z0-9-]+\.)+[a-z]{2,})(?:/[^\s]*)?", re.IGNORECASE)


def _normalize_seed_url(raw: str) -> str:
    value = raw.strip().strip(".,)")
    if not value:
      return ""
    if not value.startswith(("http://", "https://")):
        value = f"https://{value}"
    return value


def _infer_seed_navigation_url(plan: AutomationPlan) -> str:
    for step in plan.steps:
        for candidate in [
            str(step.description or ""),
            str(step.label or ""),
            str(step.page_hint or ""),
        ]:
            match = _DOMAIN_PATTERN.search(candidate)
            if match:
                return _normalize_seed_url(match.group(1))
    match = _DOMAIN_PATTERN.search(str(plan.summary or ""))
    return _normalize_seed_url(match.group(1)) if match else ""


def _should_seed_navigation(current_url: str, target_url: str) -> bool:
    current = str(current_url or "").strip().lower()
    target = str(target_url or "").strip().lower()
    if not target:
        return False
    if not current or current.startswith("about:blank"):
        return True
    if "example.com" in current:
        return True
    current_host = urlparse(current).netloc or current.split("/")[0]
    target_host = urlparse(target).netloc or target.split("/")[0]
    if not current_host or not target_host:
        return current != target
    return current_host != target_host


def _planner_declares_completion(planner_result: dict[str, Any] | None) -> bool:
    status = str((planner_result or {}).get("status", "") or "").strip().upper()
    return status == "COMPLETED"


async def _record_transition(
    *,
    run_id: str,
    from_state: RunState | None,
    to_state: RunState,
    reason_code: str,
    reason_text: str = "",
) -> None:
    transition = RunTransition(
        transition_id=str(uuid.uuid4()),
        run_id=run_id,
        from_state=from_state, 
        to_state=to_state, 
        reason_code=reason_code,
        reason_text=reason_text,
        actor_type="system",
        created_at=_now_iso(),
    )
    await save_run_transition(transition.transition_id, transition.model_dump(mode="json"))


def _coerce_step_kind(action: str) -> str:
    normalized = "navigate" if action == "open" else action
    known = {"navigate", "click", "type", "scroll", "wait", "extract", "hover", "select", "press", "snapshot", "upload", "tab", "frame"}
    return normalized if normalized in known else "unknown"


def _coerce_phase_status(value: str) -> Literal["pending", "active", "completed", "blocked"]:
    if value in {"pending", "active", "completed", "blocked"}:
        return cast(Literal["pending", "active", "completed", "blocked"], value)
    return "pending"


def _steps_from_browser_plan(
    steps: list[dict[str, Any]],
    *,
    existing_steps: list[AutomationStep] | None = None,
) -> list[AutomationStep]:
    rows: list[AutomationStep] = []
    used_step_ids: set[str] = set()
    for idx, step in enumerate(steps):
        if not isinstance(step, dict) or step.get("type") != "browser":
            continue
        action = str(step.get("command", "") or step.get("action", "")).strip().lower()
        label = str(step.get("description") or action.title() or f"Step {idx + 1}").strip()
        existing = existing_steps[idx] if existing_steps and idx < len(existing_steps) else None
        candidate_step_id = str(existing.step_id if existing else (step.get("id") or f"s{idx + 1}"))
        step_id = candidate_step_id
        dedupe_suffix = 2
        while step_id in used_step_ids:
            step_id = f"{candidate_step_id}-{dedupe_suffix}"
            dedupe_suffix += 1
        used_step_ids.add(step_id)
        rows.append(
            AutomationStep(
                step_id=step_id,
                phase_index=(
                    int(phase_index_raw)
                    if (phase_index_raw := step.get("phase_index")) is not None
                    else existing.phase_index if existing else None
                ),
                command_payload=AgentBrowserStep.model_validate(copy.deepcopy(step)),
                label=label,
                description=label,
                target=copy.deepcopy(step.get("target")),
                value=copy.deepcopy(step.get("value")),
                args=[str(arg) for arg in list(step.get("args", []) or []) if str(arg).strip()],
                snapshot_id=str(step.get("snapshot_id", "") or "") or None,
                disambiguation=copy.deepcopy(step.get("disambiguation", {}) or {}),
                preconditions=copy.deepcopy(list(step.get("preconditions", []) or [])),
                success_criteria=copy.deepcopy(list(step.get("success_criteria", []) or [])),
                page_hint=existing.page_hint if existing else None,
                page_ref=existing.page_ref if existing else None,
                output_key=existing.output_key if existing else None,
                consumes_keys=list(existing.consumes_keys) if existing else [],
                status="pending",
            )
        )
    return rows


def _active_phase_index_for_steps(
    steps: list[AutomationStep],
    *,
    completed_count: int = 0,
    fallback_phase_index: int | None = None,
) -> int | None:
    for step in steps[completed_count:]:
        if step.phase_index is not None:
            return step.phase_index
    return fallback_phase_index


def _merge_replanned_phase_steps(
    *,
    existing_steps: list[AutomationStep],
    completed_count: int,
    replanned_steps_raw: list[dict[str, Any]],
    fallback_phase_index: int | None = None,
) -> list[AutomationStep]:
    completed_prefix = list(existing_steps[:completed_count])
    active_phase_index = _active_phase_index_for_steps(
        existing_steps,
        completed_count=completed_count,
        fallback_phase_index=fallback_phase_index,
    )
    if active_phase_index is None:
        return completed_prefix + _steps_from_browser_plan(replanned_steps_raw)

    current_phase_existing = [
        step for step in existing_steps[completed_count:] if step.phase_index == active_phase_index
    ]
    future_phase_steps = [
        step
        for step in existing_steps[completed_count:]
        if step.phase_index is not None and step.phase_index > active_phase_index
    ]
    updated_current_phase = _steps_from_browser_plan(
        replanned_steps_raw,
        existing_steps=current_phase_existing,
    )
    updated_current_phase = [
        step if step.phase_index is not None else step.model_copy(update={"phase_index": active_phase_index})
        for step in updated_current_phase
    ]
    return completed_prefix + updated_current_phase + future_phase_steps


def _planner_execution_contract_payload(
    plan: AutomationPlan,
    run: AutomationRun | None = None,
    *,
    completed_count: int = 0,
) -> dict[str, Any] | None:
    if plan.execution_contract is None:
        return None
    payload = plan.execution_contract.model_dump(mode="json")
    predicted_plan = dict(payload.get("predicted_plan", {}) or {})
    phases = list(predicted_plan.get("phases", []) or [])
    active_phase_index = (
        run.active_phase_index
        if run and run.active_phase_index is not None
        else _active_phase_index_for_steps(plan.steps, completed_count=completed_count, fallback_phase_index=0 if phases else None)
    )
    predicted_plan["active_phase_index"] = active_phase_index
    payload["predicted_plan"] = predicted_plan
    return payload


def _phase_labels_for_plan(plan: AutomationPlan) -> list[str]:
    if plan.predicted_plan and plan.predicted_plan.phases:
        return [phase.label for phase in plan.predicted_plan.phases]
    labels_by_phase: dict[int, str] = {}
    for step in plan.steps:
        if step.phase_index is None:
            continue
        labels_by_phase.setdefault(step.phase_index, step.label or step.description or f"Phase {step.phase_index + 1}")
    if labels_by_phase:
        return [labels_by_phase[index] for index in sorted(labels_by_phase.keys())]
    return []


def _normalize_evidence_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _extract_phase_signal_fragments(value: str) -> list[str]:
    text = _normalize_evidence_text(value)
    if not text:
        return []
    fragments = [text]
    fragments.extend(match.strip() for match in re.findall(r"['\"]([^'\"]{2,160})['\"]", text))
    fragments.extend(match.strip() for match in re.findall(r"([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})", text))
    fragments.extend(match.strip() for match in re.findall(r"(https?://[^\s]+)", text))
    if ":" in text:
        _, _, tail = text.partition(":")
        tail = tail.strip()
        if tail:
            fragments.append(tail)
    deduped: list[str] = []
    for fragment in fragments:
        normalized = _normalize_evidence_text(fragment)
        if len(normalized) < 2 or normalized in deduped:
            continue
        deduped.append(normalized)
    return deduped


def _phase_signal_phrases(
    *,
    label: str,
    checks: list[str],
    phase_steps: list[AutomationStep],
) -> list[str]:
    phrases: list[str] = []
    for value in [label, *checks]:
        phrases.extend(_extract_phase_signal_fragments(value))
    for step in phase_steps:
        phrases.extend(_extract_phase_signal_fragments(step.label))
        if step.description:
            phrases.extend(_extract_phase_signal_fragments(step.description))
    deduped: list[str] = []
    for phrase in phrases:
        if phrase not in deduped:
            deduped.append(phrase)
    return deduped


def _phase_fact_texts(
    *,
    current_snapshot: dict[str, Any] | None,
    current_url: str,
    current_title: str,
    known_variables: dict[str, Any] | None,
    completed_phase_evidence: dict[str, list[str]] | None,
    recent_action_log: list[dict[str, Any]] | None,
    current_runtime_action: dict[str, Any] | None,
    status_summary: str | None,
) -> tuple[str, str]:
    page_parts: list[str] = [current_url, current_title]
    if isinstance(current_snapshot, dict):
        page_parts.extend(
            [
                str(current_snapshot.get("snapshot", "") or ""),
                str(current_snapshot.get("url", "") or ""),
                str(current_snapshot.get("title", "") or ""),
            ]
        )
    if isinstance(known_variables, dict):
        page_parts.extend(
            str(value)
            for value in known_variables.values()
            if value not in (None, "", [], {})
        )
    if isinstance(completed_phase_evidence, dict):
        for evidence_list in completed_phase_evidence.values():
            if isinstance(evidence_list, list):
                page_parts.extend(str(item) for item in evidence_list if item not in (None, "", [], {}))

    execution_parts: list[str] = []
    if isinstance(recent_action_log, list):
        for entry in recent_action_log:
            if not isinstance(entry, dict):
                continue
            execution_parts.extend(
                [
                    str(entry.get("label", "") or ""),
                    str(entry.get("message", "") or ""),
                    str(entry.get("command", "") or ""),
                    str(entry.get("value", "") or ""),
                    str(entry.get("page_ref", "") or ""),
                ]
            )
    if isinstance(current_runtime_action, dict):
        execution_parts.extend(
            [
                str(current_runtime_action.get("label", "") or ""),
                str(current_runtime_action.get("message", "") or ""),
                str(current_runtime_action.get("command", "") or ""),
                str(current_runtime_action.get("value", "") or ""),
                str(current_runtime_action.get("page_ref", "") or ""),
            ]
        )
    if status_summary:
        execution_parts.append(status_summary)

    return _normalize_evidence_text(" ".join(page_parts)), _normalize_evidence_text(" ".join(execution_parts))


def _match_phase_signals(signals: list[str], haystack: str) -> list[str]:
    if not haystack:
        return []
    matches: list[str] = []
    for signal in signals:
        normalized = _normalize_evidence_text(signal)
        if len(normalized) < 2:
            continue
        pattern = re.compile(rf"(?<![a-z0-9]){re.escape(normalized)}(?![a-z0-9])")
        if pattern.search(haystack) and normalized not in matches:
            matches.append(normalized)
    return matches


def _infer_direct_phase_facts(
    *,
    phase_index: int,
    label: str,
    checks: list[str],
    phase_steps: list[AutomationStep],
    page_haystack: str,
    execution_haystack: str,
) -> list[str]:
    evidence: list[str] = []
    if phase_steps and all(step.status in {"completed", "skipped"} for step in phase_steps):
        evidence.append("steps_completed")

    execution_signals = _phase_signal_phrases(label=label, checks=[], phase_steps=phase_steps)
    page_signals = _phase_signal_phrases(label=label, checks=checks, phase_steps=phase_steps)
    execution_matches = _match_phase_signals(execution_signals, execution_haystack)
    page_matches = _match_phase_signals(page_signals, page_haystack)
    normalized_checks = [signal for signal in (_normalize_evidence_text(item) for item in checks) if signal]
    label_haystack = _normalize_evidence_text(label)
    terminal_action_phase = any(
        marker in label_haystack
        for marker in (
            "send",
            "submit",
            "post",
            "publish",
            "confirm",
            "save",
            "place order",
            "checkout",
            "pay",
        )
    )
    allow_page_only_completion = not terminal_action_phase or _looks_like_explicit_runtime_completion_text(
        page_haystack
    )
    page_evidence_matches = (
        [f"page:{signal}" for signal in normalized_checks]
        if allow_page_only_completion and normalized_checks and all(signal in page_haystack for signal in normalized_checks)
        else [f"page:{signal}" for signal in page_matches] if page_matches and not normalized_checks else []
    )

    for signal in execution_matches:
        evidence.append(f"action:{signal}")
    for signal in page_evidence_matches:
        if signal not in evidence:
            evidence.append(signal)

    if not evidence and phase_index == 0 and page_haystack:
        for signal in checks:
            normalized = _normalize_evidence_text(signal)
            if normalized and normalized in page_haystack:
                evidence.append(f"page:{normalized}")
    return evidence


def _explicit_phase_facts(direct_evidence: list[str]) -> list[str]:
    explicit: list[str] = []
    for item in direct_evidence:
        normalized = str(item or "").strip()
        if not normalized:
            continue
        if normalized == "steps_completed" or normalized.startswith("action:"):
            explicit.append(normalized)
    return explicit


def _phase_running_status(phase_steps: list[AutomationStep], active_evidence: list[str]) -> str | None:
    if any(step.status == "failed" for step in phase_steps):
        return "blocked"
    if any(step.status == "running" for step in phase_steps):
        return "active"
    if active_evidence:
        return "active"
    return None


def _reconcile_phase_states(
    *,
    phase_labels: list[str],
    direct_phase_evidence: list[list[str]],
    explicit_phase_evidence: list[list[str]],
    active_phase_evidence: list[list[str]],
    step_statuses: list[str | None],
    fallback_active_phase_index: int | None,
    run_state: str | None,
) -> tuple[int | None, list[str]]:
    statuses = ["pending" for _ in phase_labels]
    run_state_normalized = str(run_state or "").strip().lower()
    terminal_success = run_state_normalized in {"completed", "succeeded"}
    terminal_failure = run_state_normalized in {"failed", "timed_out", "cancelled", "canceled", "expired"}

    if terminal_success:
        return None, ["completed" for _ in phase_labels]

    contiguous_completed = 0
    for evidence in direct_phase_evidence:
        if evidence:
            contiguous_completed += 1
            continue
        break

    highest_direct_completed = max((index for index, evidence in enumerate(direct_phase_evidence) if evidence), default=-1)
    highest_explicit_completed = max((index for index, evidence in enumerate(explicit_phase_evidence) if evidence), default=-1)
    explicit_contiguous_completed = 0
    for evidence in explicit_phase_evidence:
        if evidence:
            explicit_contiguous_completed += 1
            continue
        break
    completed_prefix = highest_direct_completed + 1 if terminal_success and highest_direct_completed >= 0 else contiguous_completed
    if terminal_failure:
        completed_prefix = highest_explicit_completed + 1 if highest_explicit_completed >= 0 else explicit_contiguous_completed

    for index in range(min(completed_prefix, len(statuses))):
        statuses[index] = "completed"

    blocked_index = next((index for index, status in enumerate(step_statuses) if status == "blocked"), None)
    active_index = next((index for index, status in enumerate(step_statuses) if status == "active"), None)

    if blocked_index is not None and blocked_index >= completed_prefix:
        statuses[blocked_index] = "blocked"
        active_phase_index = blocked_index
    else:
        candidate_active = active_index
        if candidate_active is None and fallback_active_phase_index is not None and fallback_active_phase_index >= completed_prefix:
            candidate_active = fallback_active_phase_index
        if candidate_active is None:
            candidate_active = next(
                (index for index, evidence in enumerate(active_phase_evidence) if evidence and index >= completed_prefix),
                None,
            )
        if candidate_active is None and not terminal_success and completed_prefix < len(statuses):
            candidate_active = completed_prefix
        if candidate_active is not None and candidate_active < len(statuses):
            statuses[candidate_active] = "active"
            active_phase_index = candidate_active
        else:
            active_phase_index = None

    if terminal_failure and active_phase_index is not None and statuses[active_phase_index] == "active":
        statuses[active_phase_index] = "blocked"

    if terminal_success:
        for index in range(completed_prefix, len(statuses)):
            if statuses[index] in {"active", "blocked"}:
                break
            if direct_phase_evidence[index]:
                statuses[index] = "completed"
                active_phase_index = None
            else:
                break

    if active_phase_index is not None:
        for index in range(active_phase_index + 1, len(statuses)):
            if statuses[index] == "completed":
                statuses[index] = "pending"

    if active_phase_index is None and terminal_success and statuses:
        for index, status in enumerate(statuses):
            if status != "completed":
                statuses[index] = "completed"
        active_phase_index = None

    return active_phase_index, statuses


def _compute_phase_states(
    plan: AutomationPlan,
    *,
    fallback_active_phase_index: int | None = None,
    current_snapshot: dict[str, Any] | None = None,
    current_url: str = "",
    current_title: str = "",
    known_variables: dict[str, Any] | None = None,
    completed_phase_evidence: dict[str, list[str]] | None = None,
    recent_action_log: list[dict[str, Any]] | None = None,
    current_runtime_action: dict[str, Any] | None = None,
    status_summary: str | None = None,
    run_state: str | None = None,
) -> tuple[int | None, list[ExecutionPhaseState], dict[str, list[str]]]:
    phase_labels = _phase_labels_for_plan(plan)
    if not phase_labels:
        return None, [], {}
    phase_checks: list[list[str]] = []
    if plan.predicted_plan and plan.predicted_plan.phases:
        phase_checks = [list(phase.completion_signals) for phase in plan.predicted_plan.phases]
    phase_states: list[ExecutionPhaseState] = []
    page_haystack, execution_haystack = _phase_fact_texts(
        current_snapshot=current_snapshot,
        current_url=current_url,
        current_title=current_title,
        known_variables=known_variables,
        completed_phase_evidence=completed_phase_evidence,
        recent_action_log=recent_action_log,
        current_runtime_action=current_runtime_action,
        status_summary=status_summary,
    )
    direct_phase_evidence: list[list[str]] = []
    active_phase_evidence: list[list[str]] = []
    phase_fact_evidence: dict[str, list[str]] = {}
    step_statuses: list[str | None] = []
    explicit_phase_evidence: list[list[str]] = []
    for index, label in enumerate(phase_labels):
        phase_steps = [step for step in plan.steps if step.phase_index == index]
        checks = [str(item).strip().lower() for item in (phase_checks[index] if index < len(phase_checks) else []) if str(item).strip()]
        direct_evidence = _infer_direct_phase_facts(
            phase_index=index,
            label=label,
            checks=checks,
            phase_steps=phase_steps,
            page_haystack=page_haystack,
            execution_haystack=execution_haystack,
        )
        active_evidence = _match_phase_signals(
            _phase_signal_phrases(label=label, checks=checks, phase_steps=phase_steps),
            execution_haystack,
        ) if current_runtime_action else []
        explicit_evidence = _explicit_phase_facts(direct_evidence)
        direct_phase_evidence.append(direct_evidence)
        explicit_phase_evidence.append(explicit_evidence)
        active_phase_evidence.append(active_evidence)
        step_statuses.append(_phase_running_status(phase_steps, active_evidence))
        if direct_evidence:
            stored_evidence = list(
                explicit_evidence if str(run_state or "").strip().lower() in {"failed", "timed_out", "cancelled", "canceled", "expired"} else direct_evidence
            )
            if stored_evidence:
                phase_fact_evidence[str(index)] = stored_evidence

    active_phase_index, reconciled_statuses = _reconcile_phase_states(
        phase_labels=phase_labels,
        direct_phase_evidence=direct_phase_evidence,
        explicit_phase_evidence=explicit_phase_evidence,
        active_phase_evidence=active_phase_evidence,
        step_statuses=step_statuses,
        fallback_active_phase_index=fallback_active_phase_index,
        run_state=run_state,
    )

    for index, label in enumerate(phase_labels):
        phase_states.append(
            ExecutionPhaseState(
                phase_index=index,
                label=label,
                status=cast(Any, reconciled_statuses[index]),
                last_updated_at=_now_iso(),
            )
        )

    return active_phase_index, phase_states, phase_fact_evidence


async def _sync_run_phase_progress(
    *,
    run_id: str,
    plan: AutomationPlan,
    fallback_active_phase_index: int | None = None,
    current_snapshot: dict[str, Any] | None = None,
    current_url: str = "",
    current_title: str = "",
    known_variables: dict[str, Any] | None = None,
) -> tuple[int | None, list[ExecutionPhaseState]]:
    existing_progress: dict[str, Any] = {}
    raw_run = await get_run(run_id)
    if raw_run and isinstance(raw_run.get("execution_progress", {}), dict):
        existing_progress = dict(raw_run.get("execution_progress", {}) or {})
    active_phase_index, phase_states, phase_fact_evidence = _compute_phase_states(
        plan,
        fallback_active_phase_index=fallback_active_phase_index,
        current_snapshot=current_snapshot,
        current_url=current_url,
        current_title=current_title,
        known_variables=known_variables,
        completed_phase_evidence=cast(dict[str, list[str]], existing_progress.get("completed_phase_evidence", {}) or {}),
        recent_action_log=cast(list[dict[str, Any]], existing_progress.get("recent_action_log", []) or []),
        current_runtime_action=cast(dict[str, Any] | None, existing_progress.get("current_runtime_action")),
        status_summary=str(existing_progress.get("status_summary", "") or "") or None,
        run_state=str((raw_run or {}).get("state", "") or "") or None,
    )
    phase_rows = [phase.model_dump(mode="json") for phase in phase_states]
    existing_progress["predicted_phases"] = phase_rows
    existing_progress["reconciled_phases"] = phase_rows
    existing_progress["active_phase_index"] = active_phase_index
    existing_progress["phase_fact_evidence"] = phase_fact_evidence
    await update_run(
        run_id,
        {
            "active_phase_index": active_phase_index,
            "phase_states": phase_rows,
            "execution_progress": ExecutionProgress.model_validate(existing_progress).model_dump(mode="json"),
            "updated_at": _now_iso(),
        },
    )
    return active_phase_index, phase_states


def _browser_steps_from_automation_steps(steps: list[AutomationStep]) -> list[dict[str, Any]]:
    browser_steps: list[dict[str, Any]] = []
    for step in steps:
        payload = step.normalized_command_payload().model_dump(mode="json", exclude_none=True)
        payload.setdefault("type", "browser")
        payload.setdefault("id", step.step_id)
        payload.setdefault(
            "description",
            step.description or step.label or str(payload.get("command") or "").strip(),
        )
        if step.page_ref and "page_ref" not in payload:
            payload["page_ref"] = step.page_ref
        browser_steps.append(payload)
    return browser_steps


async def _playwright_import() -> Any:
    try:
        from playwright.async_api import async_playwright
    except Exception as exc:  # pragma: no cover - depends on local env
        raise RuntimeError("Playwright is not installed for browser session execution.") from exc
    return async_playwright


def _data_url_from_png_bytes(payload: bytes) -> str:
    encoded = base64.b64encode(payload).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _slugify_page_token(value: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "_" for ch in str(value or ""))
    collapsed = "_".join(part for part in cleaned.split("_") if part)
    return collapsed[:40] or "tab"


def _next_dynamic_page_ref(page_registry: dict[str, dict[str, Any]], title: str, url: str) -> str:
    token = _slugify_page_token(title or url)
    base = f"page_{token}"
    if base not in page_registry:
        return base
    index = 2
    while f"{base}_{index}" in page_registry:
        index += 1
    return f"{base}_{index}"


def _classify_page_opened_incident(
    *,
    page: dict[str, Any],
    active_page_ref: str | None,
) -> RuntimeIncident | None:
    return None


def _screenshot_hash(screenshot_url: str) -> str | None:
    value = str(screenshot_url or "").strip()
    if not value:
        return None
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:16]


def _pages_from_registry(page_registry: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []
    for page_ref, entry in page_registry.items():
        if not isinstance(entry, dict):
            continue
        pages.append(
            {
                "page_ref": page_ref,
                "url": str(entry.get("url", "") or "") or None,
                "title": str(entry.get("title", "") or "") or None,
                "last_seen_at": str(entry.get("last_seen_at", "") or "") or None,
                "auto_detected": bool(entry.get("auto_detected", False)),
            }
        )
    pages.sort(key=lambda row: str(row.get("page_ref", "") or ""))
    return pages


def _snapshot_signature(snapshot: dict[str, Any] | None) -> str:
    if not isinstance(snapshot, dict):
        return ""
    return hashlib.sha1(
        "||".join(
            [
                str(snapshot.get("origin", "") or snapshot.get("url", "") or ""),
                str(snapshot.get("title", "") or ""),
                str(snapshot.get("snapshot", "") or "")[:5000],
            ]
        ).encode("utf-8")
    ).hexdigest()[:16]


def _build_browser_observation(
    *,
    snapshot: dict[str, Any] | None,
    snapshot_id: str,
    screenshot_url: str,
    page_registry: dict[str, dict[str, Any]],
    active_page_ref: str | None,
    title: str,
) -> BrowserStateSnapshot:
    current_url = str((snapshot or {}).get("origin", "") or (snapshot or {}).get("url", "") or "")
    current_title = title or str((snapshot or {}).get("title", "") or "")
    metadata: dict[str, Any] = {
        "page_ref": active_page_ref,
        "snapshot_id": snapshot_id,
        "ref_count": _count_snapshot_refs(snapshot),
        "snapshot_signature": _snapshot_signature(snapshot),
        "snapshot_format": str((snapshot or {}).get("snapshotFormat", "") or "ai"),
        "scope_selector": str((snapshot or {}).get("scopeSelector", "") or ""),
        "frame": str((snapshot or {}).get("frame", "") or ""),
        "target_id": str((snapshot or {}).get("targetId", "") or active_page_ref or ""),
    }
    if page_registry:
        metadata["page_registry"] = copy.deepcopy(page_registry)
    return BrowserStateSnapshot(
        captured_at=_now_iso(),
        url=current_url or None,
        title=current_title or None,
        page_id=active_page_ref,
        screenshot_url=screenshot_url or None,
        pages=_pages_from_registry(page_registry),
        metadata=metadata,
    )


def _normalize_observation_context(
    *,
    snapshot_format: str | None = None,
    scope_selector: str | None = None,
    frame: str | None = None,
    target_id: str | None = None,
) -> dict[str, str]:
    context = {
        "snapshotFormat": str(snapshot_format or "ai").strip().lower() or "ai",
        "scopeSelector": str(scope_selector or "").strip(),
        "frame": str(frame or "").strip(),
        "targetId": str(target_id or "").strip(),
    }
    return context


def _observation_context_from_snapshot(snapshot: dict[str, Any] | None, *, fallback_target_id: str | None = None) -> dict[str, str]:
    if not isinstance(snapshot, dict):
        return _normalize_observation_context(target_id=fallback_target_id)
    return _normalize_observation_context(
        snapshot_format=str(snapshot.get("snapshotFormat", "") or "ai"),
        scope_selector=str(snapshot.get("scopeSelector", "") or ""),
        frame=str(snapshot.get("frame", "") or ""),
        target_id=str(snapshot.get("targetId", "") or fallback_target_id or ""),
    )


def _merge_observation_context(
    base: dict[str, str] | None,
    *,
    snapshot_format: str | None = None,
    scope_selector: str | None = None,
    frame: str | None = None,
    target_id: str | None = None,
) -> dict[str, str]:
    merged = _normalize_observation_context(
        snapshot_format=(base or {}).get("snapshotFormat", "ai"),
        scope_selector=(base or {}).get("scopeSelector", ""),
        frame=(base or {}).get("frame", ""),
        target_id=(base or {}).get("targetId", ""),
    )
    if snapshot_format is not None:
        merged["snapshotFormat"] = str(snapshot_format or "ai").strip().lower() or "ai"
    if scope_selector is not None:
        merged["scopeSelector"] = str(scope_selector or "").strip()
    if frame is not None:
        merged["frame"] = str(frame or "").strip()
    if target_id is not None:
        merged["targetId"] = str(target_id or "").strip()
    return merged


def _candidate_executor_observation_contexts(
    *,
    failed_step: dict[str, Any],
    current_context: dict[str, str] | None,
    visual_structured_context: dict[str, Any] | None,
) -> list[dict[str, str]]:
    base = _merge_observation_context(current_context or {}, target_id=(current_context or {}).get("targetId", ""))
    contexts: list[dict[str, str]] = []

    def add(context: dict[str, str]) -> None:
        normalized = _merge_observation_context(context)
        if normalized not in contexts:
            contexts.append(normalized)

    add(base)
    add(_merge_observation_context(base, snapshot_format="ai", scope_selector="", frame=""))
    add(_merge_observation_context(base, snapshot_format="role", scope_selector=base.get("scopeSelector", ""), frame=base.get("frame", "")))

    structured = visual_structured_context if isinstance(visual_structured_context, dict) else {}
    dialog_count = int(structured.get("dialogCount", 0) or 0) if isinstance(structured, dict) else 0
    overlay_count = int(structured.get("overlayCount", 0) or 0) if isinstance(structured, dict) else 0
    iframe_count = int(structured.get("iframeCount", 0) or 0) if isinstance(structured, dict) else 0
    failed_text = " ".join(
        [
            str(failed_step.get("description", "") or ""),
            str(failed_step.get("command", "") or failed_step.get("action", "") or ""),
            str(failed_step.get("target", "") or ""),
        ]
    ).lower()

    if dialog_count > 0 or overlay_count > 0 or any(token in failed_text for token in ("dialog", "modal", "popup", "drawer", "compose")):
        scope = (
            '[role="dialog"]:has(:focus), [aria-modal="true"]:has(:focus), dialog:has(:focus), '
            '[role="dialog"]:has(input, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]), '
            '[aria-modal="true"]:has(input, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]), '
            'dialog:has(input, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]), '
            '.modal:has(:focus), [class*="modal"]:has(:focus), .drawer:has(:focus), [class*="drawer"]:has(:focus), .popup:has(:focus), [class*="popup"]:has(:focus), '
            '[role="dialog"], [aria-modal="true"], dialog, .modal, [class*="modal"], .drawer, [class*="drawer"], .popup, [class*="popup"]'
        )
        add(_merge_observation_context(base, snapshot_format="ai", scope_selector=scope))
        add(_merge_observation_context(base, snapshot_format="role", scope_selector=scope))
        add(_merge_observation_context(base, snapshot_format="aria", scope_selector=scope))
    if any(token in failed_text for token in ("menu", "listbox", "dropdown", "options", "suggestion")):
        scope = '[role="listbox"], [role="menu"], [role="tree"], .menu, [class*="menu"], .popover, [class*="popover"], .dropdown, [class*="dropdown"]'
        add(_merge_observation_context(base, snapshot_format="ai", scope_selector=scope))
        add(_merge_observation_context(base, snapshot_format="role", scope_selector=scope))
        add(_merge_observation_context(base, snapshot_format="aria", scope_selector=scope))
    if iframe_count > 0:
        add(_merge_observation_context(base, snapshot_format="ai", frame="iframe"))
        add(_merge_observation_context(base, snapshot_format="role", frame="iframe"))
        add(_merge_observation_context(base, snapshot_format="aria", frame="iframe"))

    add(_merge_observation_context(base, snapshot_format="role", scope_selector="", frame=""))
    add(_merge_observation_context(base, snapshot_format="aria", scope_selector=base.get("scopeSelector", ""), frame=base.get("frame", "")))
    add(_merge_observation_context(base, snapshot_format="aria", scope_selector="", frame=""))
    return contexts


def _select_escalated_observation_context(
    *,
    step: AgentBrowserStep,
    current_context: dict[str, str] | None,
    structured_context: dict[str, Any] | None,
) -> dict[str, str] | None:
    target = step.target if isinstance(step.target, dict) else {}
    requested_context = _merge_observation_context(
        current_context or {},
        snapshot_format=str(target.get("snapshotFormat", "") or "").strip() if "snapshotFormat" in target else None,
        scope_selector=str(target.get("scopeSelector", "") or "").strip() if "scopeSelector" in target else None,
        frame=str(target.get("frame", "") or "").strip() if "frame" in target else None,
        target_id=str(target.get("targetId", "") or "").strip() if "targetId" in target else None,
    )
    candidates = _candidate_executor_observation_contexts(
        failed_step={
            "description": str(step.description or ""),
            "command": str(step.command or ""),
            "target": target,
        },
        current_context=requested_context,
        visual_structured_context=structured_context,
    )
    alternatives = [candidate for candidate in candidates if candidate != requested_context]
    if not alternatives:
        return None

    hint_text = " ".join(
        [
            str(step.description or ""),
            str(step.command or ""),
            json.dumps(target, ensure_ascii=True, sort_keys=True) if target else "",
        ]
    ).lower()
    prefers_scoped = any(token in hint_text for token in ("dialog", "modal", "popup", "drawer", "compose", "menu", "listbox", "dropdown", "suggestion"))
    requested_format = requested_context.get("snapshotFormat", "ai")
    requested_scope = requested_context.get("scopeSelector", "")
    requested_frame = requested_context.get("frame", "")

    if prefers_scoped:
        for candidate in alternatives:
            if candidate.get("scopeSelector", "") and candidate.get("scopeSelector", "") != requested_scope:
                if requested_format == "ai" and candidate.get("snapshotFormat") == "role":
                    return candidate
        for candidate in alternatives:
            if candidate.get("scopeSelector", "") and candidate.get("scopeSelector", "") != requested_scope:
                return candidate

    if requested_format == "ai":
        for candidate in alternatives:
            if candidate.get("snapshotFormat") == "role" and candidate.get("scopeSelector", "") == requested_scope:
                return candidate
    if requested_format in {"ai", "role"}:
        for candidate in alternatives:
            if candidate.get("snapshotFormat") == "aria" and candidate.get("scopeSelector", "") == requested_scope:
                return candidate

    structured = structured_context if isinstance(structured_context, dict) else {}
    iframe_count = int(structured.get("iframeCount", 0) or 0) if isinstance(structured, dict) else 0
    if iframe_count > 0 and not requested_frame:
        for candidate in alternatives:
            if candidate.get("frame", ""):
                return candidate

    return alternatives[0]


def _maybe_escalate_observation_runtime_action(
    *,
    action_plan: RuntimeActionPlan,
    current_snapshot: dict[str, Any] | None,
    current_observation_context: dict[str, str] | None,
    structured_context: dict[str, Any] | None,
) -> RuntimeActionPlan:
    if action_plan.status != "action" or action_plan.step is None:
        return action_plan
    step = action_plan.step
    if str(step.command or "").strip().lower() not in {"snapshot", "screenshot"}:
        return action_plan
    if not isinstance(current_snapshot, dict):
        return action_plan
    if _count_snapshot_refs(current_snapshot) <= 0 and not isinstance(structured_context, dict):
        return action_plan

    target = step.target if isinstance(step.target, dict) else {}
    requested_context = _merge_observation_context(
        current_observation_context or {},
        snapshot_format=str(target.get("snapshotFormat", "") or "").strip() if "snapshotFormat" in target else None,
        scope_selector=str(target.get("scopeSelector", "") or "").strip() if "scopeSelector" in target else None,
        frame=str(target.get("frame", "") or "").strip() if "frame" in target else None,
        target_id=str(target.get("targetId", "") or "").strip() if "targetId" in target else None,
    )
    current_context = _merge_observation_context(
        current_observation_context or {},
        target_id=(current_observation_context or {}).get("targetId", ""),
    )
    if requested_context != current_context:
        return action_plan

    escalated_context = _select_escalated_observation_context(
        step=step,
        current_context=requested_context,
        structured_context=structured_context,
    )
    if escalated_context is None or escalated_context == requested_context:
        return action_plan

    next_target = {
        "snapshotFormat": escalated_context.get("snapshotFormat", "ai"),
        "observationMode": "interactive",
        "targetId": escalated_context.get("targetId", ""),
    }
    if escalated_context.get("scopeSelector", ""):
        next_target["scopeSelector"] = escalated_context["scopeSelector"]
    if escalated_context.get("frame", ""):
        next_target["frame"] = escalated_context["frame"]

    next_step = step.model_copy(update={"target": next_target})
    return action_plan.model_copy(update={"step": next_step})


def _single_step_browser_planning_enabled() -> bool:
    return bool(settings.automation_browser_single_step_planning)


def _planner_browser_step_limit() -> int | None:
    return 1 if _single_step_browser_planning_enabled() else None


def _tokenize_evidence_text(value: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9]{3,}", str(value or "").lower())
        if token not in {"button", "input", "link", "gmail", "mail", "page", "window"}
    }


def _snapshot_tokens(snapshot: dict[str, Any] | None) -> set[str]:
    if not isinstance(snapshot, dict):
        return set()
    refs = snapshot.get("refs", {})
    tokens: set[str] = set()
    if isinstance(refs, dict):
        for payload in list(refs.values())[:120]:
            if not isinstance(payload, dict):
                continue
            tokens |= _tokenize_evidence_text(str(payload.get("name", "") or ""))
            tokens |= _tokenize_evidence_text(str(payload.get("role", "") or ""))
    tokens |= _tokenize_evidence_text(str(snapshot.get("snapshot", "") or "")[:4000])
    return tokens


def _structured_tokens(structured_context: dict[str, Any] | None) -> set[str]:
    if not isinstance(structured_context, dict):
        return set()
    tokens: set[str] = set()
    for element in list(structured_context.get("elements", []) or [])[:120]:
        if not isinstance(element, dict):
            continue
        tokens |= _tokenize_evidence_text(str(element.get("text", "") or ""))
        tokens |= _tokenize_evidence_text(str(element.get("ariaLabel", "") or ""))
        tokens |= _tokenize_evidence_text(str(element.get("placeholder", "") or ""))
        tokens |= _tokenize_evidence_text(str(element.get("name", "") or ""))
        tokens |= _tokenize_evidence_text(str(element.get("role", "") or ""))
    active = structured_context.get("activeElement", {})
    if isinstance(active, dict):
        tokens |= _tokenize_evidence_text(str(active.get("ariaLabel", "") or ""))
        tokens |= _tokenize_evidence_text(str(active.get("placeholder", "") or ""))
        tokens |= _tokenize_evidence_text(str(active.get("role", "") or ""))
        tokens |= _tokenize_evidence_text(str(active.get("tag", "") or ""))
    return tokens


def _compute_evidence_quality(
    *,
    snapshot: dict[str, Any] | None,
    structured_context: dict[str, Any] | None,
    screenshot_basis: ScreenshotBasis | None,
) -> EvidenceQualityScores:
    ref_count = _count_snapshot_refs(snapshot)
    dom_confidence = min(1.0, ref_count / 40.0)
    visual_confidence = 0.0
    if screenshot_basis is not None and screenshot_basis.screenshot_id:
        visual_confidence = 0.55
        if isinstance(structured_context, dict) and list(structured_context.get("elements", []) or []):
            visual_confidence += 0.2
        active = structured_context.get("activeElement", {}) if isinstance(structured_context, dict) else {}
        if isinstance(active, dict) and bool(active.get("editable")):
            visual_confidence += 0.15
        visual_confidence = min(1.0, visual_confidence)

    snapshot_tokens = _snapshot_tokens(snapshot)
    structured_tokens = _structured_tokens(structured_context)
    if not snapshot_tokens or not structured_tokens:
        agreement_score = 0.0
    else:
        overlap = len(snapshot_tokens & structured_tokens)
        union = max(1, len(snapshot_tokens | structured_tokens))
        agreement_score = max(0.0, min(1.0, overlap / union))
    return EvidenceQualityScores(
        dom_confidence=round(dom_confidence, 3),
        visual_confidence=round(visual_confidence, 3),
        agreement_score=round(agreement_score, 3),
    )


def _build_unified_evidence_bundle(
    *,
    current_url: str,
    current_title: str,
    active_page_ref: str | None,
    snapshot: dict[str, Any] | None,
    snapshot_id: str,
    screenshot_basis: ScreenshotBasis | None,
    structured_context: dict[str, Any] | None,
    completed_steps: list[str] | None,
    last_verification_result: str = "",
) -> UnifiedEvidenceBundle:
    quality = _compute_evidence_quality(
        snapshot=snapshot,
        structured_context=structured_context,
        screenshot_basis=screenshot_basis,
    )
    return UnifiedEvidenceBundle(
        current_url=current_url,
        current_title=current_title,
        active_page_ref=active_page_ref,
        snapshot_id=snapshot_id,
        snapshot_ref_count=_count_snapshot_refs(snapshot),
        page_snapshot=snapshot,
        screenshot=str(screenshot_basis.screenshot if screenshot_basis else ""),
        screenshot_id=str(screenshot_basis.screenshot_id if screenshot_basis else ""),
        viewport_width=int(screenshot_basis.viewport_width if screenshot_basis else 0),
        viewport_height=int(screenshot_basis.viewport_height if screenshot_basis else 0),
        device_pixel_ratio=float(screenshot_basis.device_pixel_ratio if screenshot_basis else 1.0),
        structured_context=structured_context,
        recent_completed_actions=list(completed_steps or []),
        last_verification_result=last_verification_result,
        evidence_quality=quality,
    )


def _select_execution_mode(evidence: UnifiedEvidenceBundle) -> ExecutionModeDecision:
    quality = evidence.evidence_quality
    if quality.dom_confidence >= 0.25:
        return ExecutionModeDecision(
            mode="ref",
            reason="Snapshot refs are sufficiently strong for DOM-first execution.",
            evidence_quality=quality,
        )
    if quality.visual_confidence >= 0.55:
        return ExecutionModeDecision(
            mode="visual",
            reason="Visual evidence is available while DOM evidence is weak.",
            evidence_quality=quality,
        )
    return ExecutionModeDecision(
        mode="manual",
        reason="Neither DOM nor visual evidence is reliable enough for safe automatic execution.",
        evidence_quality=quality,
    )


def _should_prefer_visual_next_step(
    *,
    evidence: UnifiedEvidenceBundle,
) -> bool:
    return _select_execution_mode(evidence).mode == "visual"


async def _plan_next_runtime_action(
    *,
    planning_prompt: str,
    plan: AutomationPlan,
    run: AutomationRun,
    current_url: str,
    current_title: str,
    page_snapshot: dict[str, Any] | None,
    structured_context: dict[str, Any] | None,
    screenshot: str = "",
    evidence_bundle: UnifiedEvidenceBundle | None = None,
    completed_steps: list[str] | None = None,
    failed_step: dict[str, Any] | None = None,
    error_message: str | None = None,
) -> tuple[RuntimeActionPlan, str]:
    playbook_context = build_playbook_context(
        prompt=plan.summary,
        current_url=current_url,
    )
    action_plan = await plan_runtime_action(
        execution_contract=_planner_execution_contract_payload(
            plan,
            run,
            completed_count=len(completed_steps or []),
        ) or {},
        user_prompt=planning_prompt,
        current_url=current_url,
        current_page_title=current_title,
        page_snapshot=page_snapshot,
        structured_context=structured_context,
        playbook_context=playbook_context,
        completed_steps=completed_steps,
        failed_step=failed_step,
        error_message=error_message,
        model_override=plan.model_id,
        max_browser_steps=_planner_browser_step_limit(),
        screenshot=screenshot,
        evidence_bundle=evidence_bundle.model_dump(mode="json") if evidence_bundle is not None else None,
    )
    return action_plan, playbook_context


def _runtime_block_target_state(action_plan: RuntimeActionPlan) -> str:
    block = action_plan.block
    if block is None:
        return "failed"
    if block.requires_confirmation:
        return "waiting_for_human"
    if block.requires_user_reply:
        return "waiting_for_user_action"
    return "failed"


async def _apply_runtime_action_plan(
    *,
    action_plan: RuntimeActionPlan,
    run_id: str,
    user_id: str,
    session_id: str,
    plan: AutomationPlan,
    current_url: str,
    completed_steps: int = 0,
) -> tuple[list[dict[str, Any]] | None, bool]:
    if action_plan.status == "completed":
        await _complete_run_from_planner(
            run_id=run_id,
            user_id=user_id,
            session_id=session_id,
            plan=plan,
            completed_steps=completed_steps,
            completion_message=action_plan.summary or "The task completed successfully.",
        )
        return None, True

    if action_plan.status == "blocked":
        block = action_plan.block
        assert block is not None
        target_state = _runtime_block_target_state(action_plan)
        error = RunError(
            code=str(block.reason_code or "RUNTIME_BLOCKED"),
            message=block.message,
            retryable=block.retriable,
        )
        interruption_payload = {
            "reason": block.reason,
            "reason_code": block.reason_code or block.reason,
            "message": block.message,
            "requires_user_reply": block.requires_user_reply,
            "requires_confirmation": block.requires_confirmation,
            "retriable": block.retriable,
            "halt_kind": block.halt_kind,
            "policy_source": block.policy_source,
            "verification_status": block.verification_status,
        }
        raw_run = await get_run(run_id)
        current_progress = {}
        if raw_run and isinstance(raw_run.get("execution_progress", {}), dict):
            current_progress = dict(raw_run.get("execution_progress", {}) or {})
        current_progress["interruption"] = interruption_payload
        current_progress["current_runtime_action"] = None
        current_progress["status_summary"] = block.message
        await update_run(
            run_id,
            {
                "execution_progress": current_progress,
                "updated_at": _now_iso(),
            },
        )
        await _set_run_state(run_id, target_state, error)
        await _publish_run_activity(
            user_id=user_id,
            session_id=session_id,
            run_id=run_id,
            summary=block.message,
            tone="warning" if target_state == "waiting_for_human" else "danger",
        )
        event_type = "run.waiting_for_human" if target_state == "waiting_for_human" else "run.runtime_blocked"
        await publish_event(
            user_id=user_id,
            session_id=session_id,
            run_id=run_id,
            event_type=event_type,
            payload={
                "run_id": run_id,
                "reason": block.message,
                "reason_code": block.reason_code or block.reason,
                "url": current_url or None,
                "requires_confirmation": block.requires_confirmation,
                "requires_user_reply": block.requires_user_reply,
                "retriable": block.retriable,
            },
        )
        return None, True

    if action_plan.step is None:
        fallback = RuntimeActionPlan(
            status="blocked",
            summary="The planner could not produce a valid next action.",
            block=RuntimeBlock(
                reason="planner_failed",
                reason_code="planner_failed",
                message="The planner could not produce a valid next action.",
                requires_user_reply=False,
                requires_confirmation=False,
                retriable=True,
            ),
            preferred_execution_mode="ref",
        )
        return await _apply_runtime_action_plan(
            action_plan=fallback,
            run_id=run_id,
            user_id=user_id,
            session_id=session_id,
            plan=plan,
            current_url=current_url,
            completed_steps=completed_steps,
        )
    return [action_plan.step.model_dump(mode="json", exclude_none=True)], False


async def _capture_browser_observation(
    *,
    session_name: str,
    page_registry: dict[str, dict[str, Any]],
    active_page_ref: str | None,
    screenshot_url: str = "",
    observation_context: dict[str, str] | None = None,
) -> tuple[BrowserStateSnapshot, dict[str, Any], str]:
    normalized_context = _merge_observation_context(
        observation_context or {},
        target_id=(observation_context or {}).get("targetId", active_page_ref or ""),
    )
    snapshot, snapshot_id = await _capture_agent_browser_snapshot(
        session_name=session_name,
        page_registry=page_registry,
        active_page_ref=active_page_ref,
        snapshot_format=normalized_context.get("snapshotFormat", "ai"),
        scope_selector=normalized_context.get("scopeSelector", "") or None,
        frame=normalized_context.get("frame", "") or None,
    )
    title_result = await _run_node_json_command(
        args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", "get", "title"]
    )
    observation = _build_browser_observation(
        snapshot=snapshot,
        snapshot_id=snapshot_id,
        screenshot_url=screenshot_url,
        page_registry=page_registry,
        active_page_ref=active_page_ref,
        title=str(title_result.get("title", "") or ""),
    )
    return observation, snapshot, snapshot_id


def _observation_identity(observation: BrowserStateSnapshot | None) -> tuple[str, str, str]:
    if observation is None:
        return "", "", ""
    metadata = observation.metadata if isinstance(observation.metadata, dict) else {}
    return (
        str(observation.url or ""),
        str(observation.title or ""),
        str(metadata.get("snapshot_signature", "") or metadata.get("snapshot_id", "") or ""),
    )


def _needs_replan_after_observation(
    *,
    previous_observation: BrowserStateSnapshot | None,
    current_observation: BrowserStateSnapshot | None,
    remaining_steps: list[dict[str, Any]],
) -> list[str]:
    if not remaining_steps or current_observation is None:
        return []
    reasons: list[str] = []
    if _observation_identity(previous_observation) != _observation_identity(current_observation):
        reasons.append("observed_state_changed")
    if any(_step_target_uses_ref(step.get("target")) for step in remaining_steps[:3] if isinstance(step, dict)):
        reasons.append("remaining_plan_uses_ref")
    if any(
        _is_interactive_command(str(step.get("command", "") or "").strip().lower())
        for step in remaining_steps[:2]
        if isinstance(step, dict)
    ):
        reasons.append("remaining_plan_interactive")
    # Deduplicate while preserving order for logging/event payloads.
    deduped: list[str] = []
    for reason in reasons:
        if reason not in deduped:
            deduped.append(reason)
    return deduped


def _should_attempt_failure_observation_recovery(
    *,
    step: dict[str, Any],
    error_message: str,
    incident: RuntimeIncident | None,
) -> bool:
    command = str(step.get("command", "") or step.get("action", "") or "").strip().lower()
    if command not in {"click", "type", "hover", "select", "snapshot", "frame"}:
        return False
    error_code = _classify_step_error_code(error_message)
    if error_code in {"ELEMENT_NOT_FOUND", "ELEMENT_AMBIGUOUS", "PAGE_CHANGED", "TIMEOUT", "TARGET_ACTION_INCOMPATIBLE"}:
        return True
    if incident is not None and incident.replannable and incident.code in {
        "RUNTIME_FRAME_CONTEXT_LOST",
        "RUNTIME_OVERLAY_BLOCKER",
        "RUNTIME_NAVIGATION_MISMATCH",
        "RUNTIME_UNSUPPORTED_WIDGET",
    }:
        return True
    return False


def _track_progress_and_detect_no_progress(
    *,
    tracker: dict[str, Any],
    screenshot_url: str,
    page_registry: dict[str, dict[str, Any]],
    active_page_ref: str | None,
) -> tuple[dict[str, Any], RuntimeIncident | None]:
    next_tracker = dict(tracker or {})
    active_page = dict(page_registry.get(active_page_ref or "", {}) or {})
    current_hash = _screenshot_hash(screenshot_url)
    current_url = str(active_page.get("url", "") or "")
    current_title = str(active_page.get("title", "") or "")
    last_hash = str(next_tracker.get("last_screenshot_hash", "") or "") or None
    last_url = str(next_tracker.get("last_url", "") or "") or None
    last_title = str(next_tracker.get("last_title", "") or "") or None
    repeated = int(next_tracker.get("repeated_screenshot_count", 0) or 0)

    if current_hash and current_hash == last_hash and current_url == (last_url or current_url) and current_title == (last_title or current_title):
        repeated += 1
    else:
        repeated = 0

    next_tracker.update(
        {
            "last_screenshot_hash": current_hash,
            "repeated_screenshot_count": repeated,
            "last_url": current_url or None,
            "last_title": current_title or None,
            "last_updated_at": _now_iso(),
        }
    )
    if repeated < 2:
        return next_tracker, None
    incident = RuntimeIncident(
        incident_id=str(uuid.uuid4()),
        category="blocker",
        severity="warning",
        code="RUNTIME_NO_PROGRESS",
        summary="The browser appears stuck in the same visual state across multiple steps.",
        details=f"The same page content was observed repeatedly on {current_title or current_url or 'the current page'}.",
        visible_signals=["same_screenshot_hash", "no_progress"],
        requires_human=False,
        replannable=True,
        user_visible=True,
        browser_snapshot=BrowserStateSnapshot(
            captured_at=_now_iso(),
            url=current_url or None,
            title=current_title or None,
            page_id=active_page_ref,
            screenshot_url=screenshot_url or None,
            metadata={"page_ref": active_page_ref} if active_page_ref else {},
        ),
        created_at=_now_iso(),
    )
    return next_tracker, incident


def _track_failure_progress_and_detect_repeated_failure(
    *,
    tracker: dict[str, Any],
    step_id: str,
    action: str,
    error_message: str,
    screenshot_url: str,
    page_registry: dict[str, dict[str, Any]],
    active_page_ref: str | None,
) -> tuple[dict[str, Any], RuntimeIncident | None]:
    next_tracker = dict(tracker or {})
    active_page = dict(page_registry.get(active_page_ref or "", {}) or {})
    current_signature = hashlib.sha1(f"{step_id}|{action}|{error_message.strip().lower()}".encode()).hexdigest()[:16]
    last_step_id = str(next_tracker.get("last_failed_step_id", "") or "") or None
    last_signature = str(next_tracker.get("last_failure_signature", "") or "") or None
    repeated = int(next_tracker.get("repeated_failed_step_count", 0) or 0)

    if last_step_id == step_id and last_signature == current_signature:
        repeated += 1
    else:
        repeated = 0

    next_tracker.update(
        {
            "last_failed_step_id": step_id,
            "last_failure_signature": current_signature,
            "repeated_failed_step_count": repeated,
            "last_updated_at": _now_iso(),
        }
    )
    if repeated < 1:
        return next_tracker, None
    current_url = str(active_page.get("url", "") or "")
    current_title = str(active_page.get("title", "") or "")
    incident = RuntimeIncident(
        incident_id=str(uuid.uuid4()),
        category="ambiguity",
        severity="warning",
        code="RUNTIME_REPEATED_STEP_FAILURE",
        summary="The same step has failed repeatedly without the page meaningfully changing.",
        details=error_message or f"Step {step_id} has repeated the same failure.",
        visible_signals=["repeated_step_failure", action, step_id],
        requires_human=False,
        replannable=True,
        user_visible=True,
        browser_snapshot=BrowserStateSnapshot(
            captured_at=_now_iso(),
            url=current_url or None,
            title=current_title or None,
            page_id=active_page_ref,
            screenshot_url=screenshot_url or None,
            metadata={"page_ref": active_page_ref, "step_id": step_id} if active_page_ref else {"step_id": step_id},
        ),
        created_at=_now_iso(),
    )
    return next_tracker, incident


async def _classify_runtime_failure_incident(
    *,
    step: dict[str, Any],
    semantic_step: AutomationStep | None,
    result: dict[str, Any],
    active_page_ref: str | None,
) -> RuntimeIncident | None:
    message = str(result.get("data", "") or "")
    screenshot = str(result.get("screenshot", "") or "")
    lowered = message.lower()
    page_ref = str(result.get("page_ref", "") or active_page_ref or "")

    if any(
        token in lowered
        for token in (
            "file chooser",
            "file picker",
            "upload a file",
            "select a file",
            "set_input_files",
            "input type=file",
            "no file selected",
        )
    ):
        return RuntimeIncident(
            incident_id=str(uuid.uuid4()),
            category="ambiguity",
            severity="critical",
            code="RUNTIME_FILE_UPLOAD_REQUIRED",
            summary="The workflow needs a file upload or file picker decision before it can continue.",
            details=message or None,
            visible_signals=["file_upload", str(step.get("command", "") or step.get("action", "") or "")],
            requires_human=False,
            replannable=True,
            user_visible=True,
            browser_snapshot=BrowserStateSnapshot(
                captured_at=_now_iso(),
                screenshot_url=screenshot or None,
                page_id=page_ref or None,
                metadata={"page_ref": page_ref} if page_ref else {},
            ),
            created_at=_now_iso(),
        )

    if any(
        token in lowered
        for token in (
            "download",
            "save file",
            "download prompt",
            "download dialog",
            "permission to download",
            "multiple files",
        )
    ):
        return RuntimeIncident(
            incident_id=str(uuid.uuid4()),
            category="permission",
            severity="warning",
            code="RUNTIME_DOWNLOAD_PROMPT",
            summary="A browser download prompt or permission gate interrupted the workflow.",
            details=message or None,
            visible_signals=["download_prompt", str(step.get("command", "") or step.get("action", "") or "")],
            requires_human=False,
            replannable=True,
            user_visible=True,
            browser_snapshot=BrowserStateSnapshot(
                captured_at=_now_iso(),
                screenshot_url=screenshot or None,
                page_id=page_ref or None,
                metadata={"page_ref": page_ref} if page_ref else {},
            ),
            created_at=_now_iso(),
        )

    if any(
        token in lowered
        for token in (
            "closed shadow root",
            "unsupported widget",
            "cannot pierce",
            "element inside closed shadow",
            "custom widget blocked interaction",
        )
    ):
        return RuntimeIncident(
            incident_id=str(uuid.uuid4()),
            category="unexpected_ui",
            severity="warning",
            code="RUNTIME_UNSUPPORTED_WIDGET",
            summary="The target UI is inside a widget or closed component boundary the agent cannot safely automate directly.",
            details=message or None,
            visible_signals=["unsupported_widget", str(step.get("command", "") or step.get("action", "") or "")],
            requires_human=False,
            replannable=True,
            user_visible=True,
            browser_snapshot=BrowserStateSnapshot(
                captured_at=_now_iso(),
                screenshot_url=screenshot or None,
                page_id=page_ref or None,
                metadata={"page_ref": page_ref} if page_ref else {},
            ),
            created_at=_now_iso(),
        )

    if any(token in lowered for token in ("iframe", "frame", "cross origin", "cross-origin", "frame detached", "frame was detached")):
        return RuntimeIncident(
            incident_id=str(uuid.uuid4()),
            category="navigation",
            severity="warning",
            code="RUNTIME_FRAME_CONTEXT_LOST",
            summary="The browser lost or switched frame context during automation.",
            details=message or None,
            visible_signals=["frame_context", str(step.get("command", "") or step.get("action", "") or "")],
            requires_human=False,
            replannable=True,
            user_visible=True,
            browser_snapshot=BrowserStateSnapshot(
                captured_at=_now_iso(),
                screenshot_url=screenshot or None,
                page_id=page_ref or None,
                metadata={"page_ref": page_ref} if page_ref else {},
            ),
            created_at=_now_iso(),
        )

    if any(token in lowered for token in ("intercepts pointer events", "another element would receive", "element is obscured", "blocked by overlay")):
        return RuntimeIncident(
            incident_id=str(uuid.uuid4()),
            category="blocker",
            severity="warning",
            code="RUNTIME_OVERLAY_BLOCKER",
            summary="A blocking overlay or modal is intercepting the automation.",
            details=message or None,
            visible_signals=["overlay", str(step.get("command", "") or step.get("action", "") or "")],
            requires_human=False,
            replannable=True,
            user_visible=True,
            browser_snapshot=BrowserStateSnapshot(
                captured_at=_now_iso(),
                screenshot_url=screenshot or None,
                page_id=page_ref or None,
                metadata={"page_ref": page_ref} if page_ref else {},
            ),
            created_at=_now_iso(),
        )

    expected_page_ref = semantic_step.page_ref if semantic_step else None
    actual_page_ref = str(result.get("page_ref", "") or active_page_ref or "") or None
    if expected_page_ref and actual_page_ref and expected_page_ref != actual_page_ref:
        return RuntimeIncident(
            incident_id=str(uuid.uuid4()),
            category="navigation",
            severity="warning",
            code="RUNTIME_NAVIGATION_MISMATCH",
            summary="The browser focus moved to a different tab or page than the plan expected.",
            details=f"Expected page_ref={expected_page_ref} but the step completed on page_ref={actual_page_ref}.",
            visible_signals=["page_ref_mismatch", str(step.get("command", "") or step.get("action", "") or "")],
            requires_human=False,
            replannable=True,
            user_visible=True,
            browser_snapshot=BrowserStateSnapshot(
                captured_at=_now_iso(),
                screenshot_url=screenshot or None,
                page_id=actual_page_ref,
                metadata={"expected_page_ref": expected_page_ref, "page_ref": actual_page_ref},
            ),
            created_at=_now_iso(),
        )

    return None


async def _browser_session_metadata(browser_session_id: str | None) -> dict[str, Any] | None:
    if not browser_session_id:
        return None
    return await get_browser_session(browser_session_id)


def _page_signature(url: str, title: str) -> str:
    return hashlib.sha1(f"{str(url or '').strip()}|{str(title or '').strip()}".encode("utf-8")).hexdigest()[:16]


def _rebuild_page_registry_from_session(
    *,
    session_row: dict[str, Any],
    existing_registry: dict[str, dict[str, Any]] | None,
    existing_active_page_ref: str | None,
) -> tuple[dict[str, dict[str, Any]], str | None]:
    pages = [page for page in list((session_row or {}).get("pages", []) or []) if isinstance(page, dict)]
    if not pages:
        return dict(existing_registry or {}), existing_active_page_ref

    registry = dict(existing_registry or {})
    refs_by_page_id: dict[str, str] = {}
    refs_by_signature: dict[str, str] = {}
    for page_ref, entry in registry.items():
        if not isinstance(entry, dict):
            continue
        entry_page_id = str(entry.get("page_id") or "").strip()
        if entry_page_id:
            refs_by_page_id[entry_page_id] = str(page_ref)
        signature = _page_signature(str(entry.get("url") or ""), str(entry.get("title") or ""))
        refs_by_signature[signature] = str(page_ref)

    used_refs: set[str] = set()
    next_dynamic_index = 0

    def allocate_ref() -> str:
        nonlocal next_dynamic_index
        while True:
            candidate = f"page_{next_dynamic_index}"
            next_dynamic_index += 1
            if candidate not in used_refs:
                return candidate

    refreshed_registry: dict[str, dict[str, Any]] = {}
    active_page_ref: str | None = None
    active_page_id = str((session_row or {}).get("page_id", "") or "").strip() or None

    for index, page in enumerate(pages):
        page_id = str(page.get("page_id") or "").strip()
        url = str(page.get("url") or "").strip()
        title = str(page.get("title") or "").strip()
        signature = _page_signature(url, title)
        page_ref = refs_by_page_id.get(page_id) if page_id else None
        if not page_ref:
            page_ref = refs_by_signature.get(signature)
        if not page_ref:
            page_ref = allocate_ref()
        used_refs.add(page_ref)
        refreshed_registry[page_ref] = {
            **dict(registry.get(page_ref, {}) or {}),
            "url": url,
            "title": title,
            "page_id": page_id or None,
            "tab_index": index,
            "is_active": bool(page.get("is_active", False)),
            "last_seen_at": _now_iso(),
        }
        if active_page_ref is None and (
            (active_page_id and page_id and page_id == active_page_id)
            or bool(page.get("is_active", False))
        ):
            active_page_ref = page_ref

    if active_page_ref is None and existing_active_page_ref and existing_active_page_ref in refreshed_registry:
        active_page_ref = existing_active_page_ref
    if active_page_ref is None and refreshed_registry:
        active_page_ref = next(iter(refreshed_registry.keys()))
    return refreshed_registry, active_page_ref


async def _refresh_run_browser_context_from_live_session(
    *,
    run_id: str,
    run: AutomationRun,
    session_row: dict[str, Any] | None = None,
) -> tuple[AutomationRun, dict[str, Any] | None]:
    session_meta = session_row or await _browser_session_metadata(run.browser_session_id)
    if not isinstance(session_meta, dict):
        return run, None
    refreshed_registry, refreshed_active_page_ref = _rebuild_page_registry_from_session(
        session_row=session_meta,
        existing_registry=dict(run.page_registry or {}),
        existing_active_page_ref=run.active_page_ref,
    )
    if (
        refreshed_registry == dict(run.page_registry or {})
        and (refreshed_active_page_ref or None) == (run.active_page_ref or None)
    ):
        return run, session_meta
    updated = await update_run(
        run_id,
        {
            "page_registry": refreshed_registry,
            "active_page_ref": refreshed_active_page_ref,
            "updated_at": _now_iso(),
        },
    )
    if updated is None:
        raise RuntimeError("Run not found while refreshing browser context.")
    logger.info(
        "automation_run_browser_context_refreshed",
        extra={
            "run_id": run_id,
            "session_id": run.session_id,
            "browser_session_id": run.browser_session_id,
            "page_count": len(refreshed_registry),
            "active_page_ref": refreshed_active_page_ref,
        },
    )
    return AutomationRun.model_validate(updated), session_meta


async def _resolve_fallback_browser_session(
    *,
    user_id: str,
    executor_mode: str | None,
) -> tuple[str | None, dict[str, Any] | None]:
    if executor_mode not in {"local_runner", "server_runner"}:
        return None, None

    from oi_agent.automation.sessions.manager import browser_session_manager

    expected_origin = "local_runner" if executor_mode == "local_runner" else "server_runner"
    sessions = await browser_session_manager.list_sessions(user_id=user_id)
    preferred: tuple[str, dict[str, Any]] | None = None
    fallback: tuple[str, dict[str, Any]] | None = None

    for session in sessions:
        if session.origin != expected_origin:
            continue
        session_meta = session.model_dump(mode="json")
        metadata = session_meta.get("metadata", {}) if isinstance(session_meta, dict) else {}
        cdp_url = str(metadata.get("cdp_url", "") or "") if isinstance(metadata, dict) else ""
        if not cdp_url:
            continue
        candidate = (str(session.session_id), session_meta)
        if session.status == "ready":
            return candidate
        if session.status == "busy" and preferred is None:
            preferred = candidate
        elif fallback is None:
            fallback = candidate

    return preferred or fallback or (None, None)


async def _connect_browser_session(cdp_url: str) -> tuple[Any, Any, Any]:
    async_playwright = await _playwright_import()
    playwright = await async_playwright().start()
    browser = await playwright.chromium.connect_over_cdp(cdp_url)
    contexts = browser.contexts
    context = contexts[0] if contexts else await browser.new_context()
    pages = context.pages
    page = pages[0] if pages else await context.new_page()
    return playwright, browser, page


async def _resolve_cdp_page_for_step(
    *,
    browser: Any,
    fallback_page: Any,
    step: dict[str, Any],
    page_registry: dict[str, dict[str, Any]],
    active_page_ref: str | None,
) -> tuple[Any, dict[str, dict[str, Any]], str | None]:
    contexts = browser.contexts
    context = contexts[0] if contexts else await browser.new_context()
    pages = context.pages
    page_ref = str(step.get("page_ref", "") or "").strip() or active_page_ref or None
    action = str(step.get("command", "") or step.get("action", "") or "").strip().lower()
    target_page = fallback_page

    def _match_page(candidate: Any, entry: dict[str, Any]) -> bool:
        url = str(entry.get("url", "") or "")
        title = str(entry.get("title", "") or "")
        if url and str(candidate.url or "") == url:
            return True
        if title:
            candidate_title = getattr(candidate, "_oi_cached_title", None)
            return bool(candidate_title and candidate_title == title)
        return False

    if pages:
        for candidate in pages:
            try:
                candidate._oi_cached_title = await candidate.title()
            except Exception:
                candidate._oi_cached_title = ""

    if page_ref and page_ref in page_registry:
        entry = page_registry.get(page_ref, {})
        matched = next((candidate for candidate in pages if _match_page(candidate, entry)), None)
        if matched is not None:
            target_page = matched
    elif page_ref and action in {"navigate", "open"}:
        if active_page_ref and active_page_ref != page_ref and pages:
            target_page = await context.new_page()
        else:
            target_page = fallback_page
    elif page_ref:
        target_page = fallback_page

    if page_ref:
        page_registry = dict(page_registry)
        try:
            current_title = await target_page.title()
        except Exception:
            current_title = ""
        page_registry[page_ref] = {
            "url": str(target_page.url or ""),
            "title": current_title,
            "last_seen_at": _now_iso(),
        }
        active_page_ref = page_ref
    return target_page, page_registry, active_page_ref


async def _sync_page_registry_over_cdp(
    *,
    cdp_url: str,
    step: dict[str, Any],
    page_registry: dict[str, dict[str, Any]] | None,
    active_page_ref: str | None,
) -> tuple[dict[str, dict[str, Any]], str | None, list[dict[str, Any]]]:
    playwright, browser, page = await _connect_browser_session(cdp_url)
    try:
        target_page, updated_registry, updated_active_page_ref = await _resolve_cdp_page_for_step(
            browser=browser,
            fallback_page=page,
            step=step,
            page_registry=dict(page_registry or {}),
            active_page_ref=active_page_ref,
        )
        bring_to_front = getattr(target_page, "bring_to_front", None)
        if callable(bring_to_front):
            await bring_to_front()
        page_ref = str(step.get("page_ref", "") or "").strip() or updated_active_page_ref or None
        if page_ref:
            updated_registry = dict(updated_registry)
            updated_registry[page_ref] = {
                **dict(updated_registry.get(page_ref, {}) or {}),
                "url": str(target_page.url or ""),
                "title": str(await target_page.title()),
                "last_seen_at": _now_iso(),
            }
            updated_active_page_ref = page_ref
        contexts = browser.contexts
        context = contexts[0] if contexts else await browser.new_context()
        discovered_pages: list[dict[str, Any]] = []
        for candidate in context.pages:
            candidate_url = str(candidate.url or "")
            try:
                candidate_title = str(await candidate.title())
            except Exception:
                candidate_title = ""
            matched_ref = next(
                (
                    ref
                    for ref, entry in updated_registry.items()
                    if (
                        candidate_url
                        and str(entry.get("url", "") or "") == candidate_url
                    )
                    or (
                        candidate_title
                        and str(entry.get("title", "") or "") == candidate_title
                    )
                ),
                None,
            )
            if matched_ref is None:
                matched_ref = _next_dynamic_page_ref(updated_registry, candidate_title, candidate_url)
                updated_registry[matched_ref] = {
                    "url": candidate_url,
                    "title": candidate_title,
                    "last_seen_at": _now_iso(),
                    "auto_detected": True,
                }
                discovered_pages.append(
                    {
                        "page_ref": matched_ref,
                        "url": candidate_url,
                        "title": candidate_title,
                    }
                )
        return updated_registry, updated_active_page_ref, discovered_pages
    finally:
        await browser.close()
        await playwright.stop()


async def _extract_structured_context_from_page(page: Any) -> dict[str, Any]:
    evaluated = await page.evaluate(
        """
        () => {
          const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          };
          const summarizeFieldValue = (el) => {
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              return (el.value || '').trim().slice(0, 200);
            }
            return (el.textContent || '').trim().slice(0, 200);
          };
          const elements = [];
          const editableFields = [];
          const buttons = [];
          const interactable = document.querySelectorAll(
            "a, button, input, select, textarea, [role='button'], [role='link'], [role='textbox'], [role='combobox'], [onclick]"
          );
          interactable.forEach((el, idx) => {
            if (idx > 200) return;
            const rect = el.getBoundingClientRect();
            const visible = rect.width > 0 && rect.height > 0;
            if (!visible && el.tagName !== 'BODY') return;
            elements.push({
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute('role') || '',
              type: el.type || '',
              text: (el.textContent || '').trim().substring(0, 100),
              ariaLabel: el.getAttribute('aria-label') || '',
              placeholder: el.getAttribute('placeholder') || '',
              href: el.href || '',
              name: el.getAttribute('name') || '',
              id: el.id || '',
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              visible
            });
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute('role') || '';
            const isEditable =
              el.isContentEditable
              || tag === 'input'
              || tag === 'textarea'
              || role === 'textbox'
              || role === 'combobox';
            if (isEditable && editableFields.length < 50) {
              editableFields.push({
                tag,
                role,
                type: el.type || '',
                ariaLabel: el.getAttribute('aria-label') || '',
                placeholder: el.getAttribute('placeholder') || '',
                name: el.getAttribute('name') || '',
                id: el.id || '',
                value: summarizeFieldValue(el),
              });
            }
            const isButtonLike =
              tag === 'button'
              || role === 'button'
              || tag === 'a'
              || role === 'link';
            if (isButtonLike && buttons.length < 50) {
              buttons.push({
                tag,
                role,
                text: (el.textContent || '').trim().slice(0, 120),
                ariaLabel: el.getAttribute('aria-label') || '',
                name: el.getAttribute('name') || '',
              });
            }
          });
          const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          return {
            url: location.href,
            title: document.title,
            bodyText: (document.body?.innerText || '').trim().slice(0, 12000),
            elements,
            editableFields,
            editableCount: editableFields.length,
            buttons,
            viewport: { w: innerWidth, h: innerHeight },
            scrollY,
            dialogCount: Array.from(document.querySelectorAll("dialog, [role='dialog'], [aria-modal='true']")).filter(isVisible).length,
            iframeCount: Array.from(document.querySelectorAll("iframe, frame")).filter(isVisible).length,
            overlayCount: Array.from(document.querySelectorAll("[role='alertdialog'], [data-overlay], .modal, [class*='modal'], .overlay, [class*='overlay'], .popover, [class*='popover'], .toast, [class*='toast'], .banner, [class*='banner']")).filter(isVisible).length,
            activeElement: active ? {
              tag: active.tagName.toLowerCase(),
              role: active.getAttribute('role') || '',
              ariaLabel: active.getAttribute('aria-label') || '',
              placeholder: active.getAttribute('placeholder') || '',
              editable:
                active.isContentEditable
                || active.tagName === 'INPUT'
                || active.tagName === 'TEXTAREA'
                || active.getAttribute('role') === 'textbox'
                || active.getAttribute('role') === 'combobox'
            } : null
          };
        }
        """
    )
    return cast(dict[str, Any], evaluated if isinstance(evaluated, dict) else {})


async def _capture_page_screenshot_basis(page: Any, *, page_ref: str | None = None) -> ScreenshotBasis | None:
    try:
        screenshot_bytes = await page.screenshot(type="jpeg", quality=60)
        context = await page.evaluate(
            """
            () => ({
              current_url: location.href || "",
              page_title: document.title || "",
              viewport: {
                width: Math.max(0, window.innerWidth || 0),
                height: Math.max(0, window.innerHeight || 0)
              },
              device_pixel_ratio: Number(window.devicePixelRatio || 1)
            })
            """
        )
    except Exception:
        return None

    payload = {
        "screenshot": f"data:image/jpeg;base64,{base64.b64encode(screenshot_bytes).decode('utf-8')}",
        "current_url": str((context or {}).get("current_url", "") or ""),
        "page_title": str((context or {}).get("page_title", "") or ""),
        "viewport": {
            "width": int(((context or {}).get("viewport", {}) or {}).get("width", 0) or 0),
            "height": int(((context or {}).get("viewport", {}) or {}).get("height", 0) or 0),
        },
        "device_pixel_ratio": float((context or {}).get("device_pixel_ratio", 1) or 1),
    }
    return build_screenshot_basis(payload)


async def _capture_agent_browser_visual_context(
    *,
    cdp_url: str,
    page_registry: dict[str, dict[str, Any]],
    active_page_ref: str | None,
) -> tuple[ScreenshotBasis | None, dict[str, Any] | None]:
    playwright, browser, page = await _connect_browser_session(cdp_url)
    try:
        target_page, _, resolved_page_ref = await _resolve_cdp_page_for_step(
            browser=browser,
            fallback_page=page,
            step={"page_ref": active_page_ref},
            page_registry=page_registry,
            active_page_ref=active_page_ref,
        )
        basis = await _capture_page_screenshot_basis(target_page, page_ref=resolved_page_ref)
        structured = await _extract_structured_context_from_page(target_page)
        return basis, structured
    finally:
        await browser.close()
        await playwright.stop()


def _runtime_completion_operations(plan: AutomationPlan) -> set[str]:
    operations: set[str] = set()
    if plan.execution_contract is not None:
        operations.update(
            str(item).strip().lower()
            for item in plan.execution_contract.task_shape.operation_chain
            if str(item).strip()
        )
        goal = str(plan.execution_contract.resolved_goal or "").strip().lower()
    else:
        goal = str(plan.summary or "").strip().lower()
    for token, operation in (
        ("send", "send"),
        ("reply", "send"),
        ("submit", "submit"),
        ("post", "post"),
        ("publish", "publish"),
        ("confirm", "confirm"),
        ("save", "save"),
    ):
        if token in goal:
            operations.add(operation)
    return operations


def _runtime_completion_entities(plan: AutomationPlan) -> list[str]:
    if plan.execution_contract is None:
        return []
    entities = plan.execution_contract.target_entities
    values = [
        str(entities.get("recipient", "") or entities.get("contact", "") or "").strip(),
        str(entities.get("subject", "") or "").strip(),
        str(entities.get("message_text", "") or entities.get("body", "") or "").strip(),
    ]
    return [value for value in values if value]


def _terminal_verification_haystack(
    *,
    url: str,
    title: str,
    snapshot_text: str,
    structured_context: dict[str, Any] | None,
) -> str:
    parts = [url, title, snapshot_text]
    if isinstance(structured_context, dict):
        parts.append(str(structured_context.get("bodyText", "") or ""))
        active = structured_context.get("activeElement", {})
        if isinstance(active, dict):
            parts.extend(
                [
                    str(active.get("tag", "") or ""),
                    str(active.get("role", "") or ""),
                    str(active.get("ariaLabel", "") or ""),
                    str(active.get("placeholder", "") or ""),
                ]
            )
        for field in list(structured_context.get("editableFields", []) or []):
            if not isinstance(field, dict):
                continue
            parts.extend(
                [
                    str(field.get("ariaLabel", "") or ""),
                    str(field.get("placeholder", "") or ""),
                    str(field.get("name", "") or ""),
                    str(field.get("id", "") or ""),
                    str(field.get("value", "") or ""),
                ]
            )
        for button in list(structured_context.get("buttons", []) or []):
            if not isinstance(button, dict):
                continue
            parts.extend(
                [
                    str(button.get("text", "") or ""),
                    str(button.get("ariaLabel", "") or ""),
                    str(button.get("name", "") or ""),
                ]
            )
    return _normalize_evidence_text("\n".join(part for part in parts if part))


def _terminal_verification_requires_confirmation(plan: AutomationPlan) -> bool:
    return bool(
        _runtime_completion_operations(plan).intersection({"send", "submit", "post", "publish", "confirm", "save"})
    )


def _fresh_terminal_snapshot_text(
    *,
    structured_context: dict[str, Any] | None,
    runtime_observation: dict[str, Any] | None,
    runtime_text: str,
) -> str:
    if isinstance(structured_context, dict):
        body_text = str(structured_context.get("bodyText", "") or "").strip()
        if body_text:
            return body_text
    observed_text = str((runtime_observation or {}).get("snapshot_text", "") or "").strip()
    if observed_text:
        return observed_text
    return str(runtime_text or "").strip()


def _looks_like_unsent_editor_surface(
    *,
    plan: AutomationPlan,
    url: str,
    title: str,
    snapshot_text: str,
    structured_context: dict[str, Any] | None,
) -> bool:
    haystack = _terminal_verification_haystack(
        url=url,
        title=title,
        snapshot_text=snapshot_text,
        structured_context=structured_context,
    )
    entity_values = [_normalize_evidence_text(value) for value in _runtime_completion_entities(plan) if value]
    editable_count = 0
    dialog_count = 0
    active_editable = False
    field_markers_present = False
    send_control_present = False
    if isinstance(structured_context, dict):
        editable_count = int(structured_context.get("editableCount", 0) or 0)
        dialog_count = int(structured_context.get("dialogCount", 0) or 0)
        active = structured_context.get("activeElement", {})
        if isinstance(active, dict):
            active_editable = bool(active.get("editable", False))
        field_markers_present = any(
            isinstance(field, dict)
            and any(
                marker in _normalize_evidence_text(
                    " ".join(
                        [
                            str(field.get("ariaLabel", "") or ""),
                            str(field.get("placeholder", "") or ""),
                            str(field.get("name", "") or ""),
                        ]
                    )
                )
                for marker in ("to", "recipient", "subject", "message body", "body")
            )
            for field in list(structured_context.get("editableFields", []) or [])
        )
        send_control_present = any(
            isinstance(button, dict)
            and any(
                marker in _normalize_evidence_text(
                    " ".join(
                        [
                            str(button.get("text", "") or ""),
                            str(button.get("ariaLabel", "") or ""),
                            str(button.get("name", "") or ""),
                        ]
                    )
                )
                for marker in ("send", "submit", "post", "publish")
            )
            for button in list(structured_context.get("buttons", []) or [])
        )
    compose_markers = (
        "compose",
        "draft",
        "new message",
        "new mail",
        "message body",
        "subject",
        "recipient",
        "to ",
        "unsent",
    )
    compose_surface = any(marker in haystack for marker in compose_markers)
    value_still_visible = any(value and value in haystack for value in entity_values)
    url_looks_draft = any(marker in _normalize_evidence_text(url) for marker in ("compose", "draft", "new"))
    strong_editor_surface = (
        (editable_count > 0 or active_editable)
        and (field_markers_present or send_control_present or dialog_count > 0)
    )
    if isinstance(structured_context, dict):
        return bool(strong_editor_surface or (url_looks_draft and value_still_visible))
    return bool((compose_surface or url_looks_draft) and value_still_visible)


def _has_explicit_terminal_success(
    *,
    plan: AutomationPlan,
    url: str,
    title: str,
    snapshot_text: str,
    structured_context: dict[str, Any] | None,
) -> bool:
    if not _terminal_verification_requires_confirmation(plan):
        return True
    haystack = _terminal_verification_haystack(
        url=url,
        title=title,
        snapshot_text=snapshot_text,
        structured_context=structured_context,
    )
    success_markers = (
        "message sent",
        "sent successfully",
        "successfully sent",
        "email sent",
        "posted successfully",
        "published successfully",
        "submitted successfully",
        "saved successfully",
        "successfully saved",
    )
    if any(marker in haystack for marker in success_markers):
        return True
    return re.search(r"\bsent\b", haystack) is not None


def _looks_like_explicit_runtime_completion_text(value: str) -> bool:
    haystack = _normalize_evidence_text(value)
    if not haystack:
        return False
    success_markers = (
        "message sent",
        "sent successfully",
        "successfully sent",
        "email has been sent",
        "email sent",
        "submitted successfully",
        "successfully submitted",
        "posted successfully",
        "successfully posted",
        "saved successfully",
        "successfully saved",
        "completed successfully",
        "successfully completed",
    )
    if any(marker in haystack for marker in success_markers):
        return True
    return re.search(r"\bsent\b", haystack) is not None


async def _verify_runtime_completion_against_browser_state(
    *,
    cdp_url: str,
    plan: AutomationPlan,
    page_registry: dict[str, dict[str, Any]],
    active_page_ref: str | None,
    runtime_observation: dict[str, Any] | None,
    runtime_text: str,
) -> tuple[RunError, dict[str, Any]] | None:
    if not _terminal_verification_requires_confirmation(plan):
        return None

    async def capture_terminal_state() -> tuple[BrowserStateSnapshot | None, dict[str, Any] | None, str, str, str]:
        basis, structured = await _capture_agent_browser_visual_context(
            cdp_url=cdp_url,
            page_registry=page_registry,
            active_page_ref=active_page_ref,
        )
        url = str(
            (structured or {}).get("url", "")
            or (runtime_observation or {}).get("url", "")
            or (basis.current_url if basis else "")
            or ""
        ).strip()
        title = str(
            (structured or {}).get("title", "")
            or (runtime_observation or {}).get("title", "")
            or (basis.page_title if basis else "")
            or ""
        ).strip()
        snapshot_text = _fresh_terminal_snapshot_text(
            structured_context=structured,
            runtime_observation=runtime_observation,
            runtime_text=runtime_text,
        )
        return basis, structured, url, title, snapshot_text

    basis, structured, url, title, snapshot_text = await capture_terminal_state()
    unsent_surface = _looks_like_unsent_editor_surface(
        plan=plan,
        url=url,
        title=title,
        snapshot_text=snapshot_text,
        structured_context=structured,
    )
    if unsent_surface:
        await asyncio.sleep(1.0)
        basis, structured, url, title, snapshot_text = await capture_terminal_state()
        unsent_surface = _looks_like_unsent_editor_surface(
            plan=plan,
            url=url,
            title=title,
            snapshot_text=snapshot_text,
            structured_context=structured,
        )
    if unsent_surface:
        incident = RuntimeIncident(
            incident_id=str(uuid.uuid4()),
            category="unexpected_ui",
            severity="critical",
            code="TERMINAL_COMPLETION_UNVERIFIED",
            summary="The browser still shows an unsent draft/editor state, so the action could not be verified as complete.",
            details="Terminal verification rejected runtime success because the live page still looks like an active compose/editor surface.",
            visible_signals=[url, title],
            requires_human=False,
            replannable=False,
            user_visible=True,
            browser_snapshot=BrowserStateSnapshot(
                captured_at=_now_iso(),
                url=url or None,
                title=title or None,
                page_id=active_page_ref,
                screenshot_url=basis.screenshot if basis else None,
                metadata={
                    "structured_context": structured or {},
                    "runtime_snapshot_text": snapshot_text,
                },
            ),
            created_at=_now_iso(),
        )
        return (
            RunError(
                code=incident.code,
                message=incident.summary,
                retryable=False,
            ),
            incident.model_dump(mode="json"),
        )

    if _has_explicit_terminal_success(
        plan=plan,
        url=url,
        title=title,
        snapshot_text=snapshot_text,
        structured_context=structured,
    ):
        return None

    return None


async def _runtime_failure_resolved_by_live_verification(
    *,
    run_id: str,
    cdp_url: str,
    plan: AutomationPlan,
    page_registry: dict[str, dict[str, Any]],
    active_page_ref: str | None,
    runtime_observation: dict[str, Any] | None,
    runtime_text: str,
    runtime_error: str,
) -> bool:
    combined_text = "\n\n".join(part for part in (runtime_error, runtime_text) if str(part or "").strip())
    basis, structured = await _capture_agent_browser_visual_context(
        cdp_url=cdp_url,
        page_registry=page_registry,
        active_page_ref=active_page_ref,
    )
    url = str(
        (structured or {}).get("url", "")
        or (runtime_observation or {}).get("url", "")
        or (basis.current_url if basis else "")
        or ""
    ).strip()
    title = str(
        (structured or {}).get("title", "")
        or (runtime_observation or {}).get("title", "")
        or (basis.page_title if basis else "")
        or ""
    ).strip()
    snapshot_text = str((runtime_observation or {}).get("snapshot_text", "") or runtime_text or runtime_error or "").strip()
    explicit_runtime_success = _looks_like_explicit_runtime_completion_text(combined_text)
    explicit_browser_success = _has_explicit_terminal_success(
        plan=plan,
        url=url,
        title=title,
        snapshot_text=snapshot_text,
        structured_context=structured,
    )
    if not explicit_runtime_success and not explicit_browser_success:
        return False
    if _looks_like_unsent_editor_surface(
        plan=plan,
        url=url,
        title=title,
        snapshot_text=snapshot_text,
        structured_context=structured,
    ):
        return False
    logger.info(
        "automation_runtime_failure_overridden_by_live_verification",
        extra={
            "run_id": run_id,
            "runtime_error": _truncate_log_value(runtime_error, limit=240),
            "explicit_runtime_success": explicit_runtime_success,
            "explicit_browser_success": explicit_browser_success,
        },
    )
    return True


async def _capture_agent_browser_evidence_bundle(
    *,
    cdp_url: str,
    current_url: str,
    current_title: str,
    page_snapshot: dict[str, Any] | None,
    snapshot_id: str,
    page_registry: dict[str, dict[str, Any]],
    active_page_ref: str | None,
    completed_steps: list[str] | None,
    last_verification_result: str = "",
) -> UnifiedEvidenceBundle:
    basis, structured = await _capture_agent_browser_visual_context(
        cdp_url=cdp_url,
        page_registry=page_registry,
        active_page_ref=active_page_ref,
    )
    return _build_unified_evidence_bundle(
        current_url=current_url,
        current_title=current_title,
        active_page_ref=active_page_ref,
        snapshot=page_snapshot,
        snapshot_id=snapshot_id,
        screenshot_basis=basis,
        structured_context=structured,
        completed_steps=completed_steps,
        last_verification_result=last_verification_result,
    )


async def _execute_agent_browser_coordinate_action(
    *,
    cdp_url: str,
    page_registry: dict[str, dict[str, Any]],
    active_page_ref: str | None,
    step: dict[str, Any],
) -> tuple[str, str]:
    def _visual_target_still_stable(expected: dict[str, Any], actual: ScreenshotBasis) -> bool:
        expected_url = str(expected.get("current_url", "") or "").strip()
        expected_title = str(expected.get("page_title", "") or "").strip()
        if expected_url and actual.current_url and expected_url != actual.current_url:
            return False
        if expected_title and actual.page_title and expected_title != actual.page_title:
            return False
        if int(expected.get("viewport_width", 0) or 0) != actual.viewport_width:
            return False
        if int(expected.get("viewport_height", 0) or 0) != actual.viewport_height:
            return False
        if abs(float(expected.get("device_pixel_ratio", 1) or 1) - actual.device_pixel_ratio) > 0.01:
            return False
        anchor = expected.get("anchor_region", {})
        if isinstance(anchor, dict) and anchor:
            x = int(anchor.get("x", -1) or -1)
            y = int(anchor.get("y", -1) or -1)
            width = int(anchor.get("width", 0) or 0)
            height = int(anchor.get("height", 0) or 0)
            if x < 0 or y < 0:
                return False
            if x >= actual.viewport_width or y >= actual.viewport_height:
                return False
            if width > 0 and x + width > actual.viewport_width + 8:
                return False
            if height > 0 and y + height > actual.viewport_height + 8:
                return False
            return True
        expected_screenshot_id = str(expected.get("screenshot_id", "") or "")
        return bool(expected_screenshot_id and expected_screenshot_id == actual.screenshot_id)

    playwright, browser, page = await _connect_browser_session(cdp_url)
    try:
        target_page, _, resolved_page_ref = await _resolve_cdp_page_for_step(
            browser=browser,
            fallback_page=page,
            step={"page_ref": str(step.get("page_ref", "") or active_page_ref or "")},
            page_registry=page_registry,
            active_page_ref=active_page_ref,
        )
        target = step.get("target", {})
        before_basis = await _capture_page_screenshot_basis(target_page, page_ref=resolved_page_ref)
        before_structured = await _extract_structured_context_from_page(target_page)
        if before_basis is None:
            raise RuntimeError("visual-fallback-missing-current-basis")
        if not _visual_target_still_stable(target if isinstance(target, dict) else {}, before_basis):
            raise RuntimeError("visual-fallback-invalidated-before-execution")
        x = int(target.get("x", 0) or 0)
        y = int(target.get("y", 0) or 0)
        await target_page.mouse.click(x, y)
        await target_page.wait_for_timeout(400)
        action = str(step.get("command", "") or "").strip().lower()
        if action == "type":
            focused_structured = await _extract_structured_context_from_page(target_page)
            focused_active = focused_structured.get("activeElement", {}) if isinstance(focused_structured, dict) else {}
            focused_ok = (
                isinstance(focused_active, dict)
                and (
                    bool(focused_active.get("editable"))
                    or str(focused_active.get("role", "")).strip().lower() in {"textbox", "combobox"}
                    or str(focused_active.get("tag", "")).strip().lower() in {"input", "textarea"}
                )
            )
            if not focused_ok:
                raise RuntimeError("visual-fallback-focus-failed")
            value = str(step.get("value", "") or "")
            if value:
                await target_page.keyboard.insert_text(value)
                await target_page.wait_for_timeout(250)
        after_basis = await _capture_page_screenshot_basis(target_page, page_ref=resolved_page_ref)
        after_structured = await _extract_structured_context_from_page(target_page)
        verified, verification_reason = await verify_visual_fallback(
            before_basis=before_basis,
            after_basis=after_basis or before_basis,
            step_intent=str(step.get("description", "") or action),
            verification_checks=[
                str(item).strip()
                for item in list(target.get("verification_checks", []) or [])
                if str(item).strip()
            ],
            structured_context=after_structured or before_structured,
        )
        if not verified:
            raise RuntimeError(f"visual-fallback-verification-failed: {verification_reason}")
        screenshot = str(after_basis.screenshot if after_basis else "")
        return "ok", screenshot
    finally:
        await browser.close()
        await playwright.stop()


async def _attempt_agent_browser_visual_replan(
    *,
    cdp_url: str,
    step_intent: str,
    completed_steps: list[str],
    page_registry: dict[str, dict[str, Any]],
    active_page_ref: str | None,
    failed_step: dict[str, Any] | None = None,
    basis: ScreenshotBasis | None = None,
    structured: dict[str, Any] | None = None,
) -> RuntimeActionPlan | None:
    _ = (cdp_url, completed_steps, failed_step, basis, structured)
    target: dict[str, Any] = {"snapshotFormat": "ai"}
    if active_page_ref:
        target["targetId"] = active_page_ref
    return RuntimeActionPlan(
        status="action",
        summary="Capture a fresh observation before the next interaction.",
        step=AgentBrowserStep.model_validate(
            {
                "type": "browser",
                "command": "snapshot",
                "description": f"Recover with a fresh snapshot: {step_intent}",
                "target": target,
            }
        ),
        intent=step_intent,
        preferred_execution_mode="ref",
        target_kind="unknown",
        expected_state_change="A fresh snapshot should reveal the current interactive state.",
        verification_checks=[],
        execution_mode_detail="observation_recovery",
    )


def _locator_from_target(page: Any, target: Any) -> Any:
    if isinstance(target, str):
        return page.locator(target)
    if not isinstance(target, dict):
        raise RuntimeError("Unsupported target format for browser session executor.")
    mode = str(target.get("by", "")).strip().lower()
    value = str(target.get("value", "")).strip()
    if mode == "role":
        options: dict[str, Any] = {}
        name = str(target.get("name", "")).strip()
        if name:
            options["name"] = name
        return page.get_by_role(value, **options)
    if mode == "text":
        return page.get_by_text(value, exact=False)
    if mode == "name":
        escaped = value.replace('"', '\\"')
        return page.locator(f'[name="{escaped}"], #{escaped}')
    if mode == "placeholder":
        return page.get_by_placeholder(value)
    if mode == "testid":
        return page.get_by_test_id(value)
    if mode == "label":
        return page.get_by_label(value)
    if mode == "css":
        return page.locator(value)
    raise RuntimeError(f"Unsupported target mode '{mode}' for browser session executor.")


_REPO_ROOT = Path(__file__).resolve().parents[5]
def _runtime_workspace_dir() -> str:
    return str(_REPO_ROOT)


def _resolve_runtime_target_page(
    *,
    page_registry: dict[str, dict[str, Any]] | None,
    active_page_ref: str | None,
    target_app: str | None,
    goal_text: str | None = None,
) -> tuple[str | None, dict[str, Any]]:
    _ = (target_app, goal_text)
    registry = page_registry if isinstance(page_registry, dict) else {}
    if not registry:
        return active_page_ref, {}
    if active_page_ref and active_page_ref in registry:
        return active_page_ref, dict(registry.get(active_page_ref) or {})
    active_rows = [
        (str(page_ref), dict(page or {}))
        for page_ref, page in registry.items()
        if isinstance(page, dict) and bool(page.get("is_active"))
    ]
    if active_rows:
        return active_rows[0]
    ranked_rows: list[tuple[str, dict[str, Any]]] = sorted(
        (
            (str(page_ref), dict(page or {}))
            for page_ref, page in registry.items()
        ),
        key=lambda item: (
            str(item[1].get("last_seen_at", "") or ""),
            int(item[1].get("tab_index", 0) or 0),
        ),
        reverse=True,
    )
    if ranked_rows:
        return ranked_rows[0]
    if active_page_ref:
        return active_page_ref, dict(registry.get(active_page_ref) or {})
    first_ref, first_page = next(iter(registry.items()))
    return str(first_ref), dict(first_page or {})


def _build_runtime_prompt(
    *,
    base_prompt: str,
    plan: AutomationPlan,
    run: AutomationRun,
) -> str:
    prompt = str(base_prompt or "").strip()
    context_lines: list[str] = []
    target_app = ""
    target_entities: dict[str, Any] = {}
    if plan.execution_contract:
        target_app = str(plan.execution_contract.target_app or "").strip()
        target_entities = dict(plan.execution_contract.target_entities or {})
    resolved_page_ref, active_page = _resolve_runtime_target_page(
        page_registry=run.page_registry,
        active_page_ref=run.active_page_ref,
        target_app=target_app,
        goal_text=plan.summary,
    )
    active_title = str(active_page.get("title") or "").strip()
    active_url = str(active_page.get("url") or "").strip()
    if target_app:
        context_lines.append(f"Target app: {target_app}")
    if resolved_page_ref and isinstance(run.page_registry, dict):
        if active_title:
            context_lines.append(f"Active browser page title: {active_title}")
        if active_url:
            context_lines.append(f"Active browser page URL: {active_url}")
    if context_lines:
        context_lines.append(
            "Use the already attached browser session and, if the active page already matches the target app, continue there instead of asking which service to use."
        )
        context_lines.append(
            "If the user gave constraints but left the exact on-page choice open, choose a suitable option that satisfies those constraints and keep going until a real human-only step blocks you."
        )
        context_lines.append(
            "Only claim progress or completion when the current browser state confirms it."
        )
        structured_targets = [
            ("recipient", str(target_entities.get("recipient", "") or target_entities.get("contact", "") or "").strip()),
            ("subject", str(target_entities.get("subject", "") or "").strip()),
            ("body", str(target_entities.get("message_text", "") or target_entities.get("body", "") or "").strip()),
        ]
        present_targets = [(label, value) for label, value in structured_targets if value]
        if present_targets:
            context_lines.append("Required field values for this task:")
            context_lines.extend(f"{label}: {value}" for label, value in present_targets)
            context_lines.append(
                "In multi-field forms, match each value to its intended field before moving to the next one."
            )
            context_lines.append(
                "Do not keep retyping the same value into the currently focused field. Re-snapshot and move focus to the correct field first."
            )
            context_lines.append(
                "Before sending or submitting, verify that all required fields are populated with their intended values."
            )
        return f"{prompt}\n\nBrowser context:\n- " + "\n- ".join(context_lines)
    return prompt


def _resolve_agent_browser_binary() -> Path:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == "darwin":
        os_key = "darwin"
    elif system == "linux":
        os_key = "linux"
    elif system == "windows":
        os_key = "win32"
    else:
        raise RuntimeError(f"Unsupported platform for agent-browser: {system}")

    if machine in {"x86_64", "amd64"}:
        arch_key = "x64"
    elif machine in {"arm64", "aarch64"}:
        arch_key = "arm64"
    else:
        raise RuntimeError(f"Unsupported architecture for agent-browser: {machine}")

    ext = ".exe" if os_key == "win32" else ""
    return _REPO_ROOT / "node_modules" / "agent-browser" / "bin" / f"agent-browser-{os_key}-{arch_key}{ext}"


_AGENT_BROWSER_CLI = _resolve_agent_browser_binary()
def _agent_browser_session_name(cdp_url: str) -> str:
    return f"oi-run-{hashlib.sha256(cdp_url.encode('utf-8')).hexdigest()[:16]}"


def _target_to_selector(target: Any) -> str:
    if isinstance(target, str):
        return target
    if not isinstance(target, dict):
        raise RuntimeError("Unsupported target format for browser session execution.")
    mode = str(target.get("by", "")).strip().lower()
    value = str(target.get("value", "")).strip()
    if mode == "css":
        return value
    if mode == "name":
        escaped = value.replace('"', '\\"')
        return f'[name="{escaped}"], #{escaped}'
    raise RuntimeError(f"Target mode '{mode}' does not have a direct selector fallback.")


def _is_coords_target(target: Any) -> bool:
    return isinstance(target, dict) and str(target.get("by", "")).strip().lower() == "coords"


def _normalize_agent_browser_ref(value: Any) -> str | None:
    ref = str(value or "").strip()
    if not ref:
        return None
    if ref.startswith("@e"):
        return ref
    if ref.startswith("e"):
        return f"@{ref}"
    return None


def _extract_agent_browser_ref_target(target: Any) -> str | None:
    if isinstance(target, str):
        return _normalize_agent_browser_ref(target)
    if not isinstance(target, dict):
        return None
    direct_ref = _normalize_agent_browser_ref(target.get("ref"))
    if direct_ref:
        return direct_ref
    mode = str(target.get("by", "")).strip().lower()
    if mode == "ref":
        direct_ref = _normalize_agent_browser_ref(target.get("value"))
        if direct_ref:
            return direct_ref
    candidates = target.get("candidates")
    if isinstance(candidates, list):
        for candidate in candidates:
            if not isinstance(candidate, dict):
                direct_ref = _normalize_agent_browser_ref(candidate)
                if direct_ref:
                    return direct_ref
                continue
            if str(candidate.get("type", "")).strip().lower() != "ref":
                continue
            direct_ref = _normalize_agent_browser_ref(candidate.get("value"))
            if direct_ref:
                return direct_ref
    return None


def _target_to_agent_browser_command(target: Any, action: str, value: str | None = None) -> list[str]:
    ref_target = _extract_agent_browser_ref_target(target)
    if ref_target:
        if action == "click":
            return ["click", ref_target]
        if action in {"fill", "type"}:
            return ["fill", ref_target, value or ""]
        if action == "hover":
            return ["hover", ref_target]
        if action == "focus":
            return ["focus", ref_target]
        if action == "wait":
            return ["wait", ref_target]
        if action == "scroll":
            return ["scrollintoview", ref_target]
        if action == "highlight":
            return ["highlight", ref_target]
        raise RuntimeError(f"Unsupported ref-based agent-browser action '{action}'.")
    if isinstance(target, str):
        selector = target
        if action == "click":
            return ["click", selector]
        if action == "type":
            return ["fill", selector, value or ""]
        if action == "select":
            return ["select", selector, value or ""]
        if action == "hover":
            return ["hover", selector]
        if action == "wait":
            return ["wait", selector]
        if action == "scroll":
            return ["scrollintoview", selector]
        if action == "highlight":
            return ["highlight", selector]
        raise RuntimeError(f"Unsupported agent-browser action '{action}'.")
    if not isinstance(target, dict):
        raise RuntimeError("Unsupported target format for agent-browser.")
    mode = str(target.get("by", "")).strip().lower()
    raw_value = str(target.get("value", "")).strip()
    name = str(target.get("name", "")).strip()
    if mode == "role":
        command = ["find", "role", raw_value, action]
        if value is not None and action in {"fill", "type"}:
            command.append(value)
        if name:
            command.extend(["--name", name])
        return command
    if mode == "text":
        if action in {"click", "hover", "focus", "text", "highlight"}:
            return ["find", "text", raw_value, action]
        if action == "wait":
            return ["wait", "--text", raw_value]
        raise RuntimeError(f"Text target does not support action '{action}' in agent-browser.")
    if mode == "label":
        if action in {"fill", "type"}:
            return ["find", "label", raw_value, action, value or ""]
        if action == "click":
            return ["find", "label", raw_value, "click"]
        if action == "highlight":
            return ["find", "label", raw_value, "highlight"]
        if action == "focus":
            return ["find", "label", raw_value, "focus"]
        if action == "wait":
            return ["wait", _target_to_selector(target)]
    if mode == "placeholder":
        if action in {"fill", "type"}:
            return ["find", "placeholder", raw_value, action, value or ""]
        if action == "click":
            return ["find", "placeholder", raw_value, "click"]
        if action == "highlight":
            return ["find", "placeholder", raw_value, "highlight"]
        if action == "focus":
            return ["find", "placeholder", raw_value, "focus"]
        if action == "wait":
            return ["wait", _target_to_selector(target)]
    if mode == "testid":
        if action == "click":
            return ["find", "testid", raw_value, "click"]
        if action == "highlight":
            return ["find", "testid", raw_value, "highlight"]
        if action in {"fill", "type"}:
            return ["find", "testid", raw_value, action, value or ""]
        if action == "focus":
            return ["find", "testid", raw_value, "focus"]
        if action == "wait":
            return ["wait", _target_to_selector(target)]
    selector = _target_to_selector(target)
    return _target_to_agent_browser_command(selector, action, value)


def _is_agent_browser_target_action_supported(target: Any, action: str) -> bool:
    if _extract_agent_browser_ref_target(target):
        return action in {"click", "type", "hover", "select", "wait", "scroll", "highlight", "focus"}
    return browser_action_target_supported(action, target)


def _compute_agent_browser_snapshot_id(snapshot: dict[str, Any] | None) -> str:
    if not isinstance(snapshot, dict):
        return ""
    base = "||".join(
        [
            str(snapshot.get("origin", "") or snapshot.get("url", "") or ""),
            str(snapshot.get("title", "") or ""),
            str(snapshot.get("snapshot", "") or "")[:5000],
        ]
    )
    return hashlib.sha1(base.encode("utf-8")).hexdigest()[:16] if base else ""


def _count_snapshot_refs(snapshot: dict[str, Any] | None) -> int:
    if not isinstance(snapshot, dict):
        return 0
    refs = snapshot.get("refs", {})
    return len(refs) if isinstance(refs, dict) else 0


def _step_target_uses_ref(target: Any) -> bool:
    return _extract_agent_browser_ref_target(target) is not None


def _step_needs_snapshot_refresh(step: dict[str, Any]) -> bool:
    action = str(step.get("command", "") or step.get("action", "") or "").strip().lower()
    if action in {"snapshot", "navigate", "open"}:
        return False
    return _step_target_uses_ref(step.get("target"))


def _action_mutates_page(action: str) -> bool:
    return action in {"navigate", "open", "click", "type", "select", "hover", "press", "keyboard", "tab", "frame", "upload", "scroll"}


def _is_interactive_command(action: str) -> bool:
    return action in {"click", "type", "select", "hover", "upload", "press", "keyboard"}


def _is_planner_actionable_command(action: str) -> bool:
    return _is_interactive_command(action) or action in {
        "snapshot",
        "extract_structured",
        "diagnostics",
        "scan_ui_blockers",
        "highlight",
    }


def _requires_heavy_post_step_review(action: str) -> bool:
    return action in {"navigate", "open", "click", "tab", "frame", "upload"}


def _should_capture_post_step_snapshot(step: dict[str, Any]) -> bool:
    action = str(step.get("command", "") or step.get("action", "") or "").strip().lower()
    return _action_mutates_page(action) or bool(step.get("success_criteria"))


async def _read_agent_browser_target_value(
    *,
    session_name: str,
    target: Any,
) -> str | None:
    ref_target = _extract_agent_browser_ref_target(target)
    if ref_target:
        selector_args = [ref_target]
    elif isinstance(target, str):
        selector_args = [target]
    elif isinstance(target, dict):
        try:
            selector_args = [_target_to_selector(target)]
        except Exception:
            return None
    else:
        return None
    for getter in ("value", "text"):
        try:
            result = await _run_node_json_command(
                args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", "get", getter, *selector_args]
            )
        except Exception:
            continue
        value = result.get(getter)
        if value is None and "value" in result:
            value = result.get("value")
        if value is None and "text" in result:
            value = result.get("text")
        if value is None and "result" in result:
            value = result.get("result")
        if value is not None:
            return str(value)
    return None


async def _capture_agent_browser_diagnostics(*, session_name: str) -> dict[str, Any]:
    diagnostics: dict[str, Any] = {}
    for label, command in (
        ("console", ["console"]),
        ("errors", ["errors"]),
        ("network_requests", ["network", "requests"]),
    ):
        try:
            result = await _run_node_json_command(
                args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", *command]
            )
        except Exception as exc:
            diagnostics[label] = {"error": str(exc)}
            continue
        diagnostics[label] = result
    try:
        dom = await _run_node_json_command(
            args=[
                str(_AGENT_BROWSER_CLI),
                "--session",
                session_name,
                "--json",
                "eval",
                """(() => {
                  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                  return {
                    readyState: document.readyState || "",
                    activeTag: active ? active.tagName.toLowerCase() : "",
                    activeRole: active ? (active.getAttribute("role") || "") : "",
                    activeLabel: active ? (active.getAttribute("aria-label") || active.getAttribute("placeholder") || active.textContent || "").trim().slice(0, 80) : "",
                    dialogCount: document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog, .modal, [class*="modal"], .popup, [class*="popup"]').length,
                    iframeCount: document.querySelectorAll("iframe").length,
                    overlayCount: document.querySelectorAll('.overlay, .backdrop, [class*="overlay"], [class*="backdrop"], [class*="scrim"], [data-testid*="modal"]').length,
                  };
                })()""",
            ]
        )
        diagnostics["dom"] = dict(dom.get("result", {}) or {})
    except Exception as exc:
        diagnostics["dom"] = {"error": str(exc)}
    return diagnostics


async def _verify_step_postconditions(
    *,
    session_name: str,
    step: dict[str, Any],
    post_step_snapshot: dict[str, Any] | None,
) -> None:
    def _normalize_observed_text(raw: str) -> str:
        return raw.replace("\r\n", "\n").replace("\r", "\n")

    def _normalize_match_text(raw: str) -> str:
        return re.sub(r"\s+", " ", str(raw or "")).strip().lower()

    def _page_contains_text(snapshot: dict[str, Any] | None, expected: str) -> bool:
        needle = _normalize_match_text(expected)
        if not needle:
            return False
        if not isinstance(snapshot, dict):
            return False

        fields: list[str] = [
            str(snapshot.get("origin", "") or snapshot.get("url", "") or ""),
            str(snapshot.get("title", "") or ""),
            str(snapshot.get("snapshot", "") or ""),
        ]
        refs = snapshot.get("refs", {})
        if isinstance(refs, dict):
            for meta in refs.values():
                if not isinstance(meta, dict):
                    continue
                fields.extend(
                    [
                        str(meta.get("name", "") or ""),
                        str(meta.get("label", "") or ""),
                        str(meta.get("value", "") or ""),
                        str(meta.get("text", "") or ""),
                    ]
                )
        haystack = "\n".join(field for field in fields if field).lower()
        return needle in _normalize_match_text(haystack)

    action = str(step.get("command", "") or step.get("action", "") or "").strip().lower()
    target = step.get("target")
    rules = list(step.get("success_criteria", []) or [])

    if action in {"type", "select"} and target not in ("", None, {}) and not _is_coords_target(target):
        expected_value = _normalize_observed_text(str(step.get("value", "") or ""))
        observed_value = await _read_agent_browser_target_value(
            session_name=session_name,
            target=target,
        )
        if observed_value is None:
            raise RuntimeError("postcondition-target-value-unreadable")
        if _normalize_observed_text(observed_value) != expected_value:
            raise RuntimeError("postcondition-value-mismatch")

    for rule in rules:
        if not isinstance(rule, dict):
            continue
        rule_type = str(rule.get("type", "") or "").strip().lower()
        if rule_type == "target_present":
            expected_target = rule.get("target", target)
            if expected_target in ("", None, {}):
                raise RuntimeError("postcondition-target-present-invalid")
            if post_step_snapshot is not None and _step_target_uses_ref(expected_target):
                if not _snapshot_contains_target_ref(post_step_snapshot, expected_target):
                    raise RuntimeError("postcondition-target-missing")
                continue
            await _run_node_json_command(
                args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", *_target_to_agent_browser_command(expected_target, "wait")]
            )
        elif rule_type == "target_absent":
            expected_target = rule.get("target", target)
            if expected_target in ("", None, {}):
                raise RuntimeError("postcondition-target-absent-invalid")
            if post_step_snapshot is not None and _step_target_uses_ref(expected_target):
                if _snapshot_contains_target_ref(post_step_snapshot, expected_target):
                    raise RuntimeError("postcondition-target-still-present")
                continue
        elif rule_type == "url_contains":
            expected_url = str(rule.get("value", "") or "").strip()
            if not expected_url:
                continue
            current_url = ""
            if isinstance(post_step_snapshot, dict):
                current_url = str(post_step_snapshot.get("origin", "") or post_step_snapshot.get("url", "") or "")
            if expected_url and expected_url not in current_url:
                raise RuntimeError("postcondition-url-mismatch")
        elif rule_type == "page_contains_text":
            expected_text = str(rule.get("value", "") or "").strip()
            if not expected_text:
                continue
            if not _page_contains_text(post_step_snapshot, expected_text):
                raise RuntimeError("postcondition-page-missing-text")
        elif rule_type == "page_not_contains_text":
            expected_text = str(rule.get("value", "") or "").strip()
            if not expected_text:
                continue
            if _page_contains_text(post_step_snapshot, expected_text):
                raise RuntimeError("postcondition-page-still-contains-text")


def _snapshot_contains_target_ref(snapshot: dict[str, Any] | None, target: Any) -> bool:
    if not isinstance(snapshot, dict):
        return False
    ref_target = _extract_agent_browser_ref_target(target)
    if not ref_target:
        return False
    normalized_ref = ref_target.lstrip("@")
    refs = snapshot.get("refs", {})
    if isinstance(refs, dict) and normalized_ref in refs:
        return True
    snapshot_text = str(snapshot.get("snapshot", "") or "")
    if not snapshot_text:
        return False
    return f"[ref={normalized_ref}]" in snapshot_text


def _classify_step_error_code(message: str) -> str:
    lowered = str(message or "").strip().lower()
    if not lowered:
        return "EXECUTION_FAILED"
    if "does not support action" in lowered or "target-action-incompatible" in lowered:
        return "TARGET_ACTION_INCOMPATIBLE"
    if "stale snapshot" in lowered:
        return "PAGE_CHANGED"
    if (
        "unknown ref" in lowered
        or "element not found" in lowered
        or "not found or not visible" in lowered
        or "could not find" in lowered
    ):
        return "ELEMENT_NOT_FOUND"
    if "ambiguous" in lowered or "more than one" in lowered:
        return "ELEMENT_AMBIGUOUS"
    if "timed out" in lowered or "timeout" in lowered:
        return "TIMEOUT"
    if any(
        token in lowered
        for token in ("captcha", "otp", "2fa", "login required", "payment", "manual intervention required", "permission")
    ):
        return "SENSITIVE_ACTION_BLOCKED"
    if any(
        token in lowered
        for token in ("not editable", "not clickable", "not selectable", "postcondition-", "value-mismatch")
    ):
        return "PAGE_CHANGED"
    return "EXECUTION_FAILED"


async def _run_node_json_command(*, args: list[str], stdin: str | None = None) -> dict[str, Any]:
    started_at = asyncio.get_running_loop().time()
    logger.info(
        "agent_browser_command_start",
        extra={
            "command": args,
        },
    )
    process = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.PIPE if stdin is not None else None,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate(stdin.encode("utf-8") if stdin is not None else None)
    output = (stdout or b"").decode("utf-8", errors="replace").strip()
    error_output = (stderr or b"").decode("utf-8", errors="replace").strip()
    if process.returncode != 0:
        logger.error(
            "agent_browser_command_failed",
            extra={
                "command": args,
                "duration_ms": round((asyncio.get_running_loop().time() - started_at) * 1000, 2),
                "stdout": output[:2000],
                "stderr": error_output[:2000],
                "returncode": process.returncode,
            },
        )
        raise RuntimeError(error_output or output or f"Node command failed with exit code {process.returncode}")
    logger.info(
        "agent_browser_command_done",
        extra={
            "command": args,
            "duration_ms": round((asyncio.get_running_loop().time() - started_at) * 1000, 2),
            "stdout": output[:2000],
            "stderr": error_output[:2000],
        },
    )
    if not output:
        return {}
    for line in reversed([line.strip() for line in output.splitlines() if line.strip()]):
        try:
            parsed = json.loads(line)
            if isinstance(parsed, dict) and "success" in parsed:
                if not bool(parsed.get("success")):
                    raise RuntimeError(str(parsed.get("error", "") or "agent-browser command failed"))
                data = parsed.get("data")
                if isinstance(data, dict):
                    return data
                if data is None:
                    return {}
                return {"value": data}
            return cast(dict[str, Any], parsed if isinstance(parsed, dict) else {"value": parsed})
        except json.JSONDecodeError:
            continue
    raise RuntimeError(error_output or f"Could not parse JSON output: {output}")


async def _capture_agent_browser_snapshot(
    *,
    session_name: str,
    page_registry: dict[str, dict[str, Any]],
    active_page_ref: str | None,
    snapshot_format: str = "ai",
    scope_selector: str | None = None,
    frame: str | None = None,
) -> tuple[dict[str, Any], str]:
    await _sync_agent_browser_active_tab(
        session_name=session_name,
        page_registry=page_registry,
        active_page_ref=active_page_ref,
    )
    normalized_frame = str(frame or "").strip()
    frame_command = ["frame", "main"] if not normalized_frame or normalized_frame == "main" else ["frame", normalized_frame]
    await _run_node_json_command(
        args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", *frame_command]
    )
    snapshot_args = [str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", "snapshot"]
    normalized_format = str(snapshot_format or "ai").strip().lower() or "ai"
    if normalized_format == "ai":
        snapshot_args.extend(["-i", "-c", "-d", "5"])
    normalized_scope_selector = str(scope_selector or "").strip()
    if normalized_scope_selector:
        snapshot_args.extend(["-s", normalized_scope_selector])
    snapshot = await _run_node_json_command(
        args=snapshot_args
    )
    snapshot_id = _compute_agent_browser_snapshot_id(snapshot)
    if snapshot_id:
        snapshot["snapshot_id"] = snapshot_id
    snapshot["snapshotFormat"] = normalized_format
    if normalized_scope_selector:
        snapshot["scopeSelector"] = normalized_scope_selector
    if normalized_frame:
        snapshot["frame"] = normalized_frame
    elif "frame" in snapshot:
        snapshot.pop("frame", None)
    if active_page_ref:
        snapshot["targetId"] = active_page_ref
    logger.info(
        "agent_browser_snapshot_captured",
        extra={
            "session_name": session_name,
            "active_page_ref": active_page_ref,
            "origin": str(snapshot.get("origin", "") or snapshot.get("url", "") or ""),
            "title": str(snapshot.get("title", "") or ""),
            "snapshot_id": snapshot_id,
            "ref_count": _count_snapshot_refs(snapshot),
            "snapshot_format": normalized_format,
            "scope_selector": normalized_scope_selector,
            "frame": normalized_frame,
        },
    )
    return snapshot, snapshot_id


async def _sync_agent_browser_active_tab(
    *,
    session_name: str,
    page_registry: dict[str, dict[str, Any]],
    active_page_ref: str | None,
) -> None:
    if not active_page_ref:
        logger.info(
            "agent_browser_tab_sync_skipped",
            extra={
                "reason": "missing_active_page_ref",
                "session_name": session_name,
                "active_page_ref": active_page_ref,
            },
        )
        return
    target_entry = dict(page_registry.get(active_page_ref, {}) or {})
    target_url = str(target_entry.get("url", "") or "")
    target_title = str(target_entry.get("title", "") or "")
    target_tab_index_raw = target_entry.get("tab_index")
    if isinstance(target_tab_index_raw, int):
        target_tab_index = target_tab_index_raw
    elif isinstance(target_tab_index_raw, str) and target_tab_index_raw.strip().isdigit():
        target_tab_index = int(target_tab_index_raw)
    else:
        target_tab_index = None
    if not target_url and not target_title:
        logger.info(
            "agent_browser_tab_sync_skipped",
            extra={
                "reason": "missing_page_registry_metadata",
                "session_name": session_name,
                "active_page_ref": active_page_ref,
                "page_registry_entry": target_entry,
            },
        )
        return
    listing = await _run_node_json_command(
        args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", "tab"]
    )
    tabs = list(listing.get("tabs", []) or [])
    matched_tab = None
    if target_tab_index is not None:
        matched_tab = next((tab for tab in tabs if int(tab.get("index", -1) or -1) == target_tab_index), None)
    if matched_tab is None:
        matched_tab = next(
            (
                tab
                for tab in tabs
                if (
                    target_url
                    and str(tab.get("url", "") or "") == target_url
                )
                or (
                    target_title
                    and str(tab.get("title", "") or "") == target_title
                )
            ),
            None,
        )
    if not matched_tab:
        logger.warning(
            "agent_browser_tab_sync_miss",
            extra={
                "session_name": session_name,
                "active_page_ref": active_page_ref,
                "target_url": target_url,
                "target_title": target_title,
                "tabs": tabs[:10],
            },
        )
        return
    if active_page_ref:
        entry = dict(page_registry.get(active_page_ref, {}) or {})
        entry["tab_index"] = int(matched_tab.get("index", 0) or 0)
        entry["url"] = str(matched_tab.get("url", "") or target_url or "")
        entry["title"] = str(matched_tab.get("title", "") or target_title or "")
        entry["last_seen_at"] = _now_iso()
        page_registry[active_page_ref] = entry
    if bool(matched_tab.get("active")):
        logger.info(
            "agent_browser_tab_sync_skipped",
            extra={
                "reason": "already_active",
                "session_name": session_name,
                "active_page_ref": active_page_ref,
                "target_url": target_url,
                "target_title": target_title,
                "matched_tab": matched_tab,
            },
        )
        return
    target_index = int(matched_tab.get("index", 0) or 0)
    await _run_node_json_command(
        args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", "tab", str(target_index)]
    )
    logger.info(
        "agent_browser_tab_synced",
        extra={
            "session_name": session_name,
            "active_page_ref": active_page_ref,
            "target_index": target_index,
            "target_url": target_url,
            "target_title": target_title,
        },
    )


async def _execute_browser_steps_with_agent_browser(
    cdp_url: str,
    steps: list[dict[str, Any]],
    *,
    page_registry: dict[str, dict[str, Any]] | None = None,
    active_page_ref: str | None = None,
) -> ToolResult:
    if not _AGENT_BROWSER_CLI.exists():
        raise RuntimeError("agent-browser CLI is not installed in this workspace.")
    session_name = _agent_browser_session_name(cdp_url)
    await _run_node_json_command(args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", "connect", cdp_url])
    results: list[dict[str, Any]] = []
    last_screenshot = ""
    current_page_registry = dict(page_registry or {})
    current_active_page_ref = active_page_ref
    current_snapshot: dict[str, Any] | None = None
    current_snapshot_id = ""
    current_observation_context = _normalize_observation_context(target_id=current_active_page_ref)
    snapshot_dirty = False
    for idx, step in enumerate(steps):
        action = str(step.get("command", "") or step.get("action", "")).strip().lower()
        description = str(step.get("description", "") or action or f"Step {idx + 1}")
        screenshot = ""
        post_step_snapshot: dict[str, Any] | None = None
        post_step_snapshot_id = ""
        try:
            current_page_registry, current_active_page_ref, _ = await _sync_page_registry_over_cdp(
                cdp_url=cdp_url,
                step=step,
                page_registry=current_page_registry,
                active_page_ref=current_active_page_ref,
            )
            if _step_needs_snapshot_refresh(step):
                expected_snapshot_id = str(step.get("snapshot_id", "") or "").strip()
                if (
                    snapshot_dirty
                    or current_snapshot is None
                    or not _snapshot_contains_target_ref(current_snapshot, step.get("target"))
                    or (expected_snapshot_id and expected_snapshot_id != current_snapshot_id)
                ):
                    logger.info(
                        "agent_browser_snapshot_refresh_requested",
                        extra={
                            "session_name": session_name,
                            "step_description": description,
                            "step_command": action,
                            "target": step.get("target"),
                            "expected_snapshot_id": expected_snapshot_id,
                            "current_snapshot_id": current_snapshot_id,
                            "snapshot_dirty": snapshot_dirty,
                            "has_current_snapshot": current_snapshot is not None,
                            "target_ref_present": _snapshot_contains_target_ref(
                                current_snapshot,
                                step.get("target"),
                            ),
                        },
                    )
                    current_snapshot, current_snapshot_id = await _capture_agent_browser_snapshot(
                        session_name=session_name,
                        page_registry=current_page_registry,
                        active_page_ref=current_active_page_ref,
                        snapshot_format=current_observation_context.get("snapshotFormat", "ai"),
                        scope_selector=current_observation_context.get("scopeSelector", "") or None,
                        frame=current_observation_context.get("frame", "") or None,
                    )
                    current_observation_context = _observation_context_from_snapshot(
                        current_snapshot,
                        fallback_target_id=current_active_page_ref,
                    )
                    snapshot_dirty = False
            else:
                await _sync_agent_browser_active_tab(
                    session_name=session_name,
                    page_registry=current_page_registry,
                    active_page_ref=current_active_page_ref,
                )
            if action not in {"snapshot", "frame"}:
                frame_value = current_observation_context.get("frame", "").strip()
                frame_command = ["frame", "main"] if not frame_value or frame_value == "main" else ["frame", frame_value]
                await _run_node_json_command(
                    args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", *frame_command]
                )
            if action == "open" or action == "navigate":
                args = step.get("args")
                target_value = str(step.get("target", "") or "")
                if not target_value and isinstance(args, list) and args:
                    target_value = str(args[0] or "")
                await _run_node_json_command(
                    args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", "open", target_value]
                )
                current_observation_context = _merge_observation_context(
                    current_observation_context,
                    scope_selector="",
                    frame="",
                    target_id=current_active_page_ref or "",
                )
            elif action == "click":
                if _is_coords_target(step.get("target")):
                    _, screenshot = await _execute_agent_browser_coordinate_action(
                        cdp_url=cdp_url,
                        page_registry=current_page_registry,
                        active_page_ref=current_active_page_ref,
                        step=step,
                    )
                    last_screenshot = screenshot or last_screenshot
                else:
                    if not _is_agent_browser_target_action_supported(step.get("target"), "click"):
                        raise RuntimeError("target-action-incompatible: click")
                    await _run_node_json_command(
                        args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", *_target_to_agent_browser_command(step.get("target"), "click")]
                    )
            elif action == "type":
                if _is_coords_target(step.get("target")):
                    _, screenshot = await _execute_agent_browser_coordinate_action(
                        cdp_url=cdp_url,
                        page_registry=current_page_registry,
                        active_page_ref=current_active_page_ref,
                        step=step,
                    )
                    last_screenshot = screenshot or last_screenshot
                else:
                    if not _is_agent_browser_target_action_supported(step.get("target"), "type"):
                        raise RuntimeError("target-action-incompatible: type")
                    await _run_node_json_command(
                        args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", *_target_to_agent_browser_command(step.get("target"), "type", str(step.get("value", "") or ""))]
                    )
            elif action == "select":
                if not _is_agent_browser_target_action_supported(step.get("target"), "select"):
                    raise RuntimeError("target-action-incompatible: select")
                await _run_node_json_command(
                    args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", *_target_to_agent_browser_command(step.get("target"), "select", str(step.get("value", "") or ""))]
                )
            elif action == "hover":
                if not _is_agent_browser_target_action_supported(step.get("target"), "hover"):
                    raise RuntimeError("target-action-incompatible: hover")
                await _run_node_json_command(
                    args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", *_target_to_agent_browser_command(step.get("target"), "hover")]
                )
            elif action == "scroll":
                target = step.get("target")
                if target not in ("", None, {}):
                    await _run_node_json_command(
                        args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", *_target_to_agent_browser_command(target, "scroll")]
                    )
                else:
                    await _run_node_json_command(
                        args=[
                            str(_AGENT_BROWSER_CLI),
                            "--session",
                            session_name,
                            "--json",
                            "scroll",
                            "down",
                            str(int(step.get("value", 600) or 600)),
                        ]
                    )
            elif action == "wait":
                target = step.get("target")
                if target not in ("", None, {}):
                    await _run_node_json_command(
                        args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", *_target_to_agent_browser_command(target, "wait")]
                    )
                else:
                    await _run_node_json_command(
                        args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", "wait", str(int(float(step.get("value", 2000) or 2000)))]
                    )
            elif action == "press":
                args = step.get("args")
                key = str(step.get("value", "") or (args[0] if isinstance(args, list) and args else "")).strip()
                if not key:
                    raise RuntimeError("Press action requires a key value.")
                await _run_node_json_command(
                    args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", "press", key]
                )
            elif action == "keyboard":
                value = str(step.get("value", "") or "").strip()
                if not value:
                    raise RuntimeError("Keyboard action requires a value.")
                if len(value) == 1 or "+" in value or value in {"Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"}:
                    await _run_node_json_command(
                        args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", "press", value]
                    )
                else:
                    await _run_node_json_command(
                        args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", "keyboard", "type", value]
                    )
            elif action == "upload":
                target = step.get("target")
                if target in ("", None, {}):
                    raise RuntimeError("Upload action requires a target.")
                upload_value = step.get("value")
                if isinstance(upload_value, list):
                    file_value = ",".join(str(item) for item in upload_value if str(item).strip())
                else:
                    file_value = str(upload_value or "").strip()
                if not file_value:
                    raise RuntimeError("Upload action requires a file path.")
                selector = _target_to_selector(target) if not isinstance(target, str) or not target.startswith("@") else target
                await _run_node_json_command(
                    args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", "upload", selector, file_value]
                )
            elif action == "tab":
                value = str(step.get("value", "") or "").strip()
                target = str(step.get("target", "") or "").strip()
                if value in {"list"}:
                    listing = await _run_node_json_command(
                        args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", "tab"]
                    )
                    results.append({"step_index": idx, "command": action, "description": description, "status": "done", "data": listing, "screenshot": ""})
                    continue
                if value in {"close"}:
                    command = ["tab", "close"]
                    if target:
                        command.append(target)
                elif value in {"new"}:
                    command = ["tab", "new"]
                    if target:
                        command.append(target)
                elif target:
                    command = ["tab", target]
                elif value:
                    command = ["tab", value]
                else:
                    command = ["tab"]
                await _run_node_json_command(
                    args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", *command]
                )
                current_observation_context = _merge_observation_context(
                    current_observation_context,
                    scope_selector="",
                    frame="",
                    target_id=current_active_page_ref or "",
                )
            elif action == "frame":
                value = str(step.get("value", "") or "").strip()
                if value == "main":
                    command = ["frame", "main"]
                    frame_selector = "main"
                else:
                    target = step.get("target")
                    if target in ("", None, {}):
                        raise RuntimeError("Frame action requires a frame target or value=main.")
                    frame_selector = _target_to_selector(target) if not isinstance(target, str) else str(target)
                    command = ["frame", frame_selector]
                await _run_node_json_command(
                    args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", *command]
                )
                current_observation_context = _merge_observation_context(
                    current_observation_context,
                    frame=frame_selector,
                    target_id=current_active_page_ref or "",
                )
            elif action == "read_dom":
                dom = await _run_node_json_command(
                    args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", "eval", "document.body.innerText.slice(0, 5000)"]
                )
                results.append({"step_index": idx, "command": action, "description": description, "status": "done", "data": dom.get("result", ""), "screenshot": ""})
                continue
            elif action == "snapshot":
                target = step.get("target")
                target_dict = target if isinstance(target, dict) else {}
                next_snapshot_format = (
                    str(target_dict.get("snapshotFormat", "") or "ai").strip().lower()
                    if "snapshotFormat" in target_dict
                    else current_observation_context.get("snapshotFormat", "ai")
                )
                next_scope_selector = (
                    str(target_dict.get("scopeSelector", "") or "").strip()
                    if "scopeSelector" in target_dict
                    else current_observation_context.get("scopeSelector", "")
                )
                next_frame = (
                    str(target_dict.get("frame", "") or "").strip()
                    if "frame" in target_dict
                    else current_observation_context.get("frame", "")
                )
                next_target_id = (
                    str(target_dict.get("targetId", "") or "").strip()
                    if "targetId" in target_dict
                    else str(current_active_page_ref or "")
                )
                current_observation_context = _merge_observation_context(
                    current_observation_context,
                    snapshot_format=next_snapshot_format,
                    scope_selector=next_scope_selector,
                    frame=next_frame,
                    target_id=next_target_id,
                )
                current_snapshot, current_snapshot_id = await _capture_agent_browser_snapshot(
                    session_name=session_name,
                    page_registry=current_page_registry,
                    active_page_ref=current_active_page_ref,
                    snapshot_format=current_observation_context.get("snapshotFormat", "ai"),
                    scope_selector=current_observation_context.get("scopeSelector", "") or None,
                    frame=current_observation_context.get("frame", "") or None,
                )
                current_observation_context = _observation_context_from_snapshot(
                    current_snapshot,
                    fallback_target_id=current_active_page_ref,
                )
                snapshot_dirty = False
                results.append({"step_index": idx, "command": action, "description": description, "status": "done", "data": current_snapshot, "screenshot": ""})
                continue
            elif action == "extract_structured":
                structured = await _run_node_json_command(
                    args=[
                        str(_AGENT_BROWSER_CLI),
                        "--session",
                        session_name,
                        "--json",
                        "eval",
                        """(() => {
                          const elements = [];
                          const interactable = document.querySelectorAll("a, button, input, select, textarea, [role='button'], [role='link'], [role='textbox'], [role='combobox'], [onclick]");
                          interactable.forEach((el, idx) => {
                            if (idx > 200) return;
                            const rect = el.getBoundingClientRect();
                            const visible = rect.width > 0 && rect.height > 0;
                            if (!visible && el.tagName !== 'BODY') return;
                            elements.push({
                              tag: el.tagName.toLowerCase(),
                              role: el.getAttribute('role') || '',
                              type: el.type || '',
                              text: (el.textContent || '').trim().substring(0, 100),
                              ariaLabel: el.getAttribute('aria-label') || '',
                              placeholder: el.getAttribute('placeholder') || '',
                              href: el.href || '',
                              name: el.getAttribute('name') || '',
                              id: el.id || '',
                              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
                              visible
                            });
                          });
                          return {
                            url: location.href,
                            title: document.title,
                            elements,
                            viewport: { w: innerWidth, h: innerHeight },
                            scrollY
                          };
                        })()""",
                    ]
                )
                results.append({"step_index": idx, "command": action, "description": description, "status": "done", "data": structured.get("result", {}), "screenshot": ""})
                continue
            elif action == "diagnostics":
                diagnostics = await _capture_agent_browser_diagnostics(session_name=session_name)
                results.append({"step_index": idx, "command": action, "description": description, "status": "done", "data": diagnostics, "screenshot": ""})
                continue
            elif action == "scan_ui_blockers":
                diagnostics = await _capture_agent_browser_diagnostics(session_name=session_name)
                blockers = diagnostics.get("dom", {}) if isinstance(diagnostics.get("dom"), dict) else {}
                results.append({"step_index": idx, "command": action, "description": description, "status": "done", "data": blockers, "screenshot": ""})
                continue
            elif action == "highlight":
                target = step.get("target")
                if target in (None, "", {}):
                    raise RuntimeError("Highlight action requires a target.")
                if not _is_agent_browser_target_action_supported(target, "highlight"):
                    raise RuntimeError("target-action-incompatible: highlight")
                command = _target_to_agent_browser_command(target, "highlight")
                highlighted = await _run_node_json_command(
                    args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", *command]
                )
                results.append({"step_index": idx, "command": action, "description": description, "status": "done", "data": highlighted, "screenshot": ""})
                continue
            elif action == "screenshot":
                pass
            else:
                raise RuntimeError(f"Unsupported browser session action: {action}")

            if _should_capture_post_step_snapshot(step):
                post_step_snapshot, post_step_snapshot_id = await _capture_agent_browser_snapshot(
                    session_name=session_name,
                    page_registry=current_page_registry,
                    active_page_ref=current_active_page_ref,
                    snapshot_format=current_observation_context.get("snapshotFormat", "ai"),
                    scope_selector=current_observation_context.get("scopeSelector", "") or None,
                    frame=current_observation_context.get("frame", "") or None,
                )
                current_snapshot = post_step_snapshot
                current_snapshot_id = post_step_snapshot_id
                current_observation_context = _observation_context_from_snapshot(
                    post_step_snapshot,
                    fallback_target_id=current_active_page_ref,
                )
                snapshot_dirty = False

            await _verify_step_postconditions(
                session_name=session_name,
                step=step,
                post_step_snapshot=post_step_snapshot,
            )

            current_page_registry, current_active_page_ref, discovered_pages = await _sync_page_registry_over_cdp(
                cdp_url=cdp_url,
                step=step,
                page_registry=current_page_registry,
                active_page_ref=current_active_page_ref,
            )
            results.append({
                "step_index": idx,
                "command": action,
                "description": description,
                "status": "done",
                "data": "ok",
                "screenshot": screenshot,
                "page_ref": current_active_page_ref,
                "metadata": {
                    "new_page_refs": discovered_pages,
                    "snapshot_id": current_snapshot_id,
                    "post_step_snapshot": post_step_snapshot,
                    "post_step_snapshot_id": post_step_snapshot_id,
                    "observation_context": dict(current_observation_context),
                },
            })
            if _action_mutates_page(action):
                snapshot_dirty = post_step_snapshot is None
        except Exception as exc:
            results.append({"step_index": idx, "command": action, "description": description, "status": "error", "data": str(exc), "screenshot": screenshot, "page_ref": current_active_page_ref})
            return ToolResult(
                success=False,
                data=results,
                error=f"Step {idx} failed: {exc}",
                metadata={
                    "last_screenshot": last_screenshot,
                    "page_registry": current_page_registry,
                    "active_page_ref": current_active_page_ref,
                    "new_page_refs": [],
                },
            )
    return ToolResult(
        success=True,
        data=results,
        text=f"Completed {len(results)} browser steps",
        metadata={
            "last_screenshot": last_screenshot,
            "page_registry": current_page_registry,
            "active_page_ref": current_active_page_ref,
            "new_page_refs": [],
        },
    )


async def _execute_browser_steps_with_engine(
    *,
    automation_engine: str,
    cdp_url: str,
    steps: list[dict[str, Any]],
    run_id: str,
    user_id: str,
    session_id: str,
    prompt: str = "",
    page_registry: dict[str, dict[str, Any]] | None = None,
    active_page_ref: str | None = None,
) -> ToolResult:
    if automation_runtime_enabled():
        try:
            result = await execute_browser_steps_via_runtime(
                run_id=run_id,
                session_id=session_id,
                user_id=user_id,
                prompt=prompt or f"Execute {len(steps)} browser step(s).",
                cdp_url=cdp_url,
                steps=steps,
                cwd=_runtime_workspace_dir(),
                page_registry=page_registry,
                active_page_ref=active_page_ref,
            )
            for event in list(result.metadata.get("runtime_events", []) or []):
                if not isinstance(event, dict):
                    continue
                event_type = str(event.get("type", "") or "")
                if event_type not in {"run.tool.started", "run.tool.finished", "run.browser.snapshot", "run.browser.action", "run.runtime_incident"}:
                    continue
                payload = event.get("payload")
                await publish_event(
                    user_id=user_id,
                    session_id=session_id,
                    run_id=run_id,
                    event_type=event_type,
                    payload=payload if isinstance(payload, dict) else {},
                )
            return result
        except Exception as exc:
            logger.warning(
                "automation_runtime_execution_failed_falling_back",
                extra={
                    "run_id": run_id,
                    "session_id": session_id,
                    "error": str(exc),
                },
            )
    _ = automation_engine
    return await _execute_browser_steps_with_agent_browser(
        cdp_url,
        steps,
        page_registry=page_registry,
        active_page_ref=active_page_ref,
    )


async def _update_plan_steps(plan_id: str, steps: list[AutomationStep]) -> AutomationPlan:
    raw_plan = await get_plan(plan_id)
    if raw_plan is None:
        raise RuntimeError("Plan not found during execution.")
    raw_plan["steps"] = [step.model_dump(mode="json") for step in steps]
    await save_plan(plan_id, raw_plan)
    return AutomationPlan.model_validate(raw_plan)


def _runtime_code_to_run_error(code: str, message: str) -> RunError:
    normalized = str(code or "").strip().upper() or "EXECUTION_FAILED"
    lowered = str(message or "").strip().lower()
    if normalized == "EXECUTION_FAILED":
        if "rate limit" in lowered:
            normalized = "MODEL_RATE_LIMIT"
        elif "temporarily overloaded" in lowered or "temporarily unavailable" in lowered:
            normalized = "MODEL_OVERLOADED"
        elif "timed out" in lowered or "timeout" in lowered:
            normalized = "MODEL_TIMEOUT"
    if normalized == "AUTH_REQUIRED":
        return RunError(code=normalized, message=message or "Authentication is required.", retryable=True)
    if normalized == "HUMAN_REQUIRED":
        return RunError(code=normalized, message=message or "Human intervention is required.", retryable=True)
    if normalized == "OBSERVATION_EXHAUSTED":
        return RunError(code=normalized, message=message or "Observation attempts were exhausted.", retryable=True)
    if normalized == "MODEL_RATE_LIMIT":
        return RunError(
            code=normalized,
            message=message or "The run is temporarily blocked by a model rate limit and needs a retry.",
            retryable=True,
        )
    if normalized == "MODEL_OVERLOADED":
        return RunError(
            code=normalized,
            message=message or "The run is temporarily blocked by provider overload and can be retried.",
            retryable=True,
        )
    if normalized == "MODEL_TIMEOUT":
        return RunError(
            code=normalized,
            message=message or "The run timed out while waiting for the model and can be retried.",
            retryable=True,
        )
    return RunError(code=normalized, message=message or "Automation runtime execution failed.", retryable=False)


def _terminal_runtime_incident_from_events(
    runtime_events: list[dict[str, Any]] | None,
) -> tuple[RunError, dict[str, Any]] | None:
    for event in reversed(list(runtime_events or [])):
        if not isinstance(event, dict):
            continue
        event_type = str(event.get("type", "") or event.get("event_type", "") or "").strip()
        if event_type != "run.runtime_incident":
            continue
        payload = event.get("payload", {}) if isinstance(event.get("payload"), dict) else {}
        code = str(payload.get("code", "") or "").strip().upper()
        reason = str(payload.get("reason", "") or payload.get("summary", "") or "").strip()
        phase = str(payload.get("phase", "") or "").strip().lower()
        replannable = bool(payload.get("replannable", False))
        if code in {"AUTH_REQUIRED", "HUMAN_REQUIRED"} or phase == "error" or not replannable:
            return _runtime_code_to_run_error(code, reason), payload
    return None


def _runtime_event_step_id(event: dict[str, Any], fallback_index: int) -> str:
    payload = event.get("payload", {}) if isinstance(event.get("payload"), dict) else {}
    return str(payload.get("stepId", "") or f"runtime_s{fallback_index + 1}")


def _runtime_event_to_step(
    *,
    event: dict[str, Any],
    fallback_index: int,
) -> AutomationStep:
    payload = event.get("payload", {}) if isinstance(event.get("payload"), dict) else {}
    step_id = _runtime_event_step_id(event, fallback_index)
    command = str(payload.get("command", "") or "unknown")
    description = str(payload.get("description", "") or command or "Runtime browser step")
    target = payload.get("target")
    return AutomationStep(
        step_id=step_id,
        label=description,
        description=description,
        command_payload=AgentBrowserStep(
            id=step_id,
            command=command,
            description=description,
            target=target if isinstance(target, (dict, str)) else None,
            value=payload.get("value"),
        ),
        status="pending",
    )


async def _apply_runtime_step_event(
    *,
    plan: AutomationPlan,
    event: dict[str, Any],
) -> AutomationPlan:
    event_type = str(event.get("type", "") or "")
    if event_type not in {"step.started", "step.completed", "step.failed"}:
        return plan
    rows = list(plan.steps)
    payload = event.get("payload", {}) if isinstance(event.get("payload"), dict) else {}
    step_id = _runtime_event_step_id(event, len(rows))
    step_index = next((index for index, row in enumerate(rows) if row.step_id == step_id), -1)
    if step_index < 0:
        rows.append(_runtime_event_to_step(event=event, fallback_index=len(rows)))
        step_index = len(rows) - 1
    current = rows[step_index]
    status = "running" if event_type == "step.started" else "completed" if event_type == "step.completed" else "failed"
    updated = current.model_copy(
        update={
            "status": status,
            "started_at": _now_iso() if event_type == "step.started" else current.started_at,
            "completed_at": _now_iso() if event_type in {"step.completed", "step.failed"} else current.completed_at,
            "error_message": str(payload.get("error", "") or current.error_message or "") or None,
            "error_code": str(payload.get("code", "") or current.error_code or "") or None,
        }
    )
    rows[step_index] = updated
    return await _update_plan_steps(plan.plan_id, rows)


async def _execute_run_via_automation_runtime(
    *,
    run_id: str,
    user_id: str,
    session_id: str,
    run: AutomationRun,
    plan: AutomationPlan,
    prompt: str,
    cdp_url: str,
) -> None:
    await _set_run_state(run_id, "running")
    backend_terminal_runtime_incident: tuple[RunError, dict[str, Any]] | None = None
    runtime_locally_terminated = False
    runtime_progress_tracker = (
        run.progress_tracker.model_dump(mode="json")
        if hasattr(run.progress_tracker, "model_dump")
        else dict(run.progress_tracker or {})
    )
    runtime_observation: dict[str, Any] = {
        "url": run.page_registry.get(run.active_page_ref or "", {}).get("url") if isinstance(run.page_registry, dict) else None,
        "title": run.page_registry.get(run.active_page_ref or "", {}).get("title") if isinstance(run.page_registry, dict) else None,
        "targetId": run.active_page_ref,
        "snapshot_text": None,
    }

    async def on_runtime_event(event: dict[str, Any]) -> None:
        nonlocal plan, runtime_progress_tracker, runtime_observation, backend_terminal_runtime_incident, runtime_locally_terminated
        event_type = str(event.get("type", "") or "")
        payload = event.get("payload", {}) if isinstance(event.get("payload"), dict) else {}
        current_run = await get_run(run_id)
        if current_run and is_terminal_state(str(current_run.get("state", "") or "")):
            runtime_locally_terminated = True
            return
        current_progress = {}
        if current_run and isinstance(current_run.get("execution_progress", {}), dict):
            current_progress = dict(current_run.get("execution_progress", {}) or {})
        if event_type in {
            "run.thinking",
            "run.log",
            "run.tool.started",
            "run.tool.finished",
            "run.browser.snapshot",
            "run.browser.action",
            "run.runtime_incident",
        }:
            await publish_event(
                user_id=user_id,
                session_id=session_id,
                run_id=run_id,
                event_type=event_type,
                payload=payload,
            )
        if event_type == "run.thinking":
            summary = str(payload.get("summary", "") or "").strip()
            sanitized_summary = _sanitize_runtime_user_message({"source": "run.thinking", "message": summary}) if summary else None
            if sanitized_summary:
                current_progress["status_summary"] = sanitized_summary
                await update_run(run_id, {"execution_progress": current_progress, "updated_at": _now_iso()})
                await _publish_run_activity(
                    user_id=user_id,
                    session_id=session_id,
                    run_id=run_id,
                    summary=sanitized_summary,
                )
        elif event_type == "run.log":
            message = _sanitize_runtime_user_message(payload)
            if message:
                current_progress["status_summary"] = message
                recent_action_log = list(current_progress.get("recent_action_log", []) or [])[-24:]
                recent_action_log.append(
                    {
                        "step_id": str(event.get("seq", "")),
                        "command": "log",
                        "label": str(payload.get("source", "") or "runtime"),
                        "status": "completed",
                        "finished_at": _now_iso(),
                        "message": message,
                    }
                )
                current_progress["recent_action_log"] = recent_action_log
                await update_run(run_id, {"execution_progress": current_progress, "updated_at": _now_iso()})
                await _publish_run_activity(
                    user_id=user_id,
                    session_id=session_id,
                    run_id=run_id,
                    summary=message,
                )
        elif event_type == "run.tool.started":
            entry = _runtime_tool_progress_entry(payload=payload, status="running")
            current_progress["current_runtime_action"] = entry
            current_progress["status_summary"] = str(entry.get("message", "") or "")
            await update_run(run_id, {"execution_progress": current_progress, "updated_at": _now_iso()})
            await _publish_run_activity(
                user_id=user_id,
                session_id=session_id,
                run_id=run_id,
                summary=str(entry.get("message", "") or ""),
            )
        elif event_type == "run.tool.finished":
            tool_name = str(payload.get("toolName", "") or "").strip().lower()
            entry = _runtime_tool_progress_entry(
                payload=payload,
                status="failed" if bool(payload.get("isError", False)) else "completed",
            )
            recent_action_log = list(current_progress.get("recent_action_log", []) or [])[-24:]
            recent_action_log.append(entry)
            current_progress["current_runtime_action"] = None
            current_progress["recent_action_log"] = recent_action_log
            current_progress["status_summary"] = str(entry.get("message", "") or "")
            run_patch: dict[str, Any] = {"execution_progress": current_progress, "updated_at": _now_iso()}
            if tool_name == "browser":
                runtime_observation = _runtime_browser_observation_from_payload(payload, runtime_observation)
                runtime_progress_tracker, tracker_incident = _track_runtime_event_progress(
                    tracker=runtime_progress_tracker,
                    payload=payload,
                    observation=runtime_observation,
                )
                runtime_progress_tracker, tracker_incident = _register_soft_runtime_incident(
                    tracker=runtime_progress_tracker,
                    incident=tracker_incident,
                )
                run_patch["progress_tracker"] = dict(runtime_progress_tracker)
                await update_run(run_id, run_patch)
                await _sync_run_phase_progress(
                    run_id=run_id,
                    plan=plan,
                    fallback_active_phase_index=current_run.get("active_phase_index") if isinstance(current_run, dict) else run.active_phase_index,
                    current_snapshot=_runtime_snapshot_payload(runtime_observation),
                    current_url=str(runtime_observation.get("url", "") or ""),
                    current_title=str(runtime_observation.get("title", "") or ""),
                    known_variables=current_run.get("known_variables", {}) if isinstance(current_run, dict) else run.known_variables,
                )
                if tracker_incident is not None:
                    current_progress["status_summary"] = (
                        "I’m still seeing the same page state, so I’m reassessing the next safe browser step."
                        if tracker_incident.replannable
                        else tracker_incident.summary
                    )
                    current_progress["recent_action_log"] = recent_action_log[-24:]
                    await update_run(
                        run_id,
                        {
                            "execution_progress": current_progress,
                            "progress_tracker": dict(runtime_progress_tracker),
                            "runtime_incident": tracker_incident.model_dump(mode="json"),
                            "updated_at": _now_iso(),
                        },
                    )
                    await _publish_run_activity(
                        user_id=user_id,
                        session_id=session_id,
                        run_id=run_id,
                        summary=str(current_progress.get("status_summary", "") or "") or tracker_incident.summary,
                        tone="warning" if tracker_incident.replannable else "danger",
                    )
                    await publish_event(
                        user_id=user_id,
                        session_id=session_id,
                        run_id=run_id,
                        event_type="run.runtime_incident",
                        payload=tracker_incident.model_dump(mode="json"),
                    )
                    if not tracker_incident.replannable:
                        terminal_error = RunError(
                            code=tracker_incident.code,
                            message=tracker_incident.summary,
                            retryable=False,
                        )
                        incident_payload = tracker_incident.model_dump(mode="json")
                        backend_terminal_runtime_incident = (terminal_error, incident_payload)
                        await _set_run_state(run_id, "failed", terminal_error)
                        await publish_event(
                            user_id=user_id,
                            session_id=session_id,
                            run_id=run_id,
                            event_type="run.failed",
                            payload={
                                "run_id": run_id,
                                "error": terminal_error.message,
                                "code": terminal_error.code,
                                "incident": incident_payload,
                            },
                        )
                        runtime_locally_terminated = True
            else:
                await update_run(run_id, run_patch)
            await _publish_run_activity(
                user_id=user_id,
                session_id=session_id,
                run_id=run_id,
                summary=str(entry.get("message", "") or ""),
                tone="danger" if entry.get("status") == "failed" else "neutral",
            )
        if event_type in {"step.started", "step.completed", "step.failed"}:
            plan = await _apply_runtime_step_event(plan=plan, event=event)
            await update_run(
                run_id,
                {
                    "total_steps": len(plan.steps),
                    "updated_at": _now_iso(),
                },
            )
            await publish_event(
                user_id=user_id,
                session_id=session_id,
                run_id=run_id,
                event_type=event_type,
                payload={
                    "run_id": run_id,
                    **payload,
                },
            )
            if event_type == "step.started":
                step_id = _runtime_event_step_id(event, len(plan.steps) - 1)
                index = next((idx for idx, row in enumerate(plan.steps) if row.step_id == step_id), None)
                await _update_run_progress(run_id, index)
        if event_type == "run.waiting_for_human":
            error = _runtime_code_to_run_error(str(payload.get("reasonCode", "") or "HUMAN_REQUIRED"), str(payload.get("reason", "") or "Human review required."))
            await _set_run_state(run_id, "waiting_for_human", error)
            await _publish_run_activity(
                user_id=user_id,
                session_id=session_id,
                run_id=run_id,
                summary=error.message,
                tone="warning",
            )
            await publish_event(
                user_id=user_id,
                session_id=session_id,
                run_id=run_id,
                event_type=event_type,
                payload={"run_id": run_id, **payload},
            )

    resolved_runtime_page_ref, _ = _resolve_runtime_target_page(
        page_registry=dict(run.page_registry or {}),
        active_page_ref=run.active_page_ref,
        target_app=plan.execution_contract.target_app if plan.execution_contract else None,
        goal_text=plan.summary,
    )
    await _prepare_runtime_browser_surface(
        run.browser_session_id,
        page_registry=dict(run.page_registry or {}),
        active_page_ref=resolved_runtime_page_ref or run.active_page_ref,
        target_app=plan.execution_contract.target_app if plan.execution_contract else None,
        goal_text=plan.summary,
    )
    result = await execute_browser_prompt_via_runtime(
        run_id=run_id,
        session_id=session_id,
        user_id=user_id,
        prompt=prompt,
        browser_session_id=run.browser_session_id,
        cdp_url=cdp_url,
        timezone="UTC",
        locale="en-US",
        cwd=_runtime_workspace_dir(),
        goal_hints={
            "taskMode": "browser_automation",
            "app": plan.execution_contract.target_app if plan.execution_contract else None,
            "entities": dict(plan.execution_contract.target_entities) if plan.execution_contract else {},
            "executionContract": _planner_execution_contract_payload(plan, run),
            "predictedPlan": plan.predicted_plan.model_dump(mode="json") if plan.predicted_plan else None,
        },
        resume=run.resume_context.model_dump(mode="json") if run.resume_context else None,
        page_registry=dict(run.page_registry or {}),
        active_page_ref=resolved_runtime_page_ref or run.active_page_ref,
        on_event=on_runtime_event,
    )
    current_run = await get_run(run_id)
    if runtime_locally_terminated or (current_run and is_terminal_state(str(current_run.get("state", "") or ""))):
        return

    runtime_result = result.get("result", {}) if isinstance(result.get("result", {}), dict) else {}
    runtime_rows = list(runtime_result.get("rows", []) or []) if isinstance(runtime_result, dict) else []
    runtime_text = "\n\n".join(
        str(row.get("text", "") or "").strip()
        for row in runtime_rows
        if isinstance(row, dict) and str(row.get("text", "") or "").strip()
    ).strip()
    runtime_error = str(result.get("error", "") or "")
    runtime_code = str(result.get("code", "") or "")
    if backend_terminal_runtime_incident is not None and not runtime_error:
        runtime_error = backend_terminal_runtime_incident[0].message
        runtime_code = backend_terminal_runtime_incident[0].code
    refreshed_run = run
    latest_run_row = await get_run(run_id)
    if latest_run_row is not None:
        try:
            refreshed_run, _ = await _refresh_run_browser_context_from_live_session(
                run_id=run_id,
                run=AutomationRun.model_validate(latest_run_row),
            )
        except Exception:
            logger.exception("automation_runtime_terminal_context_refresh_failed", extra={"run_id": run_id})
    runtime_failure_verified_complete = False
    if runtime_error:
        runtime_failure_verified_complete = await _runtime_failure_resolved_by_live_verification(
            run_id=run_id,
            cdp_url=cdp_url,
            plan=plan,
            page_registry=dict(refreshed_run.page_registry or {}),
            active_page_ref=refreshed_run.active_page_ref,
            runtime_observation=runtime_observation,
            runtime_text=runtime_text,
            runtime_error=runtime_error,
        )
    if runtime_error and not runtime_failure_verified_complete:
        error = _runtime_code_to_run_error(runtime_code, runtime_error)
        if runtime_code in {"AUTH_REQUIRED", "HUMAN_REQUIRED"}:
            await _set_run_state(run_id, "waiting_for_human", error)
            await _publish_run_activity(
                user_id=user_id,
                session_id=session_id,
                run_id=run_id,
                summary=runtime_error,
                tone="warning",
            )
            await publish_event(
                user_id=user_id,
                session_id=session_id,
                run_id=run_id,
                event_type="run.waiting_for_human",
                payload={
                    "run_id": run_id,
                    "reason": runtime_error,
                    "reasonCode": runtime_code or error.code,
                    "result": result.get("result", {}),
                },
            )
            return
        await _set_run_state(run_id, "failed", error)
        await _publish_run_activity(
            user_id=user_id,
            session_id=session_id,
            run_id=run_id,
            summary=runtime_error,
            tone="danger",
        )
        await publish_event(
            user_id=user_id,
            session_id=session_id,
            run_id=run_id,
            event_type="run.failed",
            payload={
                "run_id": run_id,
                "error": runtime_error,
                "code": runtime_code or error.code,
                "result": result.get("result", {}),
            },
        )
        return
    terminal_runtime_incident = _terminal_runtime_incident_from_events(
        list(result.get("runtime_events", []) or []),
    )
    if runtime_failure_verified_complete:
        terminal_runtime_incident = None
    if terminal_runtime_incident is None and backend_terminal_runtime_incident is not None:
        terminal_runtime_incident = backend_terminal_runtime_incident
    if terminal_runtime_incident is not None:
        error, incident_payload = terminal_runtime_incident
        current_run = await get_run(run_id)
        current_progress = (
            dict(current_run.get("execution_progress", {}) or {})
            if current_run and isinstance(current_run.get("execution_progress", {}), dict)
            else {}
        )
        current_progress["current_runtime_action"] = None
        current_progress["status_summary"] = error.message
        await update_run(
            run_id,
            {
                "execution_progress": current_progress,
                "runtime_incident": incident_payload,
                "updated_at": _now_iso(),
            },
        )
        target_state = "waiting_for_human" if error.code in {"AUTH_REQUIRED", "HUMAN_REQUIRED"} else "failed"
        await _set_run_state(run_id, target_state, error)
        await _publish_run_activity(
            user_id=user_id,
            session_id=session_id,
            run_id=run_id,
            summary=error.message,
            tone="warning" if target_state == "waiting_for_human" else "danger",
        )
        await publish_event(
            user_id=user_id,
            session_id=session_id,
            run_id=run_id,
            event_type="run.waiting_for_human" if target_state == "waiting_for_human" else "run.failed",
            payload={
                "run_id": run_id,
                "error": error.message,
                "code": error.code,
                "incident": incident_payload,
                "result": result.get("result", {}),
            },
        )
        return
    runtime_step_events = [
        event
        for event in list(result.get("runtime_events", []) or [])
        if isinstance(event, dict) and str(event.get("type", "") or "") in {"step.started", "step.completed", "step.failed"}
    ]
    terminal_completion_verification = await _verify_runtime_completion_against_browser_state(
        cdp_url=cdp_url,
        plan=plan,
        page_registry=dict(refreshed_run.page_registry or {}),
        active_page_ref=refreshed_run.active_page_ref,
        runtime_observation=runtime_observation,
        runtime_text=runtime_text,
    )
    if terminal_completion_verification is not None:
        error, incident_payload = terminal_completion_verification
        current_run = await get_run(run_id)
        current_progress = (
            dict(current_run.get("execution_progress", {}) or {})
            if current_run and isinstance(current_run.get("execution_progress", {}), dict)
            else {}
        )
        current_progress["current_runtime_action"] = None
        current_progress["status_summary"] = error.message
        await update_run(
            run_id,
            {
                "execution_progress": current_progress,
                "runtime_incident": incident_payload,
                "updated_at": _now_iso(),
            },
        )
        await _set_run_state(run_id, "failed", error)
        await publish_event(
            user_id=user_id,
            session_id=session_id,
            run_id=run_id,
            event_type="run.failed",
            payload={
                "run_id": run_id,
                "error": error.message,
                "code": error.code,
                "incident": incident_payload,
                "result": result.get("result", {}),
            },
        )
        return
    await _update_run_progress(run_id, len(plan.steps) - 1 if plan.steps else None)
    await _set_run_state(run_id, "completed")
    active_entry = dict(refreshed_run.page_registry.get(refreshed_run.active_page_ref or "", {}) or {})
    await _sync_run_phase_progress(
        run_id=run_id,
        plan=plan,
        fallback_active_phase_index=None,
        current_snapshot=_runtime_snapshot_payload(runtime_observation),
        current_url=str(active_entry.get("url", "") or runtime_observation.get("url", "") or ""),
        current_title=str(active_entry.get("title", "") or runtime_observation.get("title", "") or ""),
        known_variables=refreshed_run.known_variables,
    )
    await publish_event(
        user_id=user_id,
        session_id=session_id,
        run_id=run_id,
        event_type="run.completed",
        payload={
            "run_id": run_id,
            "result": result.get("result", {}),
            **(compose_completion_payload(runtime_text) if runtime_text else {}),
        },
    )


async def _set_run_state(run_id: str, state: str, error: RunError | None = None) -> AutomationRun:
    current = await get_run(run_id)
    previous_state = _coerce_run_state(str((current or {}).get("state", "") or "") or None)
    next_state = _coerce_run_state(state)
    if next_state is None:
        raise RuntimeError(f"Unknown run state: {state}")
    updated = await update_run(
        run_id,
        {
            "state": state,
            "updated_at": _now_iso(),
            "last_error": error.model_dump(mode="json") if error else None,
        },
    )
    if updated is None:
        raise RuntimeError("Run not found during execution.")
    if previous_state != state:
        await _record_transition(
            run_id=run_id,
            from_state=previous_state,
            to_state=next_state,
            reason_code=f"STATE_{state.upper()}",
            reason_text=error.message if error else "",
        )
    _log_workflow_trace(
        "automation_run_state_changed",
        run_id=run_id,
        previous_state=previous_state or "",
        next_state=state,
        error_code=error.code if error else "",
        error_message=_truncate_log_value(error.message if error else ""),
    )
    return AutomationRun.model_validate(updated)


async def _update_run_progress(run_id: str, index: int | None) -> AutomationRun:
    updated = await update_run(
        run_id,
        {
            "current_step_index": index,
            "updated_at": _now_iso(),
        },
    )
    if updated is None:
        raise RuntimeError("Run not found during execution.")
    _log_workflow_trace(
        "automation_run_progress_updated",
        run_id=run_id,
        current_step_index=index if index is not None else -1,
    )
    return AutomationRun.model_validate(updated)


def _materialize_step_output_value(raw_data: Any) -> Any | None:
    if raw_data is None:
        return None
    if isinstance(raw_data, str):
        value = raw_data.strip()
        return value or None
    if isinstance(raw_data, (int, float, bool)):
        return raw_data
    if isinstance(raw_data, list):
        cleaned = [_materialize_step_output_value(item) for item in raw_data]
        cleaned = [item for item in cleaned if item not in (None, "", [], {})]
        return cleaned or None
    if isinstance(raw_data, dict):
        for key in ("text", "value", "content", "message", "result", "data"):
            if key in raw_data:
                nested = _materialize_step_output_value(raw_data.get(key))
                if nested is not None:
                    return nested
        compact = {str(key): value for key, value in raw_data.items() if value not in (None, "", [], {})}
        return compact or None
    return str(raw_data)


def _substitute_known_variables(raw_value: Any, known_variables: dict[str, Any]) -> Any:
    if isinstance(raw_value, str):
        value = raw_value
        for key, variable in known_variables.items():
            replacement = str(variable)
            value = value.replace(f"${{{key}}}", replacement)
            value = value.replace(f"{{{{{key}}}}}", replacement)
            value = value.replace(f"{{{{ {key} }}}}", replacement)
        return value
    if isinstance(raw_value, list):
        return [_substitute_known_variables(item, known_variables) for item in raw_value]
    if isinstance(raw_value, dict):
        return {key: _substitute_known_variables(value, known_variables) for key, value in raw_value.items()}
    return raw_value


def _resolve_step_known_variables(
    step: dict[str, Any],
    semantic_step: AutomationStep | None,
    known_variables: dict[str, Any],
) -> dict[str, Any]:
    resolved = cast(dict[str, Any], copy.deepcopy(step))
    resolved = cast(dict[str, Any], _substitute_known_variables(resolved, known_variables))
    if semantic_step is None or not semantic_step.consumes_keys:
        return resolved
    consumed_values = [
        known_variables[key]
        for key in semantic_step.consumes_keys
        if key in known_variables and known_variables[key] not in (None, "", [], {})
    ]
    if not consumed_values:
        return resolved
    resolved_action = str(resolved.get("command", "") or resolved.get("action", "") or "").strip().lower()
    if resolved_action in {"type", "select", "keyboard", "act"} and resolved.get("value", None) in (None, ""):
        resolved["value"] = consumed_values[0] if len(consumed_values) == 1 else "\n".join(str(value) for value in consumed_values)
    return resolved


def _build_reconciliation_prompt(
    *,
    summary: str,
    current_url: str,
    current_title: str,
    current_step_index: int,
    remaining_steps: list[AutomationStep],
    open_pages: list[dict[str, Any]],
    known_variables: dict[str, Any],
    page_registry: dict[str, dict[str, Any]],
    active_page_ref: str | None,
    trigger_incident: RuntimeIncident | None,
) -> str:
    remaining_lines = [
        f"- {step.label}: {step.description or step.label}"
        for step in remaining_steps
    ]
    page_lines = [
        f"- {str(page.get('title', '') or 'Untitled')} | {str(page.get('url', '') or '')}"
        for page in open_pages[:8]
    ]
    page_ref_lines = [
        f"- {page_ref}: {str(entry.get('title', '') or 'Untitled')} | {str(entry.get('url', '') or '')}"
        for page_ref, entry in list(page_registry.items())[:12]
    ]
    parts = [
        "Resume this browser automation from the current live browser state.",
        f"Original user goal: {summary}",
        f"Current page: {current_title or 'Untitled'}",
        f"Current URL: {current_url or 'unknown'}",
        f"Current step index: {current_step_index}",
    ]
    if active_page_ref:
        parts.append(f"Current active page ref: {active_page_ref}")
    if trigger_incident is not None:
        parts.append("The resume was triggered by a runtime incident that changed the workflow:")
        parts.append(f"- Incident code: {trigger_incident.code}")
        parts.append(f"- Incident category: {trigger_incident.category}")
        parts.append(f"- Incident summary: {trigger_incident.summary}")
        if trigger_incident.details:
            parts.append(f"- Incident details: {trigger_incident.details}")
        if trigger_incident.browser_snapshot is not None:
            snapshot = trigger_incident.browser_snapshot
            parts.append(
                f"- Incident browser snapshot: {snapshot.title or 'Untitled'} | {snapshot.url or 'unknown'} | page_ref={str((snapshot.metadata or {}).get('page_ref', '') or snapshot.page_id or '')}"
            )
    if remaining_lines:
        parts.append("Previously planned remaining steps:")
        parts.extend(remaining_lines)
    if page_lines:
        parts.append("Open pages/tabs right now:")
        parts.extend(page_lines)
    if page_ref_lines:
        parts.append("Known page refs in the run:")
        parts.extend(page_ref_lines)
    if known_variables:
        parts.append("Known variables already captured during the run:")
        parts.extend([f"- {key}: {value}" for key, value in list(known_variables.items())[:10]])
    parts.append(
        "Replan only the remaining browser steps from the current UI state. "
        "Preserve the user's goal, skip obsolete steps, and continue from what is already visible."
    )
    return "\n".join(parts)


async def _reconcile_remaining_steps(
    *,
    run: AutomationRun,
    plan: AutomationPlan,
    cdp_url: str,
    known_variables: dict[str, Any],
) -> ResumeDecision:
    current_step_index = int(run.current_step_index or 0)
    remaining_steps = plan.steps[current_step_index:] if current_step_index < len(plan.steps) else []
    session_name = _agent_browser_session_name(cdp_url)
    await _run_node_json_command(args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", "connect", cdp_url])
    live_snapshot, _ = await _capture_agent_browser_snapshot(
        session_name=session_name,
        page_registry=dict(run.page_registry or {}),
        active_page_ref=run.active_page_ref,
    )
    current_url = str(live_snapshot.get("origin", "") or "")
    title_result = await _run_node_json_command(
        args=[str(_AGENT_BROWSER_CLI), "--session", session_name, "--json", "get", "title"]
    )
    current_title = str(title_result.get("title", "") or "")
    logger.info(
        "agent_browser_reconciliation_context",
        extra={
            "run_id": run.run_id,
            "session_name": session_name,
            "current_url": current_url,
            "current_title": current_title,
            "active_page_ref": run.active_page_ref,
            "snapshot_id": str(live_snapshot.get("snapshot_id", "") or ""),
            "ref_count": _count_snapshot_refs(live_snapshot),
            "remaining_step_count": len(remaining_steps),
        },
    )
    structured_context = None

    planning_prompt = _build_reconciliation_prompt(
        summary=plan.summary,
        current_url=current_url,
        current_title=current_title,
        current_step_index=current_step_index,
        remaining_steps=remaining_steps,
        open_pages=[
            {
                "page_ref": page_ref,
                "url": str(entry.get("url", "") or ""),
                "title": str(entry.get("title", "") or ""),
            }
            for page_ref, entry in list(dict(run.page_registry or {}).items())
        ],
        known_variables=known_variables,
        page_registry=dict(run.page_registry or {}),
        active_page_ref=run.active_page_ref,
        trigger_incident=run.resume_context.trigger_incident if run.resume_context else None,
    )
    logger.info(
        "agent_browser_reconciliation_planning_started",
        extra={
            "run_id": run.run_id,
            "session_name": session_name,
            "current_url": current_url,
            "current_title": current_title,
            "remaining_step_count": len(remaining_steps),
        },
    )
    runtime_action, _ = await _plan_next_runtime_action(
        planning_prompt=planning_prompt,
        plan=plan,
        run=run,
        current_url=current_url,
        current_title=current_title,
        page_snapshot=live_snapshot,
        structured_context=structured_context,
    )
    replanned_steps_raw = (
        [runtime_action.step.model_dump(mode="json", exclude_none=True)]
        if runtime_action.status == "action" and runtime_action.step is not None
        else []
    )
    replanned_steps = _steps_from_browser_plan(replanned_steps_raw)
    skipped_step_ids = [step.step_id for step in remaining_steps]
    decision_status = "replace_remaining_steps" if replanned_steps else "resume_existing"
    user_message = "I refreshed the browser state and updated the remaining workflow to match what is currently on screen."
    if runtime_action.status == "blocked" and runtime_action.block is not None:
        decision_status = "ask_user" if runtime_action.block.requires_user_reply else "cannot_resume"
        user_message = runtime_action.block.message
    return ResumeDecision(
        decision_id=str(uuid.uuid4()),
        status=decision_status,  # type: ignore[arg-type]
        rationale="The remaining workflow was replanned from the current live browser state after pause/human control.",
        user_message=user_message,
        completed_step_ids=[step.step_id for step in plan.steps[:current_step_index]],
        skipped_step_ids=skipped_step_ids if replanned_steps else [],
        updated_remaining_steps=replanned_steps if replanned_steps else remaining_steps,
        created_at=_now_iso(),
    )


async def _apply_resume_reconciliation(run_id: str) -> None:
    raw_run = await get_run(run_id)
    if raw_run is None:
        raise RuntimeError("Run not found.")
    run = AutomationRun.model_validate(raw_run)
    user_id = str(raw_run.get("user_id", "") or "")
    if run.state != "reconciling":
        return
    raw_plan = await get_plan(run.plan_id)
    if raw_plan is None:
        raise RuntimeError("Plan not found during reconciliation.")
    plan = AutomationPlan.model_validate(raw_plan)
    session_meta = await _browser_session_metadata(run.browser_session_id)
    run, session_meta = await _refresh_run_browser_context_from_live_session(
        run_id=run_id,
        run=run,
        session_row=session_meta,
    )
    metadata = session_meta.get("metadata", {}) if isinstance(session_meta, dict) else {}
    cdp_url = str(metadata.get("cdp_url", "") or "") if isinstance(metadata, dict) else ""
    current_index = run.current_step_index or 0
    known_variables = dict((run.known_variables if run.known_variables else {}) or {})
    known_variables.update(dict((run.resume_context.known_variables if run.resume_context else {}) or {}))
    for step in plan.steps[:current_index]:
        if step.output_key and step.output_key not in known_variables:
            known_variables[step.output_key] = f"from_step:{step.step_id}"
    try:
        decision = await _reconcile_remaining_steps(
            run=run,
            plan=plan,
            cdp_url=cdp_url,
            known_variables=known_variables,
        ) if cdp_url else ResumeDecision(
            decision_id=str(uuid.uuid4()),
            status="resume_existing",
            rationale="No live browser connection metadata was available during reconciliation, so the existing remaining plan was preserved.",
            user_message="I preserved the existing remaining workflow because a live browser snapshot was not available for replanning.",
            updated_remaining_steps=plan.steps[current_index:] if current_index < len(plan.steps) else [],
            created_at=_now_iso(),
        )
    except Exception as exc:
        decision = ResumeDecision(
            decision_id=str(uuid.uuid4()),
            status="resume_existing",
            rationale=f"Runtime reconciliation fell back to the existing remaining steps: {exc}",
            user_message="I could not fully replan from the current browser state, so I kept the existing remaining workflow.",
            updated_remaining_steps=plan.steps[current_index:] if current_index < len(plan.steps) else [],
            created_at=_now_iso(),
        )

    resume_context_payload = (
        run.resume_context.model_dump(mode="json")
        if run.resume_context
        else {
            "resume_id": str(uuid.uuid4()),
            "trigger": "executor_reconcile",
            "previous_state": "reconciling",
            "current_step_index": current_index,
            "current_plan_summary": plan.summary,
            "browser_snapshot": None,
            "trigger_incident": None,
            "known_variables": {},
            "recent_human_actions": [],
            "incident_id": None,
            "created_at": _now_iso(),
        }
    )
    resume_context_payload["known_variables"] = known_variables

    preserved_steps = plan.steps[:current_index] if current_index < len(plan.steps) else list(plan.steps)
    if decision.status == "replace_remaining_steps":
        updated_plan = await _update_plan_steps(plan.plan_id, preserved_steps + list(decision.updated_remaining_steps))
    else:
        updated_plan = plan
    updated = await update_run(
        run_id,
        {
            "state": "running",
            "updated_at": _now_iso(),
            "known_variables": known_variables,
            "resume_context": resume_context_payload,
            "resume_decision": decision.model_dump(mode="json"),
        },
    )
    if updated is None:
        raise RuntimeError("Run not found during reconciliation.")
    await _record_transition(
        run_id=run_id,
        from_state="reconciling",
        to_state="running",
        reason_code="STATE_RECONCILED",
        reason_text="Run resumed after current browser state was reconciled.",
    )
    await publish_event(
        user_id=user_id,
        session_id=run.session_id,
        run_id=run_id,
        event_type="run.reconciled",
        payload={
            "run_id": run_id,
            "resume_decision": decision.model_dump(mode="json"),
            "total_steps": len(updated_plan.steps),
        },
    )


async def _wait_if_paused_or_cancelled(run_id: str, session_id: str) -> bool:
    _ = session_id
    reconciled = False
    while True:
        raw_run = await get_run(run_id)
        if raw_run is None:
            raise RuntimeError("Run not found.")
        state = str(raw_run.get("state", ""))
        if state in {"paused", "waiting_for_human", "human_controlling"}:
            await asyncio.sleep(0.1)
            continue
        if state == "reconciling":
            await _apply_resume_reconciliation(run_id)
            reconciled = True
            continue
        if state in {"cancelled", "canceled"}:
            raise asyncio.CancelledError()
        return reconciled


async def _reload_execution_context_after_reconciliation(
    *,
    run_id: str,
    plan_id: str,
) -> tuple[AutomationRun, AutomationPlan]:
    raw_run = await get_run(run_id)
    if raw_run is None:
        raise RuntimeError("Run not found.")
    run = AutomationRun.model_validate(raw_run)
    raw_plan = await get_plan(plan_id)
    if raw_plan is None:
        raise RuntimeError("Plan not found during execution.")
    return run, AutomationPlan.model_validate(raw_plan)


async def _publish_step_event(
    *,
    user_id: str,
    session_id: str,
    run_id: str,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    await publish_event(user_id=user_id, session_id=session_id, run_id=run_id, event_type=event_type, payload=payload)


async def execute_run(run_id: str) -> None:
    raw_run = await get_run(run_id)
    if raw_run is None:
        return
    run = AutomationRun.model_validate(raw_run)
    user_id = str(raw_run.get("user_id", "") or "")
    raw_plan = await get_plan(run.plan_id)
    if raw_plan is None:
        await _set_run_state(
            run_id,
            "failed",
            RunError(code="PLAN_NOT_FOUND", message="Automation plan not found.", retryable=False),
        )
        return
    plan = AutomationPlan.model_validate(raw_plan)
    session_id = run.session_id

    try:
        _log_workflow_trace(
            "automation_run_execution_started",
            run_id=run_id,
            session_id=session_id,
            plan_id=run.plan_id,
            executor_mode=run.executor_mode,
            automation_engine=run.automation_engine,
            total_steps=len(plan.steps),
            current_state=run.state,
        )
        await publish_event(
            user_id=user_id,
            session_id=session_id,
            run_id=run_id,
            event_type="run.started",
            payload={"run_id": run_id},
        )
        run = await _set_run_state(run_id, "starting")

        session_meta = await _browser_session_metadata(run.browser_session_id)
        if session_meta is None and run.executor_mode in {"local_runner", "server_runner"}:
            resolved_session_id, resolved_session_meta = await _resolve_fallback_browser_session(
                user_id=user_id,
                executor_mode=run.executor_mode,
            )
            if resolved_session_id and resolved_session_meta is not None:
                logger.info(
                    "automation_run_browser_session_recovered",
                    extra={
                        "run_id": run_id,
                        "session_id": session_id,
                        "plan_id": run.plan_id,
                        "executor_mode": run.executor_mode,
                        "browser_session_id": resolved_session_id,
                    },
                )
                await update_run(
                    run_id,
                    {
                        "browser_session_id": resolved_session_id,
                        "updated_at": _now_iso(),
                    },
                )
                refreshed_run = await get_run(run_id)
                if refreshed_run is not None:
                    raw_run = refreshed_run
                    run = AutomationRun.model_validate(refreshed_run)
                session_meta = resolved_session_meta
        run, session_meta = await _refresh_run_browser_context_from_live_session(
            run_id=run_id,
            run=run,
            session_row=session_meta,
        )
        prompt = _build_runtime_prompt(
            base_prompt=str(plan.source_prompt or plan.summary or "").strip(),
            plan=plan,
            run=run,
        )
        metadata = session_meta.get("metadata", {}) if isinstance(session_meta, dict) else {}
        cdp_url = str(metadata.get("cdp_url", "") or "") if isinstance(metadata, dict) else ""
        automation_engine = "agent_browser"
        current_url = ""
        current_title = ""
        structured_context = None

        if run.executor_mode not in {"local_runner", "server_runner"} or not session_meta or not cdp_url:
            raise RuntimeError(
                "This run requires a browser session. Start or select a local/server runner session before running automation."
            )

        if not automation_runtime_enabled():
            raise RuntimeError(
                "Automation runtime is required for browser automation in this backend. Start automation-runtime and keep AUTOMATION_RUNTIME_ENABLED=true."
            )
        await _execute_run_via_automation_runtime(
            run_id=run_id,
            user_id=user_id,
            session_id=session_id,
            run=run,
            plan=plan,
            prompt=prompt,
            cdp_url=cdp_url,
        )
        return
    except asyncio.CancelledError:
        raw_run = await get_run(run_id)
        current_state = str((raw_run or {}).get("state", ""))
        if not is_terminal_state(current_state):
            await _set_run_state(run_id, "cancelled")
        _log_workflow_trace(
            "automation_run_execution_cancelled",
            run_id=run_id,
            session_id=session_id,
            plan_id=run.plan_id,
            current_state=current_state,
        )
        await publish_event(
            user_id=user_id,
            session_id=session_id,
            run_id=run_id,
            event_type="run.interrupted_by_user",
            payload={
                "run_id": run_id,
                **compose_cancellation_payload(),
            },
        )
        await _publish_run_activity(
            user_id=user_id,
            session_id=session_id,
            run_id=run_id,
            summary="The run was stopped.",
            tone="warning",
        )
    except Exception as exc:
        error = RunError(code="EXECUTION_FAILED", message=str(exc), retryable=True)
        logger.exception(
            "automation_run_execution_failed",
            extra={
                "run_id": run_id,
                "session_id": session_id,
                "plan_id": run.plan_id,
                "error_code": error.code,
                "error_message": _truncate_log_value(error.message, limit=240),
            },
        )
        await _set_run_state(run_id, "failed", error)
        await _publish_run_activity(
            user_id=user_id,
            session_id=session_id,
            run_id=run_id,
            summary=error.message,
            tone="danger",
        )
        await publish_event(
            user_id=user_id,
            session_id=session_id,
            run_id=run_id,
            event_type="run.failed",
            payload={"run_id": run_id, "code": error.code, "message": error.message, "retryable": error.retryable},
        )
    finally:
        async with _task_lock:
            _tasks.pop(run_id, None)


async def save_screenshot_artifact(run_id: str, step_id: str, screenshot_url: str) -> list[dict[str, Any]]:
    screenshot_url = str(screenshot_url or "").strip()
    if not screenshot_url:
        return await get_run_artifacts(run_id)
    artifacts = await get_run_artifacts(run_id)
    current_hash = _screenshot_hash(screenshot_url)
    if artifacts:
        last_artifact = artifacts[-1]
        last_hash = _screenshot_hash(str(last_artifact.get("url", "") or ""))
        if current_hash is not None and current_hash == last_hash:
            return artifacts
    artifacts.append(
        RunArtifact(
            artifact_id=f"{run_id}-{step_id}-{len(artifacts) + 1}",
            type="screenshot",
            url=screenshot_url,
            created_at=_now_iso(),
            step_id=step_id,
        ).model_dump(mode="json")
    )
    await save_artifacts(run_id, artifacts)
    return artifacts


async def save_incident_artifacts(
    *,
    run_id: str,
    incident: RuntimeIncident,
) -> list[dict[str, Any]]:
    browser_snapshot = incident.browser_snapshot
    screenshot_url = str((browser_snapshot.screenshot_url if browser_snapshot else "") or "")
    if not screenshot_url:
        return await get_run_artifacts(run_id)
    return await save_screenshot_artifact(run_id, f"incident:{incident.code.lower()}", screenshot_url)


async def get_run_artifacts(run_id: str) -> list[dict[str, Any]]:
    from oi_agent.automation.store import get_artifacts

    return await get_artifacts(run_id)


async def start_execution(run_id: str) -> None:
    async with _task_lock:
        if run_id in _tasks and not _tasks[run_id].done():
            return
        _tasks[run_id] = asyncio.create_task(execute_run(run_id))


async def cancel_execution(run_id: str) -> None:
    async with _task_lock:
        task = _tasks.get(run_id)
        if task and not task.done():
            task.cancel()


async def has_live_execution(run_id: str) -> bool:
    async with _task_lock:
        task = _tasks.get(run_id)
        return bool(task and not task.done())


async def reset_execution_tasks() -> None:
    async with _task_lock:
        tasks = list(_tasks.values())
        _tasks.clear()
    for task in tasks:
        if not task.done():
            task.cancel()
    for task in tasks:
        try:
            await task
        except BaseException:
            pass
