from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from oi_agent.api.browser.agent_utils import (
    check_media_playing,
    cleanup_paused_runs,
    friendly_browser_error,
    is_interactive_intent,
    is_media_intent,
    is_retriable_error,
    requires_user_intervention,
    store_paused_run,
)
from oi_agent.api.browser.common import (
    fetch_page_diagnostics,
    fetch_page_snapshot,
    fetch_page_screenshot,
    fetch_structured_page_context,
    fetch_ui_blockers,
    highlight_page_target,
    resolve_device_and_tab_for_prompt,
)
from oi_agent.api.browser.history_store import (
    create_navigator_run,
    delete_all_navigator_runs,
    delete_navigator_run,
    finalize_navigator_run,
    list_navigator_runs,
)
from oi_agent.api.browser.models import BrowserAgentPromptRequest, BrowserAgentResumeRequest
from oi_agent.api.browser.state import (
    ENABLE_ADAPTIVE_RECOVERY,
    PASSIVE_BROWSER_ACTIONS,
    PLAN_CACHE_TTL_SECONDS,
    STREAM_MAX_COMMAND_SECONDS,
    STREAM_MAX_PLANNER_SECONDS,
    STREAM_MAX_SECONDS,
    navigator_plan_cache,
    paused_navigator_runs,
)
from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.automation.models import (
    AutomationScheduleCreateRequest,
    ResolveExecutionSchedule,
)
from oi_agent.automation.schedule_service import (
    create_automation_schedule,
    delete_automation_schedule,
    list_automation_schedules,
)
from oi_agent.services.tools.tab_selector import select_best_attached_tab

logger = logging.getLogger(__name__)

agent_router = APIRouter()


class NavigatorScheduleCreateRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    device_id: str | None = None
    tab_id: int | None = None
    schedule_type: Literal["once", "interval"] = "once"
    run_at: str | None = None
    interval_seconds: int | None = Field(default=None, ge=30, le=7 * 24 * 3600)
    enabled: bool = True


def _truncate_log_value(value: Any, *, limit: int = 240) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return f"{text[: limit - 3]}..."


def _log_navigator_trace(event: str, **fields: Any) -> None:
    logger.info(event, extra=fields)


def _snapshot_is_sparse(snapshot: dict[str, Any] | None) -> bool:
    if not snapshot:
        return True
    try:
        ref_count = int(snapshot.get("refCount", 0) or 0)
    except Exception:
        ref_count = 0
    lines = str(snapshot.get("snapshot", "") or "").strip().splitlines()
    return ref_count <= 2 or len(lines) <= 1


def _step_fingerprint(step: dict[str, Any]) -> str:
    action = _step_action(step)
    kind = str(step.get("kind", "")).strip().lower()
    ref = str(step.get("ref", "")).strip().lower()
    target = json.dumps(step.get("target", ""), sort_keys=True, default=str)
    value = str(step.get("value", "")).strip()
    value_hash = hashlib.sha1(value.encode("utf-8")).hexdigest()[:10] if value else ""
    return "|".join((action, kind, ref, target, value_hash))


def _state_fingerprint(
    *,
    url: str,
    title: str,
    snapshot: dict[str, Any] | None,
    structured: dict[str, Any] | None,
) -> str:
    snap_ref_count = int((snapshot or {}).get("refCount", 0) or 0)
    snap_epoch = _snapshot_epoch(snapshot)
    structured_count = 0
    if isinstance(structured, dict):
        elements = structured.get("elements", [])
        if isinstance(elements, list):
            structured_count = len(elements)
    seed = "|".join(
        [
            (url or "").strip().lower()[:240],
            (title or "").strip().lower()[:180],
            snap_epoch,
            str(snap_ref_count),
            str(structured_count),
        ]
    )
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]


def _snapshot_epoch(snapshot: dict[str, Any] | None) -> str:
    if not isinstance(snapshot, dict):
        return ""
    explicit = str(snapshot.get("snapshot_id", "") or snapshot.get("snapshotId", "")).strip()
    if explicit:
        return explicit
    seed = "|".join(
        [
            str(snapshot.get("url", "") or ""),
            str(snapshot.get("title", "") or ""),
            str(snapshot.get("snapshot", "") or "")[:5000],
        ]
    )
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]


def _annotate_act_steps_snapshot_id(
    steps: list[dict[str, Any]],
    snapshot_epoch: str,
) -> list[dict[str, Any]]:
    if not snapshot_epoch:
        return steps
    out: list[dict[str, Any]] = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        row = dict(step)
        action = str(row.get("action", "") or row.get("command", "")).strip().lower()
        if action == "act" and not str(row.get("snapshot_id", "")).strip():
            row["snapshot_id"] = snapshot_epoch
        out.append(row)
    return out


def _step_action(step: dict[str, Any]) -> str:
    return str(step.get("action", "") or step.get("command", "")).strip().lower()


def _likely_overlay_scope(blockers: dict[str, Any] | None) -> str | None:
    if not isinstance(blockers, dict):
        return None
    blocker_class = str(blockers.get("blockerClass", "") or "").strip().lower()
    if blocker_class in {"modal_dialog", "cookie_banner", "onboarding_tour", "popover_menu", "unknown_overlay"}:
        return '[role="dialog"], [aria-modal="true"], dialog, .modal, [class*="modal"], .popup, [class*="popup"], .overlay, .backdrop, [class*="overlay"], [class*="backdrop"], [class*="scrim"]'
    return None


def _candidate_observation_scopes(
    *,
    failed_step: dict[str, Any] | None = None,
    blockers: dict[str, Any] | None = None,
    diagnostics: dict[str, Any] | None = None,
) -> list[str]:
    candidates: list[str] = []
    overlay_scope = _likely_overlay_scope(blockers)
    if overlay_scope:
        candidates.append(overlay_scope)

    dom = diagnostics.get("dom", {}) if isinstance(diagnostics, dict) and isinstance(diagnostics.get("dom"), dict) else {}
    dialog_count = int(dom.get("dialogCount", 0) or 0) if isinstance(dom, dict) else 0
    iframe_count = int(dom.get("iframeCount", 0) or 0) if isinstance(dom, dict) else 0
    overlay_count = int(dom.get("overlayCount", 0) or 0) if isinstance(dom, dict) else 0
    failed_text = " ".join(
        [
            str((failed_step or {}).get("description", "") or ""),
            str((failed_step or {}).get("command", "") or (failed_step or {}).get("action", "") or ""),
            str((failed_step or {}).get("target", "") or ""),
        ]
    ).lower()

    if dialog_count > 0 or overlay_count > 0 or any(token in failed_text for token in ("dialog", "modal", "popup", "drawer", "compose")):
        candidates.append('[role="dialog"], [aria-modal="true"], dialog, .modal, [class*="modal"], .drawer, [class*="drawer"], .popup, [class*="popup"]')
    if any(token in failed_text for token in ("menu", "listbox", "dropdown", "options", "suggestion")):
        candidates.append('[role="listbox"], [role="menu"], [role="tree"], .menu, [class*="menu"], .popover, [class*="popover"], .dropdown, [class*="dropdown"]')
    if iframe_count > 0:
        candidates.append("iframe")

    deduped: list[str] = []
    for candidate in candidates:
        if candidate and candidate not in deduped:
            deduped.append(candidate)
    return deduped


def _format_visual_fallback_step_data(
    *,
    message: str,
    confidence: float | None = None,
    verification_result: str | None = None,
) -> str:
    parts = [str(message or "").strip()]
    if confidence is not None and confidence > 0:
        parts.append(f"confidence {confidence:.2f}")
    if verification_result:
        parts.append(str(verification_result).strip())
    return " | ".join(part for part in parts if part)


