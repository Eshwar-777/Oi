from __future__ import annotations

import uuid
import re
from typing import Any

from oi_agent.automation.models import (
    AgentBrowserStep,
    AutomationPlan,
    AutomationStep,
    AutomationTarget,
    IntentDraft,
    ResolveExecutionRequest,
)
from oi_agent.config import settings
from oi_agent.automation.store import save_plan


def _step(
    step_id: str,
    command: str,
    label: str,
    description: str,
    *,
    page_hint: str | None = None,
    page_ref: str | None = None,
    output_key: str | None = None,
    consumes_keys: list[str] | None = None,
) -> AutomationStep:
    return AutomationStep(
        step_id=step_id,
        command_payload=AgentBrowserStep(
            id=step_id,
            command=command,
            description=description,
            page_ref=page_ref,
            output_key=output_key,
            consumes_keys=list(consumes_keys or []),
        ),
        label=label,
        description=description,
        page_hint=page_hint,
        page_ref=page_ref,
        output_key=output_key,
        consumes_keys=list(consumes_keys or []),
        status="pending",
    )

def _infer_step_kind(text: str, *, index: int = 0) -> str:
    lowered = (text or "").strip().lower()
    if any(token in lowered for token in ("type", "enter", "fill", "paste", "send", "reply", "message")):
        return "type"
    if any(token in lowered for token in ("copy", "extract", "find", "read", "collect", "capture")):
        return "extract"
    if any(token in lowered for token in ("open ", "go to ", "navigate", "visit ", "launch ")):
        return "navigate"
    if any(token in lowered for token in ("click", "tap", "press", "submit", "play", "select")):
        return "click"
    if any(token in lowered for token in ("scroll", "move down", "move up")):
        return "scroll"
    if any(token in lowered for token in ("wait", "confirm", "verify", "ensure", "check")):
        return "wait"
    return "navigate" if index == 0 else "click"


def _normalize_outline_step(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", (text or "").strip()).strip(" .")
    return cleaned or "Continue the workflow"


def _step_page_hint(text: str, entities: dict[str, Any], *, fallback: str | None = None) -> str | None:
    lowered = (text or "").lower()
    for key in ("target_app", "source_app", "app"):
        value = str(entities.get(key, "") or "").strip()
        if value and value.lower() in lowered:
            return value
    for app in ("YouTube", "WhatsApp", "Gmail", "LinkedIn", "Notion", "Slack", "Discord", "Telegram"):
        if app.lower() in lowered:
            return app
    return fallback


def _page_ref_for_hint(page_hint: str | None) -> str | None:
    value = re.sub(r"[^a-z0-9]+", "_", str(page_hint or "").strip().lower()).strip("_")
    return f"page_{value}" if value else None


def _output_key_for_step(text: str, kind: str, *, index: int) -> str | None:
    lowered = (text or "").lower()
    if kind != "extract":
        return None
    if "comment" in lowered:
        return "comment_text"
    if "message" in lowered:
        return "message_text"
    if "link" in lowered or "url" in lowered:
        return "link_url"
    return f"extracted_value_{index + 1}"


def _consumed_keys_for_step(
    text: str,
    kind: str,
    available_keys: list[str],
) -> list[str]:
    lowered = (text or "").lower()
    if kind not in {"type", "click"} or not available_keys:
        return []
    matched = [key for key in available_keys if key.replace("_", " ") in lowered or key in lowered]
    if matched:
        return matched
    if any(token in lowered for token in ("send", "paste", "type", "enter", "reply")):
        return [available_keys[-1]]
    return []


def _seed_steps_from_outline(
    outline: list[str],
    summary: str,
    entities: dict[str, Any] | None = None,
) -> list[AutomationStep]:
    normalized = [_normalize_outline_step(item) for item in outline if _normalize_outline_step(item)]
    if not normalized:
        normalized = [
            "Open the target application or page",
            "Locate the relevant UI area",
            "Perform the requested action",
            "Verify the outcome",
        ]
    entity_map = dict(entities or {})

    steps: list[AutomationStep] = []
    available_keys: list[str] = []
    last_page_hint = _step_page_hint(summary, entity_map)
    for idx, item in enumerate(normalized, start=1):
        command = _infer_step_kind(item, index=idx - 1)
        label = item[:1].upper() + item[1:]
        page_hint = _step_page_hint(item, entity_map, fallback=last_page_hint)
        page_ref = _page_ref_for_hint(page_hint)
        output_key = _output_key_for_step(item, command, index=idx - 1)
        consumes_keys = _consumed_keys_for_step(item, command, available_keys)
        steps.append(
            _step(
                f"s{idx}",
                command,
                label,
                item,
                page_hint=page_hint,
                page_ref=page_ref,
                output_key=output_key,
                consumes_keys=consumes_keys,
            )
        )
        if page_hint:
            last_page_hint = page_hint
        if output_key:
            available_keys.append(output_key)

    if not any(step.normalized_command_payload().command == "wait" for step in steps):
        steps.append(
            _step(
                f"s{len(steps) + 1}",
                "wait",
                "Verify the outcome",
                f"Verify that the workflow goal completed successfully: {summary}",
                page_hint=last_page_hint,
                page_ref=_page_ref_for_hint(last_page_hint),
                consumes_keys=available_keys[-1:] if available_keys else [],
            )
        )
    return steps


def _should_seed_browser_outline_steps() -> bool:
    return not bool(settings.automation_browser_single_step_planning)


def _resolve_app_name(intent: IntentDraft) -> str | None:
    for key in ("target_app", "app", "source_app"):
        value = str(intent.entities.get(key, "") or "").strip()
        if value:
            return value
    return None


async def build_plan(intent: IntentDraft, request: ResolveExecutionRequest, user_id: str) -> AutomationPlan:
    plan_id = str(uuid.uuid4())
    app_name = _resolve_app_name(intent)
    target = AutomationTarget(
        target_type="browser_session",
        device_id=None,
        tab_id=None,
        app_name=app_name,
    )
    steps = (
        _seed_steps_from_outline(intent.workflow_outline, intent.user_goal, intent.entities)
        if _should_seed_browser_outline_steps()
        else []
    )
    plan = AutomationPlan(
        plan_id=plan_id,
        intent_id=intent.intent_id,
        execution_mode=request.execution_mode,
        summary=intent.user_goal,
        model_id=intent.model_id,
        targets=[target],
        steps=steps,
        requires_confirmation=intent.requires_confirmation,
    )
    raw_plan = plan.model_dump(mode="json")
    raw_plan["user_id"] = user_id
    await save_plan(plan_id, raw_plan)
    return plan


async def build_plan_from_prompt(
    *,
    user_id: str,
    prompt: str,
    execution_mode: str,
    device_id: str | None = None,
    tab_id: int | None = None,
    app_name: str | None = None,
    intent_id: str = "",
) -> AutomationPlan:
    plan_id = str(uuid.uuid4())
    target = AutomationTarget(
        target_type="browser_session",
        device_id=device_id,
        tab_id=tab_id,
        app_name=app_name,
    )
    steps = _seed_steps_from_outline([], prompt, {"app": app_name or ""}) if _should_seed_browser_outline_steps() else []
    plan = AutomationPlan(
        plan_id=plan_id,
        intent_id=intent_id,
        execution_mode=execution_mode,  # type: ignore[arg-type]
        summary=prompt,
        model_id=None,
        targets=[target],
        steps=steps,
        requires_confirmation=False,
    )
    raw_plan = plan.model_dump(mode="json")
    raw_plan["user_id"] = user_id
    await save_plan(plan_id, raw_plan)
    return plan