def _cached_plan_get(cache_key: str) -> dict[str, Any] | None:
    now = time.time()
    row = navigator_plan_cache.get(cache_key)
    if not isinstance(row, dict):
        return None
    created = float(row.get("created_at", now))
    if now - created > PLAN_CACHE_TTL_SECONDS:
        navigator_plan_cache.pop(cache_key, None)
        return None
    plan = row.get("plan")
    return plan if isinstance(plan, dict) else None


def _cached_plan_set(cache_key: str, plan: dict[str, Any]) -> None:
    navigator_plan_cache[cache_key] = {
        "created_at": time.time(),
        "plan": plan,
    }


@agent_router.get("/browser/agent/history")
async def browser_agent_history(
    limit: int = Query(default=30, ge=1, le=100),
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    runs = await list_navigator_runs(user_id=user["uid"], limit=limit)
    return {"items": runs}


@agent_router.delete("/browser/agent/history/{run_id}")
async def browser_agent_delete_history_item(
    run_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    deleted = await delete_navigator_run(user_id=user["uid"], run_id=run_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Navigator run not found.")
    return {"ok": True, "run_id": run_id}


@agent_router.delete("/browser/agent/history")
async def browser_agent_delete_history_all(
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    deleted_count = await delete_all_navigator_runs(user_id=user["uid"])
    return {"ok": True, "deleted_count": deleted_count}


@agent_router.get("/browser/agent/schedules")
async def browser_agent_list_schedules(
    limit: int = Query(default=50, ge=1, le=200),
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    items = [
        {
            **row.model_dump(mode="json"),
            "source": "automation",
        }
        for row in await list_automation_schedules(user_id=user["uid"], limit=limit)
    ]
    return {"items": items}


@agent_router.post("/browser/agent/schedules")
async def browser_agent_create_schedule(
    payload: NavigatorScheduleCreateRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    schedule_type = payload.schedule_type
    if schedule_type == "once" and not payload.run_at:
        raise HTTPException(status_code=400, detail="run_at is required for once schedules.")
    if schedule_type == "interval" and not payload.interval_seconds:
        raise HTTPException(status_code=400, detail="interval_seconds is required for interval schedules.")
    schedule = await create_automation_schedule(
        user_id=user["uid"],
        payload=AutomationScheduleCreateRequest(
            session_id=f"browser-schedule:{str(uuid.uuid4())[:8]}",
            prompt=payload.prompt.strip(),
            execution_mode=schedule_type,
            schedule=ResolveExecutionSchedule(
                run_at=[payload.run_at] if payload.run_at else [],
                interval_seconds=payload.interval_seconds,
                timezone="UTC",
            ),
            device_id=payload.device_id,
            tab_id=payload.tab_id,
        ),
    )
    return {
        "ok": True,
        "schedule": {
            **schedule.model_dump(mode="json"),
            "source": "automation",
        },
    }


@agent_router.delete("/browser/agent/schedules/{schedule_id}")
async def browser_agent_delete_schedule(
    schedule_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    deleted = await delete_automation_schedule(user_id=user["uid"], schedule_id=schedule_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Schedule not found.")
    return {"ok": True, "schedule_id": schedule_id, "source": "automation"}


@agent_router.post("/browser/agent/plan")
async def browser_agent_plan(
    payload: BrowserAgentPromptRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user["uid"]
    from oi_agent.api.websocket import connection_manager
    from oi_agent.services.tools.navigator.prompt_rewriter import rewrite_user_prompt
    from oi_agent.services.tools.step_planner import plan_browser_steps

    explicit_device_id = payload.device_id
    device_id = payload.device_id or next(iter(connection_manager.get_extension_device_ids()), "")
    tab_id = payload.tab_id
    if device_id and connection_manager.has_attached_target(device_id) and tab_id is None:
        selected = select_best_attached_tab(
            prompt=payload.prompt,
            attached_rows=connection_manager.list_attached_targets(),
            preferred_device_id=explicit_device_id,
        )
        if selected:
            device_id, tab_id = selected
    target_url = ""
    page_title = ""
    if device_id and connection_manager.has_attached_target(device_id):
        attached = connection_manager.get_attached_target(device_id, tab_id) or {}
        target_url = attached.get("url", "") or ""
        page_title = attached.get("title", "") or ""

    rewritten_prompt = await rewrite_user_prompt(
        user_prompt=payload.prompt,
        current_url=target_url,
        current_page_title=page_title,
    )

    snapshot = await fetch_page_snapshot(device_id, tab_id, f"plan-{str(uuid.uuid4())[:8]}")
    structured_context = None
    if _snapshot_is_sparse(snapshot):
        structured_context = await fetch_structured_page_context(
            device_id,
            tab_id,
            f"plan-struct-{str(uuid.uuid4())[:8]}",
        )

    plan = await plan_browser_steps(
        user_prompt=rewritten_prompt,
        current_url=target_url,
        current_page_title=page_title,
        page_snapshot=snapshot,
        structured_context=structured_context,
    )
    return {
        "ok": True,
        "plan": plan,
        "selected_target": {"device_id": device_id, "tab_id": tab_id},
        "rewritten_prompt": rewritten_prompt,
    }


@agent_router.post("/browser/agent")
async def browser_agent_prompt(
    payload: BrowserAgentPromptRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    from oi_agent.api.websocket import connection_manager
    from oi_agent.services.tools.base import ToolContext
    from oi_agent.services.tools.browser_automation import BrowserAutomationTool  # type: ignore[import-untyped]
    from oi_agent.services.tools.navigator.prompt_rewriter import rewrite_user_prompt
    from oi_agent.services.tools.step_planner import plan_browser_steps

    device_id, tab_id = await resolve_device_and_tab_for_prompt(
        user_id=user["uid"],
        prompt=payload.prompt,
        device_id=payload.device_id,
        tab_id=payload.tab_id,
    )

    run_id = payload.run_id or f"agent-{str(uuid.uuid4())[:8]}"
    attached_target = connection_manager.get_attached_target(device_id, tab_id) or {}
    target_url = attached_target.get("url", "")
    page_title = attached_target.get("title", "")
    _log_navigator_trace(
        "navigator_prompt_received",
        run_id=run_id,
        user_id=user["uid"],
        device_id=device_id,
        tab_id=tab_id,
        prompt=_truncate_log_value(payload.prompt, limit=200),
        requested_device_id=payload.device_id,
        requested_tab_id=payload.tab_id,
        target_url=_truncate_log_value(target_url, limit=200),
        page_title=_truncate_log_value(page_title, limit=160),
        mode="sync",
    )
    rewritten_prompt = await rewrite_user_prompt(
        user_prompt=payload.prompt,
        current_url=target_url if isinstance(target_url, str) else "",
        current_page_title=page_title if isinstance(page_title, str) else "",
    )
    _log_navigator_trace(
        "navigator_prompt_rewritten",
        run_id=run_id,
        device_id=device_id,
        tab_id=tab_id,
        original_prompt=_truncate_log_value(payload.prompt, limit=200),
        rewritten_prompt=_truncate_log_value(rewritten_prompt, limit=200),
        mode="sync",
    )

    snapshot = await fetch_page_snapshot(device_id, tab_id, f"plan-{str(uuid.uuid4())[:8]}")
    snapshot_id = _snapshot_epoch(snapshot)
    structured_context = None
    _log_navigator_trace(
        "navigator_snapshot_captured",
        run_id=run_id,
        device_id=device_id,
        tab_id=tab_id,
        snapshot_id=snapshot_id,
        snapshot_ref_count=int((snapshot or {}).get("refCount", 0) or 0),
        snapshot_url=_truncate_log_value(str((snapshot or {}).get("url", "") or target_url), limit=200),
        mode="sync",
    )
    if _snapshot_is_sparse(snapshot):
        structured_context = await fetch_structured_page_context(
            device_id,
            tab_id,
            f"plan-struct-{str(uuid.uuid4())[:8]}",
        )
        _log_navigator_trace(
            "navigator_structured_context_captured",
            run_id=run_id,
            device_id=device_id,
            tab_id=tab_id,
            element_count=len(list((structured_context or {}).get("elements", []) or []))
            if isinstance(structured_context, dict)
            else 0,
            mode="sync",
        )

    _log_navigator_trace(
        "navigator_planning_started",
        run_id=run_id,
        device_id=device_id,
        tab_id=tab_id,
        prompt=_truncate_log_value(rewritten_prompt, limit=200),
        current_url=_truncate_log_value(target_url, limit=200),
        current_title=_truncate_log_value(page_title, limit=160),
        mode="sync",
    )
    plan = await plan_browser_steps(
        user_prompt=rewritten_prompt,
        current_url=target_url if isinstance(target_url, str) else "",
        current_page_title=page_title if isinstance(page_title, str) else "",
        page_snapshot=snapshot,
        structured_context=structured_context,
    )
    steps = plan.get("steps", [])
    browser_steps = [s for s in steps if s.get("type") == "browser"]
    browser_steps = _annotate_act_steps_snapshot_id(browser_steps, snapshot_id)
    consult_steps = [s for s in steps if s.get("type") == "consult"]
    _log_navigator_trace(
        "navigator_plan_ready",
        run_id=run_id,
        device_id=device_id,
        tab_id=tab_id,
        total_steps=len(steps),
        browser_steps=len(browser_steps),
        consult_steps=len(consult_steps),
        snapshot_id=snapshot_id,
        mode="sync",
    )
    if not steps:
        _log_navigator_trace(
            "navigator_plan_empty",
            run_id=run_id,
            device_id=device_id,
            tab_id=tab_id,
            mode="sync",
        )
        return {
            "ok": False,
            "run_id": run_id,
            "message": "I could not determine the browser actions needed. Try being more specific — e.g. 'click on Compose' or 'search for flights to Delhi'.",
            "plan": plan,
        }
    if not browser_steps and consult_steps:
        consult_msg = str(consult_steps[0].get("description") or consult_steps[0].get("reason") or "").strip()
        _log_navigator_trace(
            "navigator_consult_only_plan",
            run_id=run_id,
            device_id=device_id,
            tab_id=tab_id,
            message=_truncate_log_value(consult_msg, limit=200),
            mode="sync",
        )
        return {
            "ok": False,
            "run_id": run_id,
            "message": consult_msg or "The requested action cannot be completed automatically in the current tab context.",
            "plan": plan,
            "selected_target": {"device_id": device_id, "tab_id": tab_id},
        }

    context = ToolContext(
        automation_id=f"navigator-{run_id}",
        user_id=user["uid"],
        action_config={
            "type": "browser_automation",
            "device_id": device_id,
            "tab_id": tab_id,
            "run_id": run_id,
        },
        data_sources=[{"type": "url", "url": target_url}] if isinstance(target_url, str) and target_url else [],
        trigger_config={"type": "manual"},
        automation_name="Navigator Agent Action",
        automation_description=rewritten_prompt,
        execution_mode="autopilot",
    )

    browser_tool = BrowserAutomationTool()
    try:
        _log_navigator_trace(
            "navigator_execution_started",
            run_id=run_id,
            device_id=device_id,
            tab_id=tab_id,
            browser_steps=len(browser_steps),
            mode="sync",
        )
        result = await browser_tool.execute(context, [{"steps": browser_steps}])
    except Exception as exc:
        logger.exception("Browser agent execution failed: %s", exc)
        _log_navigator_trace(
            "navigator_execution_exception",
            run_id=run_id,
            device_id=device_id,
            tab_id=tab_id,
            error_message=_truncate_log_value(exc, limit=200),
            mode="sync",
        )
        raise HTTPException(status_code=500, detail=f"Agent execution error: {exc}") from exc

    if not result.success:
        _log_navigator_trace(
            "navigator_execution_failed",
            run_id=run_id,
            device_id=device_id,
            tab_id=tab_id,
            error_message=_truncate_log_value(result.error, limit=200),
            mode="sync",
        )
        raise HTTPException(status_code=409, detail=result.error or "Browser action failed")

    executed_steps = result.data if isinstance(result.data, list) else []
    _log_navigator_trace(
        "navigator_execution_completed",
        run_id=run_id,
        device_id=device_id,
        tab_id=tab_id,
        executed_steps=len(executed_steps),
        message=_truncate_log_value(result.text, limit=200),
        mode="sync",
    )

    return {
        "ok": True,
        "run_id": run_id,
        "message": result.text or "Action completed.",
        "plan": plan,
        "rewritten_prompt": rewritten_prompt,
        "steps_executed": result.data,
        "selected_target": {"device_id": device_id, "tab_id": tab_id},
    }


@agent_router.post("/browser/agent/stream")
async def browser_agent_stream(
    payload: BrowserAgentPromptRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> StreamingResponse:
    from oi_agent.api.websocket import connection_manager
    from oi_agent.services.tools.navigator.prompt_rewriter import rewrite_user_prompt
    from oi_agent.services.tools.step_planner import plan_browser_steps

    device_id, tab_id = await resolve_device_and_tab_for_prompt(
        user_id=user["uid"],
        prompt=payload.prompt,
        device_id=payload.device_id,
        tab_id=payload.tab_id,
    )

    run_id = payload.run_id or f"agent-{str(uuid.uuid4())[:8]}"
    attached_target = connection_manager.get_attached_target(device_id, tab_id) or {}
    target_url = str(attached_target.get("url", ""))
    page_title = str(attached_target.get("title", ""))
    rewritten_prompt = payload.prompt
    _log_navigator_trace(
        "navigator_prompt_received",
        run_id=run_id,
        user_id=user["uid"],
        device_id=device_id,
        tab_id=tab_id,
        prompt=_truncate_log_value(payload.prompt, limit=200),
        requested_device_id=payload.device_id,
        requested_tab_id=payload.tab_id,
        target_url=_truncate_log_value(target_url, limit=200),
        page_title=_truncate_log_value(page_title, limit=160),
        mode="stream",
    )

    async def event_stream():
        nonlocal rewritten_prompt

        def sse(data: dict) -> str:
            return f"data: {json.dumps(data)}\n\n"

        def status_event(phase: str, detail: str | None = None) -> dict[str, Any]:
            payload: dict[str, Any] = {"type": "status", "phase": phase, "run_id": run_id}
            if detail:
                payload["detail"] = detail
            if phase.startswith("visual_"):
                payload["execution_mode_detail"] = "visual_fallback"
            return payload

        stream_started = time.time()
        results: list[dict[str, Any]] = []
        finalized = False

        async def _finalize_run(
            *,
            status: str,
            message: str,
            requires_user_action: bool = False,
        ) -> None:
            nonlocal finalized
            if finalized:
                return
            finalized = True
            _log_navigator_trace(
                "navigator_run_finalizing",
                run_id=run_id,
                device_id=device_id,
                tab_id=tab_id,
                status=status,
                requires_user_action=requires_user_action,
                executed_steps=len(results),
                message=_truncate_log_value(message, limit=200),
                mode="stream",
            )
            await finalize_navigator_run(
                user_id=user["uid"],
                run_id=run_id,
                status=status,
                message=message,
                requires_user_action=requires_user_action,
                steps_executed=results,
            )

        async def _plan_with_timeout(
            *,
            prompt_text: str,
            url: str,
            title: str,
            snapshot_data: dict[str, Any] | None,
            structured_data: dict[str, Any] | None = None,
            completed_steps: list[str] | None = None,
            failed_step: dict[str, Any] | None = None,
            error_message: str | None = None,
            screenshot_data: str = "",
            diagnostics_data: dict[str, Any] | None = None,
        ) -> dict[str, Any]:
            _log_navigator_trace(
                "navigator_planning_started",
                run_id=run_id,
                device_id=device_id,
                tab_id=tab_id,
                prompt=_truncate_log_value(prompt_text, limit=200),
                current_url=_truncate_log_value(url, limit=200),
                current_title=_truncate_log_value(title, limit=160),
                snapshot_ref_count=int((snapshot_data or {}).get("refCount", 0) or 0),
                structured_element_count=len(list((structured_data or {}).get("elements", []) or []))
                if isinstance(structured_data, dict)
                else 0,
                completed_steps=len(completed_steps or []),
                failed_step_action=str((failed_step or {}).get("action", "") or ""),
                mode="stream",
            )
            return await asyncio.wait_for(
                plan_browser_steps(
                    user_prompt=prompt_text,
                    current_url=url,
                    current_page_title=title,
                    page_snapshot=snapshot_data,
                    structured_context=structured_data,
                    completed_steps=completed_steps,
                    failed_step=failed_step,
                    error_message=(
                        json.dumps({"error": error_message, "diagnostics": diagnostics_data or {}}, ensure_ascii=True)
                        if diagnostics_data
                        else error_message
                    ),
                    screenshot=screenshot_data,
                ),
                timeout=STREAM_MAX_PLANNER_SECONDS,
            )

        async def _attempt_visual_fallback(
            *,
            step_intent: str,
            failed_step: dict[str, Any] | None,
            step_index: int,
            total_steps: int,
            completed_steps: list[str],
            fallback_reason: str,
        ) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
            from oi_agent.services.tools.base import ToolContext
            from oi_agent.services.tools.navigator.visual_fallback import (
                attempt_visual_fallback,
            )

            recovery_context = ToolContext(
                automation_id=f"navigator-{run_id}",
                user_id=user["uid"],
                action_config={
                    "type": "browser_automation",
                    "device_id": device_id,
                    "tab_id": tab_id,
                    "run_id": run_id,
                },
                data_sources=[],
                trigger_config={"type": "manual"},
                automation_name="Navigator visual fallback",
                automation_description=rewritten_prompt,
                execution_mode="autopilot",
            )
            events: list[dict[str, Any]] = [status_event("visual_fallback_entered", fallback_reason)]
            visual_result = await attempt_visual_fallback(
                connection_manager=connection_manager,
                device_id=device_id,
                context=recovery_context,
                run_id=run_id,
                step_intent=step_intent,
                failed_step=failed_step,
                step_index=step_index,
                total_steps=total_steps,
                fetch_screenshot_basis=fetch_page_screenshot,
                fetch_structured_context=fetch_structured_page_context,
                completed_steps=completed_steps,
                fallback_reason=fallback_reason,
            )
            if visual_result is None:
                return None, events
            if visual_result.status == "done":
                events.append(status_event("visual_target_generated", visual_result.rationale))
                events.append(status_event("visual_action_executed", visual_result.data))
                return {
                    "status": "done",
                    "data": _format_visual_fallback_step_data(
                        message=visual_result.data,
                        confidence=visual_result.confidence,
                        verification_result=visual_result.verification_result,
                    ),
                    "screenshot": visual_result.screenshot,
                    "execution_mode_detail": visual_result.execution_mode_detail,
                    "fallback_confidence": visual_result.confidence,
                    "verification_result": visual_result.verification_result,
                }, events
            if visual_result.status == "manual":
                events.append(status_event("visual_verification_failed", visual_result.verification_result))
                return {
                    "status": "manual",
                    "data": visual_result.verification_result or visual_result.data,
                    "screenshot": visual_result.screenshot,
                    "execution_mode_detail": visual_result.execution_mode_detail,
                    "fallback_confidence": visual_result.confidence,
                    "verification_result": visual_result.verification_result,
                }, events
            events.append(status_event("visual_fallback_abandoned", visual_result.data))
            return {
                "status": "error",
                "data": visual_result.data,
                "screenshot": visual_result.screenshot,
                "execution_mode_detail": visual_result.execution_mode_detail,
                "fallback_confidence": visual_result.confidence,
                "verification_result": visual_result.verification_result,
            }, events

        async def _recover_with_observation_escalation(
            *,
            failed_step: dict[str, Any],
            error_message: str,
            completed_steps: list[str],
            step_index: int,
        ) -> list[dict[str, Any]]:
            blockers = await fetch_ui_blockers(device_id, tab_id, f"{run_id}-blockers-{step_index}")
            diagnostics = await fetch_page_diagnostics(device_id, tab_id, f"{run_id}-diagnostics-{step_index}")
            highlight_result: str | None = None
            target = failed_step.get("target")
            if target not in (None, "", {}):
                highlight_result = await highlight_page_target(
                    device_id,
                    tab_id,
                    f"{run_id}-highlight-{step_index}",
                    target=target,
                )
            observations: list[tuple[dict[str, Any] | None, dict[str, Any] | None, str]] = []

            fresh_snapshot = await fetch_page_snapshot(
                device_id,
                tab_id,
                f"{run_id}-recover-ai-{step_index}",
                target_id=f"tab:{tab_id}" if tab_id is not None else None,
            )
            fresh_structured = await fetch_structured_page_context(
                device_id,
                tab_id,
                f"{run_id}-recover-struct-{step_index}",
            ) if _snapshot_is_sparse(fresh_snapshot) else None
            observations.append((fresh_snapshot, fresh_structured, ""))

            for scope_selector in _candidate_observation_scopes(
                failed_step=failed_step,
                blockers=blockers,
                diagnostics=diagnostics,
            ):
                scoped_snapshot = await fetch_page_snapshot(
                    device_id,
                    tab_id,
                    f"{run_id}-recover-scoped-{step_index}",
                    scope_selector=scope_selector,
                    snapshot_format="ai",
                    target_id=f"tab:{tab_id}" if tab_id is not None else None,
                )
                observations.append((scoped_snapshot, fresh_structured, ""))

                if scope_selector == "iframe":
                    continue
                scoped_role = await fetch_page_snapshot(
                    device_id,
                    tab_id,
                    f"{run_id}-recover-role-{step_index}",
                    scope_selector=scope_selector,
                    snapshot_format="role",
                    target_id=f"tab:{tab_id}" if tab_id is not None else None,
                )
                observations.append((scoped_role, fresh_structured, ""))

                scoped_aria = await fetch_page_snapshot(
                    device_id,
                    tab_id,
                    f"{run_id}-recover-aria-{step_index}",
                    scope_selector=scope_selector,
                    snapshot_format="aria",
                    target_id=f"tab:{tab_id}" if tab_id is not None else None,
                )
                observations.append((scoped_aria, fresh_structured, ""))

            role_snapshot = await fetch_page_snapshot(
                device_id,
                tab_id,
                f"{run_id}-recover-role-{step_index}",
                snapshot_format="role",
                target_id=f"tab:{tab_id}" if tab_id is not None else None,
            )
            observations.append((role_snapshot, fresh_structured, ""))

            aria_snapshot = await fetch_page_snapshot(
                device_id,
                tab_id,
                f"{run_id}-recover-aria-{step_index}",
                snapshot_format="aria",
                target_id=f"tab:{tab_id}" if tab_id is not None else None,
            )
            observations.append((aria_snapshot, fresh_structured, ""))

            screenshot_payload = await fetch_page_screenshot(
                device_id,
                tab_id,
                f"{run_id}-recover-shot-{step_index}",
                annotated=True,
                target_id=f"tab:{tab_id}" if tab_id is not None else None,
            )
            screenshot_data = str((screenshot_payload or {}).get("screenshot", "") or "")

            for snapshot_data, structured_data, screenshot in observations:
                plan = await _plan_with_timeout(
                    prompt_text=rewritten_prompt,
                    url=str((snapshot_data or {}).get("url", "") or target_url),
                    title=str((snapshot_data or {}).get("title", "") or page_title),
                    snapshot_data=snapshot_data,
                    structured_data=structured_data,
                    completed_steps=completed_steps,
                    failed_step=failed_step,
                    error_message=error_message,
                    diagnostics_data={
                        "diagnostics": diagnostics or {},
                        "blockers": blockers or {},
                        "highlight": highlight_result or "",
                    },
                )
                candidate_steps = [
                    candidate
                    for candidate in list(plan.get("steps", []) or [])
                    if isinstance(candidate, dict) and candidate.get("type") == "browser"
                ]
                if candidate_steps:
                    return candidate_steps

            if screenshot_data:
                screenshot_plan = await _plan_with_timeout(
                    prompt_text=rewritten_prompt,
                    url=target_url,
                    title=page_title,
                    snapshot_data=fresh_snapshot,
                    structured_data=fresh_structured,
                    completed_steps=completed_steps,
                    failed_step=failed_step,
                    error_message=error_message,
                    screenshot_data=screenshot_data,
                    diagnostics_data={
                        "blockers": blockers or {},
                        "diagnostics": diagnostics or {},
                        "highlight": highlight_result or "",
                        "screenshot_present": True,
                    },
                )
                return [
                    candidate
                    for candidate in list(screenshot_plan.get("steps", []) or [])
                    if isinstance(candidate, dict) and candidate.get("type") == "browser"
                ]

            return []

        try:
            await create_navigator_run(
                user_id=user["uid"],
                run_id=run_id,
                prompt=payload.prompt,
                rewritten_prompt=rewritten_prompt,
                device_id=device_id,
                tab_id=tab_id,
                target_url=target_url,
                page_title=page_title,
            )
            _log_navigator_trace(
                "navigator_run_created",
                run_id=run_id,
                device_id=device_id,
                tab_id=tab_id,
                target_url=_truncate_log_value(target_url, limit=200),
                page_title=_truncate_log_value(page_title, limit=160),
                mode="stream",
            )
            yield sse({"type": "status", "phase": "rewriting_prompt", "run_id": run_id})
            try:
                rewritten_prompt = await asyncio.wait_for(
                    rewrite_user_prompt(
                        user_prompt=payload.prompt,
                        current_url=target_url,
                        current_page_title=page_title,
                    ),
                    timeout=STREAM_MAX_PLANNER_SECONDS,
                )
                _log_navigator_trace(
                    "navigator_prompt_rewritten",
                    run_id=run_id,
                    device_id=device_id,
                    tab_id=tab_id,
                    original_prompt=_truncate_log_value(payload.prompt, limit=200),
                    rewritten_prompt=_truncate_log_value(rewritten_prompt, limit=200),
                    mode="stream",
                )
            except TimeoutError:
                message = "Prompt rewrite timed out. Please retry."
                _log_navigator_trace(
                    "navigator_prompt_rewrite_timeout",
                    run_id=run_id,
                    device_id=device_id,
                    tab_id=tab_id,
                    prompt=_truncate_log_value(payload.prompt, limit=200),
                    mode="stream",
                )
                await _finalize_run(status="failed", message=message)
                yield sse(
                    {
                        "type": "done",
                        "ok": False,
                        "message": message,
                    }
                )
                return

            yield sse({"type": "status", "phase": "capturing_snapshot", "run_id": run_id})
            snapshot = await fetch_page_snapshot(device_id, tab_id, run_id)
            current_snapshot_epoch = _snapshot_epoch(snapshot)
            structured_context = None
            blocker_context = await fetch_ui_blockers(device_id, tab_id, f"{run_id}-initial-blockers")
            _log_navigator_trace(
                "navigator_snapshot_captured",
                run_id=run_id,
                device_id=device_id,
                tab_id=tab_id,
                snapshot_id=current_snapshot_epoch,
                snapshot_ref_count=int((snapshot or {}).get("refCount", 0) or 0),
                snapshot_url=_truncate_log_value(str((snapshot or {}).get("url", "") or target_url), limit=200),
                mode="stream",
            )
            if _snapshot_is_sparse(snapshot):
                yield sse({"type": "status", "phase": "extracting_context", "run_id": run_id})
                structured_context = await fetch_structured_page_context(
                    device_id,
                    tab_id,
                    f"{run_id}-struct",
                )
                _log_navigator_trace(
                    "navigator_structured_context_captured",
                    run_id=run_id,
                    device_id=device_id,
                    tab_id=tab_id,
                    element_count=len(list((structured_context or {}).get("elements", []) or []))
                    if isinstance(structured_context, dict)
                    else 0,
                    mode="stream",
                )

            scoped_selector = _likely_overlay_scope(blocker_context)
            if scoped_selector:
                scoped_snapshot = await fetch_page_snapshot(
                    device_id,
                    tab_id,
                    f"{run_id}-initial-scoped",
                    scope_selector=scoped_selector,
                    snapshot_format="ai",
                    target_id=f"tab:{tab_id}" if tab_id is not None else None,
                )
                if isinstance(scoped_snapshot, dict) and int(scoped_snapshot.get("refCount", 0) or 0) > 0:
                    snapshot = scoped_snapshot
                    current_snapshot_epoch = _snapshot_epoch(snapshot)

            yield sse({"type": "status", "phase": "planning", "run_id": run_id})
            fingerprint = _state_fingerprint(
                url=target_url,
                title=page_title,
                snapshot=snapshot,
                structured=structured_context,
            )
            prompt_key = hashlib.sha1(rewritten_prompt.strip().lower().encode("utf-8")).hexdigest()[:16]
            cache_key = f"{prompt_key}:{fingerprint}"
            plan = _cached_plan_get(cache_key)
            if plan:
                _log_navigator_trace(
                    "navigator_plan_cache_hit",
                    run_id=run_id,
                    device_id=device_id,
                    tab_id=tab_id,
                    cache_key=cache_key,
                    mode="stream",
                )
                yield sse({"type": "status", "phase": "planning_cache_hit", "run_id": run_id})
            else:
                try:
                    plan = await _plan_with_timeout(
                        prompt_text=rewritten_prompt,
                        url=target_url,
                        title=page_title,
                        snapshot_data=snapshot,
                        structured_data=structured_context,
                        completed_steps=[],
                    )
                    _cached_plan_set(cache_key, plan)
                    _log_navigator_trace(
                        "navigator_plan_generated",
                        run_id=run_id,
                        device_id=device_id,
                        tab_id=tab_id,
                        cache_key=cache_key,
                        total_steps=len(list(plan.get("steps", []) or [])),
                        mode="stream",
                    )
                except TimeoutError:
                    _log_navigator_trace(
                        "navigator_planning_timeout",
                        run_id=run_id,
                        device_id=device_id,
                        tab_id=tab_id,
                        cache_key=cache_key,
                        mode="stream",
                    )
                    timeout_recovery_steps = await _recover_with_observation_escalation(
                        failed_step={"type": "browser", "action": "snapshot", "description": rewritten_prompt},
                        error_message="planner_timeout",
                        completed_steps=[],
                        step_index=0,
                    )
                    plan = {
                        "status": "OK",
                        "summary": "Planner timed out; capture a fresh observation before deciding the next action.",
                        "steps": timeout_recovery_steps or [
                            {
                                "type": "browser",
                                "action": "snapshot",
                                "description": "Capture a fresh snapshot to recover planner timeout",
                                "target": {"snapshotFormat": "ai", "targetId": f"tab:{tab_id}" if tab_id is not None else None},
                            }
                        ],
                    }

            steps = plan.get("steps", [])
            browser_steps = [s for s in steps if s.get("type") == "browser"]
            consult_steps = [s for s in steps if s.get("type") == "consult"]
            browser_steps = _annotate_act_steps_snapshot_id(browser_steps, current_snapshot_epoch)
            steps = [
                _annotate_act_steps_snapshot_id([s], current_snapshot_epoch)[0]
                if isinstance(s, dict) and s.get("type") == "browser"
                else s
                for s in steps
            ]
            _log_navigator_trace(
                "navigator_plan_ready",
                run_id=run_id,
                device_id=device_id,
                tab_id=tab_id,
                total_steps=len(steps),
                browser_steps=len(browser_steps),
                consult_steps=len(consult_steps),
                snapshot_id=current_snapshot_epoch,
                mode="stream",
            )
            yield sse(
                {
                    "type": "planned",
                    "steps": steps,
                    "run_id": run_id,
                    "rewritten_prompt": rewritten_prompt,
                    "selected_target": {"device_id": device_id, "tab_id": tab_id},
                }
            )

            if not steps:
                message = "I could not determine the browser actions needed. Try being more specific."
                _log_navigator_trace(
                    "navigator_plan_empty",
                    run_id=run_id,
                    device_id=device_id,
                    tab_id=tab_id,
                    prompt=_truncate_log_value(rewritten_prompt, limit=200),
                    mode="stream",
                )
                await _finalize_run(status="failed", message=message)
                yield sse(
                    {
                        "type": "done",
                        "ok": False,
                        "message": message,
                    }
                )
                return
            if not browser_steps and consult_steps:
                consult_msg = str(consult_steps[0].get("description") or consult_steps[0].get("reason") or "").strip()
                message = consult_msg or "The requested action cannot be completed automatically in the current tab context."
                _log_navigator_trace(
                    "navigator_consult_only_plan",
                    run_id=run_id,
                    device_id=device_id,
                    tab_id=tab_id,
                    message=_truncate_log_value(message, limit=200),
                    mode="stream",
                )
                await _finalize_run(status="failed", message=message)
                yield sse(
                    {
                        "type": "done",
                        "ok": False,
                        "message": message,
                    }
                )
                return

            await connection_manager.send_to_device(
                device_id,
                {
                    "type": "start_screenshot_stream",
                    "payload": {"run_id": run_id, "interval_ms": 1500},
                },
            )

            completed_step_descriptions: list[str] = []
            completed_fingerprints: set[str] = set()
            global_step_idx = 0
            remaining_steps: list[dict[str, Any]] = list(browser_steps)

            try:
                while remaining_steps:
                    if time.time() - stream_started > STREAM_MAX_SECONDS:
                        message = "Navigator run timed out. Please retry."
                        await _finalize_run(status="failed", message=message)
                        yield sse(
                            {
                                "type": "done",
                                "ok": False,
                                "message": message,
                                "steps_executed": results,
                            }
                        )
                        return

                    step = remaining_steps.pop(0)
                    if step.get("type") != "browser":
                        continue

                    yield sse({"type": "step_start", "index": global_step_idx})

                    action_name = _step_action(step)
                    max_retries = 2 if action_name not in ("navigate", "open", "screenshot", "wait", "snapshot") else 0
                    result: dict[str, Any] = {}

                    for attempt in range(max_retries + 1):
                        cmd_id = str(uuid.uuid4())[:8]
                        action = action_name
                        if action == "act" and not str(step.get("snapshot_id", "")).strip() and current_snapshot_epoch:
                            step["snapshot_id"] = current_snapshot_epoch
                        if action == "act":
                            step_snapshot_id = str(step.get("snapshot_id", "")).strip()
                            if (
                                step_snapshot_id
                                and current_snapshot_epoch
                                and step_snapshot_id != current_snapshot_epoch
                            ):
                                result = {
                                    "status": "error",
                                    "data": (
                                        f"Stale ref snapshot_id '{step_snapshot_id}' "
                                        f"does not match current snapshot '{current_snapshot_epoch}'"
                                    ),
                                }
                                break

                        cmd_payload: dict[str, Any] = {
                            "cmd_id": cmd_id,
                            "run_id": run_id,
                            "action": action,
                            "step_index": global_step_idx,
                            "step_label": step.get("description", ""),
                            "total_steps": max(1, len(remaining_steps) + 1),
                        }

                        if action == "act":
                            cmd_payload["ref"] = step.get("ref", "")
                            cmd_payload["kind"] = step.get("kind", "")
                            cmd_payload["value"] = step.get("value", "")
                        else:
                            cmd_payload["target"] = step.get("target", "")
                            cmd_payload["value"] = step.get("value", "")
                            if isinstance(step.get("disambiguation"), dict):
                                cmd_payload["disambiguation"] = step.get("disambiguation")
                            target = step.get("target")
                            if action in {"snapshot", "screenshot"} and isinstance(target, dict):
                                if isinstance(target.get("snapshotFormat"), str):
                                    cmd_payload["snapshotFormat"] = target.get("snapshotFormat")
                                if isinstance(target.get("scopeSelector"), str):
                                    cmd_payload["scopeSelector"] = target.get("scopeSelector")
                                if isinstance(target.get("frame"), str):
                                    cmd_payload["frame"] = target.get("frame")
                                if isinstance(target.get("targetId"), str):
                                    cmd_payload["targetId"] = target.get("targetId")
                                if action == "screenshot" and "annotated" in target:
                                    cmd_payload["annotated"] = bool(target.get("annotated"))

                        command: dict[str, Any] = {
                            "type": "extension_command",
                            "payload": cmd_payload,
                            "timestamp": datetime.utcnow().isoformat(),
                        }
                        if tab_id is not None:
                            command["payload"]["tab_id"] = tab_id

                        timeout = 30.0
                        if action_name == "wait":
                            timeout = float(step.get("timeout", 15)) + 5
                        elif action == "navigate" or action == "open":
                            timeout = 100.0
                        elif action == "snapshot":
                            timeout = 20.0
                        timeout = max(5.0, min(timeout, STREAM_MAX_COMMAND_SECONDS))
                        _log_navigator_trace(
                            "navigator_step_dispatching",
                            run_id=run_id,
                            step_index=global_step_idx,
                            action=action,
                            attempt=attempt + 1,
                            timeout_seconds=timeout,
                            device_id=device_id,
                            tab_id=tab_id,
                            step_description=_truncate_log_value(step.get("description", ""), limit=160),
                            step_kind=str(step.get("kind", "") or ""),
                            step_ref=str(step.get("ref", "") or ""),
                            step_target=_truncate_log_value(step.get("target", ""), limit=160),
                            has_value=bool(str(step.get("value", "") or "")),
                            mode="stream",
                        )

                        result = await connection_manager.send_command_and_wait(
                            device_id, command, timeout=timeout
                        )
                        _log_navigator_trace(
                            "navigator_step_result",
                            run_id=run_id,
                            step_index=global_step_idx,
                            action=action,
                            attempt=attempt + 1,
                            status=str(result.get("status", "") or ""),
                            device_id=device_id,
                            tab_id=tab_id,
                            response_data=_truncate_log_value(result.get("data", ""), limit=200),
                            screenshot_captured=bool(str(result.get("screenshot", "") or "")),
                            mode="stream",
                        )

                        status = result.get("status", "error")
                        if status != "error" or not is_retriable_error(result.get("data", "")):
                            break
                        if attempt < max_retries:
                            latest_snapshot = await fetch_page_snapshot(
                                device_id,
                                tab_id,
                                f"{run_id}-retry-{global_step_idx}-{attempt + 1}",
                            )
                            current_snapshot_epoch = _snapshot_epoch(latest_snapshot) or current_snapshot_epoch
                            _log_navigator_trace(
                                "navigator_step_retry_scheduled",
                                run_id=run_id,
                                step_index=global_step_idx,
                                action=action,
                                next_attempt=attempt + 2,
                                snapshot_id=current_snapshot_epoch,
                                mode="stream",
                            )
                            await asyncio.sleep(2)

                    status = result.get("status", "error")

                    if (
                        ENABLE_ADAPTIVE_RECOVERY
                        and status == "error"
                        and action_name in ("click", "type", "hover", "select", "act")
                    ):
                        from oi_agent.services.tools.base import ToolContext
                        from oi_agent.services.tools.navigator.fallbacks import (
                            attempt_adaptive_recovery,
                        )

                        failed_step_for_recovery = dict(step)
                        if action_name == "act":
                            kind = str(step.get("kind", "")).strip().lower()
                            if kind in {"click", "type", "hover", "select"}:
                                failed_step_for_recovery["action"] = kind
                                failed_step_for_recovery["target"] = step.get("ref", "")

                        recovery_context = ToolContext(
                            automation_id=f"navigator-{run_id}",
                            user_id=user["uid"],
                            action_config={
                                "type": "browser_automation",
                                "device_id": device_id,
                                "tab_id": tab_id,
                                "run_id": run_id,
                            },
                            data_sources=[],
                            trigger_config={"type": "manual"},
                            automation_name="Navigator recovery",
                            automation_description=rewritten_prompt,
                            execution_mode="autopilot",
                        )
                        recovered = await attempt_adaptive_recovery(
                            connection_manager=connection_manager,
                            device_id=device_id,
                            context=recovery_context,
                            run_id=run_id,
                            failed_step=failed_step_for_recovery,
                            step_index=global_step_idx,
                            total_steps=max(1, len(remaining_steps) + 1),
                        )
                        if recovered is not None and recovered.get("status") != "error":
                            result = recovered
                            status = result.get("status", "done")
                            _log_navigator_trace(
                                "navigator_adaptive_recovery_succeeded",
                                run_id=run_id,
                                step_index=global_step_idx,
                            action=action_name,
                                status=str(status or ""),
                                mode="stream",
                            )

                    step_status = "success" if status not in {"error", "manual"} else "error"
                    screenshot_data = str(result.get("screenshot", "") or "")
                    results.append(
                        {
                            "step_index": global_step_idx,
                            "action": action_name,
                            "description": step.get("description", ""),
                            "status": step_status,
                            "data": result.get("data", ""),
                            "screenshot": screenshot_data,
                            "execution_mode_detail": result.get("execution_mode_detail", ""),
                            "verification_result": result.get("verification_result", ""),
                        }
                    )

                    yield sse(
                        {
                            "type": "step_end",
                            "index": global_step_idx,
                            "status": step_status,
                            "data": result.get("data", ""),
                            "screenshot": screenshot_data,
                            "execution_mode_detail": result.get("execution_mode_detail", ""),
                            "fallback_confidence": result.get("fallback_confidence"),
                            "verification_result": result.get("verification_result", ""),
                        }
                    )

                    global_step_idx += 1

                    if status not in {"error", "manual"}:
                        if action_name == "snapshot":
                            current_snapshot_epoch = _snapshot_epoch(result if isinstance(result, dict) else None) or current_snapshot_epoch
                        completed_step_descriptions.append(
                            str(step.get("description", "")).strip() or action_name
                        )
                        completed_fingerprints.add(_step_fingerprint(step))
                        continue

                    error_data = result.get("data", "")
                    error_data = friendly_browser_error(
                        connection_manager, device_id, tab_id, str(error_data)
                    )
                    if status == "error" and action_name in {"click", "type", "hover", "select", "act"}:
                        recovery_steps = await _recover_with_observation_escalation(
                            failed_step=step,
                            error_message=error_data,
                            completed_steps=completed_step_descriptions,
                            step_index=global_step_idx,
                        )
                        if recovery_steps:
                            latest_snapshot = await fetch_page_snapshot(
                                device_id,
                                tab_id,
                                f"{run_id}-observe-recovery-refresh-{global_step_idx}",
                                target_id=f"tab:{tab_id}" if tab_id is not None else None,
                            )
                            current_snapshot_epoch = _snapshot_epoch(latest_snapshot) or current_snapshot_epoch
                            recovery_steps = _annotate_act_steps_snapshot_id(recovery_steps, current_snapshot_epoch)
                            remaining_steps = recovery_steps + remaining_steps
                            continue
                    if status == "manual":
                        resume_token = store_paused_run(
                            user_id=user["uid"],
                            prompt=rewritten_prompt,
                            device_id=device_id,
                            tab_id=tab_id,
                            remaining_steps=remaining_steps,
                        )
                        message = (
                            f"Step {global_step_idx} needs manual verification: {error_data}. "
                            "Please confirm the visible UI state in the tab, then click Confirm & Resume."
                        )
                        await _finalize_run(
                            status="blocked",
                            message=message,
                            requires_user_action=True,
                        )
                        yield sse(
                            {
                                "type": "done",
                                "ok": False,
                                "requires_user_action": True,
                                "resume_token": resume_token,
                                "message": message,
                                "steps_executed": results,
                            }
                        )
                        return
                    if requires_user_intervention(step, error_data):
                        resume_token = store_paused_run(
                            user_id=user["uid"],
                            prompt=rewritten_prompt,
                            device_id=device_id,
                            tab_id=tab_id,
                            remaining_steps=remaining_steps,
                        )
                        message = (
                            f"Step {global_step_idx} needs manual help: {error_data}. "
                            "Please perform this action in the tab, then click Confirm & Resume."
                        )
                        _log_navigator_trace(
                            "navigator_step_blocked_by_user_action",
                            run_id=run_id,
                            step_index=global_step_idx,
                            action=action_name,
                            device_id=device_id,
                            tab_id=tab_id,
                            resume_token=resume_token,
                            error_message=_truncate_log_value(error_data, limit=200),
                            mode="stream",
                        )
                        await _finalize_run(
                            status="blocked",
                            message=message,
                            requires_user_action=True,
                        )
                        yield sse(
                            {
                                "type": "done",
                                "ok": False,
                                "requires_user_action": True,
                                "resume_token": resume_token,
                                "message": message,
                                "steps_executed": results,
                            }
                        )
                        return

                    # Stop immediately on first non-blocked failure; do not continue/replan.
                    message = f"Step {global_step_idx} failed: {error_data}"
                    _log_navigator_trace(
                        "navigator_step_failed_terminal",
                        run_id=run_id,
                        step_index=global_step_idx,
                        action=action_name,
                        device_id=device_id,
                        tab_id=tab_id,
                        error_message=_truncate_log_value(error_data, limit=200),
                        mode="stream",
                    )
                    await _finalize_run(status="failed", message=message)
                    yield sse(
                        {
                            "type": "done",
                            "ok": False,
                            "message": message,
                            "steps_executed": results,
                        }
                    )
                    return

            finally:
                await connection_manager.send_to_device(
                    device_id,
                    {
                        "type": "stop_screenshot_stream",
                        "payload": {"run_id": run_id},
                    },
                )

            if is_interactive_intent(rewritten_prompt):
                interactive_done = any(
                    str(r.get("action", "") or r.get("command", "")).lower() not in PASSIVE_BROWSER_ACTIONS
                    and str(r.get("status", "")).lower() == "success"
                    for r in results
                )
                if not interactive_done:
                    message = (
                        "Automation ran but did not execute actionable UI interactions. "
                        "This is likely due to unstable or unresolved page elements."
                    )
                    _log_navigator_trace(
                        "navigator_interactive_validation_failed",
                        run_id=run_id,
                        device_id=device_id,
                        tab_id=tab_id,
                        executed_steps=len(results),
                        mode="stream",
                    )
                    await _finalize_run(status="failed", message=message)
                    yield sse(
                        {
                            "type": "done",
                            "ok": False,
                            "message": message,
                            "steps_executed": results,
                        }
                    )
                    return

            if is_media_intent(rewritten_prompt):
                playing_ok, reason = await check_media_playing(
                    connection_manager=connection_manager,
                    device_id=device_id,
                    tab_id=tab_id,
                    run_id=run_id,
                )
                if not playing_ok:
                    resume_token = store_paused_run(
                        user_id=user["uid"],
                        prompt=rewritten_prompt,
                        device_id=device_id,
                        tab_id=tab_id,
                        remaining_steps=[],
                    )
                    message = (
                        f"Automation completed steps but playback is not active ({reason}). "
                        "Please press Play manually, then click Confirm & Resume."
                    )
                    _log_navigator_trace(
                        "navigator_media_validation_blocked",
                        run_id=run_id,
                        device_id=device_id,
                        tab_id=tab_id,
                        reason=_truncate_log_value(reason, limit=160),
                        resume_token=resume_token,
                        mode="stream",
                    )
                    await _finalize_run(
                        status="blocked",
                        message=message,
                        requires_user_action=True,
                    )
                    yield sse(
                        {
                            "type": "done",
                            "ok": False,
                            "requires_user_action": True,
                            "resume_token": resume_token,
                            "message": message,
                            "steps_executed": results,
                        }
                    )
                    return

            latest_screenshot = ""
            for row in reversed(results):
                shot = str(row.get("screenshot", "") or "")
                if shot:
                    latest_screenshot = shot
                    break
            message = f"Completed {len(results)} browser steps."
            _log_navigator_trace(
                "navigator_run_completed",
                run_id=run_id,
                device_id=device_id,
                tab_id=tab_id,
                executed_steps=len(results),
                latest_screenshot_captured=bool(latest_screenshot),
                mode="stream",
            )
            await _finalize_run(status="completed", message=message)
            yield sse(
                {
                    "type": "done",
                    "ok": True,
                    "message": message,
                    "steps_executed": results,
                    "screenshot": latest_screenshot,
                }
            )

        except asyncio.CancelledError:
            _log_navigator_trace(
                "navigator_run_cancelled",
                run_id=run_id,
                device_id=device_id,
                tab_id=tab_id,
                executed_steps=len(results),
                mode="stream",
            )
            await _finalize_run(
                status="stopped",
                message="Stopped by client disconnect.",
            )
            raise
        except Exception as exc:
            logger.exception("Streaming agent error: %s", exc)
            _log_navigator_trace(
                "navigator_run_exception",
                run_id=run_id,
                device_id=device_id,
                tab_id=tab_id,
                error_message=_truncate_log_value(exc, limit=200),
                mode="stream",
            )
            message = str(exc)
            await _finalize_run(status="failed", message=message)
            yield sse({"type": "done", "ok": False, "message": message})

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@agent_router.post("/browser/agent/resume")
async def browser_agent_resume(
    payload: BrowserAgentResumeRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    from oi_agent.api.websocket import connection_manager
    from oi_agent.services.tools.base import ToolContext
    from oi_agent.services.tools.browser_automation import BrowserAutomationTool  # type: ignore[import-untyped]

    cleanup_paused_runs()
    paused = paused_navigator_runs.get(payload.resume_token)
    if not paused:
        raise HTTPException(status_code=404, detail="Resume token expired or not found.")
    if paused.get("user_id") != user["uid"]:
        raise HTTPException(status_code=403, detail="Resume token does not belong to this user.")

    device_id = str(paused.get("device_id", "") or "")
    tab_id = paused.get("tab_id")
    remaining_steps = paused.get("remaining_steps", [])
    prompt = str(paused.get("prompt", "") or "")

    if not device_id or not connection_manager.is_connected(device_id):
        raise HTTPException(status_code=409, detail="Target device is no longer connected.")
    if tab_id is not None:
        attached = {
            int(t.get("tab_id", 0))
            for t in connection_manager.get_attached_tabs(device_id)
            if isinstance(t, dict)
        }
        if int(tab_id) not in attached:
            raise HTTPException(status_code=409, detail="Target tab is no longer attached. Re-run from start.")

    if not isinstance(remaining_steps, list) or len(remaining_steps) == 0:
        paused_navigator_runs.pop(payload.resume_token, None)
        return {
            "ok": True,
            "run_id": f"resume-{str(uuid.uuid4())[:8]}",
            "message": "Manual action confirmed. No remaining automated steps.",
            "steps_executed": [],
            "selected_target": {"device_id": device_id, "tab_id": tab_id},
        }

    resume_snapshot = await fetch_page_snapshot(device_id, tab_id, run_id=f"resume-snapshot-{str(uuid.uuid4())[:8]}")
    resume_epoch = _snapshot_epoch(resume_snapshot)
    if any(str(s.get("action", "")).strip().lower() == "act" for s in remaining_steps) and not resume_epoch:
        raise HTTPException(status_code=409, detail="Could not refresh page snapshot for resume. Please run again from current tab.")
    remaining_steps = _annotate_act_steps_snapshot_id(remaining_steps, resume_epoch)

    run_id = f"resume-{str(uuid.uuid4())[:8]}"
    await create_navigator_run(
        user_id=user["uid"],
        run_id=run_id,
        prompt=prompt or "Resume navigator run",
        rewritten_prompt=prompt or "Resume navigator run",
        device_id=device_id,
        tab_id=tab_id,
        target_url="",
        page_title="",
    )
    context = ToolContext(
        automation_id=f"navigator-{run_id}",
        user_id=user["uid"],
        action_config={
            "type": "browser_automation",
            "device_id": device_id,
            "tab_id": tab_id,
            "run_id": run_id,
        },
        data_sources=[],
        trigger_config={"type": "manual"},
        automation_name="Navigator Resume",
        automation_description=prompt,
        execution_mode="autopilot",
    )

    browser_tool = BrowserAutomationTool()
    result = await browser_tool.execute(context, [{"steps": remaining_steps}])
    if not result.success:
        await finalize_navigator_run(
            user_id=user["uid"],
            run_id=run_id,
            status="failed",
            message=result.error or "Resume failed",
            requires_user_action=False,
            steps_executed=result.data if isinstance(result.data, list) else [],
        )
        raise HTTPException(status_code=409, detail=result.error or "Resume failed")

    await finalize_navigator_run(
        user_id=user["uid"],
        run_id=run_id,
        status="completed",
        message=result.text or "Resumed actions completed.",
        requires_user_action=False,
        steps_executed=result.data if isinstance(result.data, list) else [],
    )
    paused_navigator_runs.pop(payload.resume_token, None)
    return {
        "ok": True,
        "run_id": run_id,
        "message": result.text or "Resumed actions completed.",
        "steps_executed": result.data,
        "selected_target": {"device_id": device_id, "tab_id": tab_id},
    }
