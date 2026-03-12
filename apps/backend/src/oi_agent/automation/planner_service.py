from __future__ import annotations

from datetime import UTC, datetime
import uuid
import re
from typing import Any

from oi_agent.automation.conversation_task_shape import infer_task_shape
from oi_agent.automation.models import (
    AgentBrowserStep,
    AutomationPlan,
    AutomationStep,
    AutomationTarget,
    BlockingEvidence,
    CompletionEvidence,
    ConfirmationPolicy,
    ExecutionBrief,
    ExecutionContract,
    IntentDraft,
    PredictedExecutionPlan,
    PredictedPhase,
    ResolveExecutionRequest,
    TaskShapeEvidence,
    TransferEvidence,
    VerificationEvidence,
    VisibleStateEvidence,
)
from oi_agent.config import settings
from oi_agent.automation.store import save_plan


def _step(
    step_id: str,
    command: str,
    label: str,
    description: str,
    *,
    phase_index: int | None = None,
    page_hint: str | None = None,
    page_ref: str | None = None,
    output_key: str | None = None,
    consumes_keys: list[str] | None = None,
) -> AutomationStep:
    return AutomationStep(
        step_id=step_id,
        phase_index=phase_index,
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
                phase_index=idx - 1,
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
                phase_index=max(0, len(normalized) - 1),
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


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _completion_signals_for_phase(label: str, entities: dict[str, Any], app_name: str | None) -> list[str]:
    lowered = label.lower()
    signals: list[str] = []
    recipient = str(entities.get("recipient", "") or entities.get("contact", "") or "").strip()
    message_text = str(entities.get("message_text", "") or entities.get("body", "") or "").strip()
    if app_name and any(token in lowered for token in ("open", "launch", "go to", "navigate", "app", "website")):
        signals.append(app_name)
    if recipient and any(token in lowered for token in ("locate", "find", "search", "select", "recipient", "candidate", "chat")):
        signals.append(recipient)
    if message_text and any(token in lowered for token in ("compose", "draft", "type", "fill", "message", "reply", "email")):
        signals.append(message_text)
    if recipient and any(token in lowered for token in ("verify", "confirm", "ensure", "send")):
        signals.append(recipient)
    return signals


def _default_phase_labels(summary: str) -> list[str]:
    if "email" in summary.lower() or "gmail" in summary.lower():
        return [
            "Open the mail workspace",
            "Address the correct recipient",
            "Draft the requested email",
            "Verify the send details",
        ]
    return [
        "Open the target workspace",
        "Find the right destination",
        "Perform the requested action",
        "Verify the result",
    ]


def build_predicted_execution_plan(
    *,
    summary: str,
    workflow_outline: list[str],
    entities: dict[str, Any],
    app_name: str | None,
) -> PredictedExecutionPlan:
    labels = [item.strip() for item in workflow_outline if isinstance(item, str) and item.strip()]
    if not labels:
        labels = _default_phase_labels(summary)
    phases = [
        PredictedPhase(
            phase_id=f"phase_{index + 1}",
            label=label,
            goal=label,
            completion_signals=_completion_signals_for_phase(label, entities, app_name),
            advisory=True,
        )
        for index, label in enumerate(labels)
    ]
    return PredictedExecutionPlan(
        summary=summary,
        phases=phases,
        advisory=True,
        generated_at=_now_iso(),
    )


def build_execution_contract(
    *,
    resolved_goal: str,
    app_name: str | None,
    entities: dict[str, Any],
    predicted_plan: PredictedExecutionPlan,
    requires_confirmation: bool,
) -> ExecutionContract:
    task_shape = infer_task_shape(resolved_goal)
    recipient = str(entities.get("recipient", "") or entities.get("contact", "") or "").strip()
    message_text = str(entities.get("message_text", "") or entities.get("body", "") or "").strip()
    completion_criteria = [f"The requested outcome is completed for: {resolved_goal}"]
    if recipient:
        completion_criteria.append(f"The active destination matches {recipient}.")
    if message_text:
        completion_criteria.append(f"The final drafted or submitted content matches: {message_text}")
    guardrails = [
        "Stay within the target app or site unless authentication or the task clearly requires navigation.",
        "Prefer deterministic ref-based interaction when a snapshot is available.",
        "Re-evaluate the next step from the live browser state after each observation.",
    ]
    if requires_confirmation:
        guardrails.append("Do not execute irreversible or sensitive actions without conversation-core approval.")
    return ExecutionContract(
        contract_id=str(uuid.uuid4()),
        resolved_goal=resolved_goal,
        target_app=app_name,
        target_entities={
            key: value
            for key, value in dict(entities).items()
            if value not in (None, "", [], {})
        },
        task_shape=TaskShapeEvidence(
            apps=sorted(task_shape.apps),
            operation_chain=list(task_shape.operation_chain),
            requires_live_ui=task_shape.requires_live_ui,
            cross_app_transfer=task_shape.cross_app_transfer,
            visible_state_dependence=task_shape.visible_state_dependence,
            execution_surface=task_shape.execution_surface,  # type: ignore[arg-type]
            timing_intent=task_shape.timing_intent,  # type: ignore[arg-type]
        ),
        completion_evidence=CompletionEvidence(
            summary=f"Complete the requested outcome for: {resolved_goal}",
            criteria=completion_criteria,
        ),
        blocking_evidence=BlockingEvidence(
            reason="Sensitive action confirmation required." if requires_confirmation else "",
            requires_confirmation=requires_confirmation,
            requires_user_reply=requires_confirmation,
        ),
        visible_state_evidence=VisibleStateEvidence(
            signals=[
                signal
                for phase in predicted_plan.phases
                for signal in phase.completion_signals
            ],
            depends_on_foreground_surface=task_shape.visible_state_dependence,
        ),
        transfer_evidence=TransferEvidence(
            source_apps=sorted(task_shape.source_apps),
            destination_apps=sorted(task_shape.destination_apps),
            cross_app_transfer=task_shape.cross_app_transfer,
        ),
        verification_evidence=VerificationEvidence(
            checks=[
                signal
                for phase in predicted_plan.phases
                for signal in phase.completion_signals
            ],
            expected_state_change=resolved_goal,
        ),
        completion_criteria=completion_criteria,
        guardrails=guardrails,
        confirmation_policy=ConfirmationPolicy(
            required=requires_confirmation,
            reason="Sensitive or irreversible actions are conversation-core gated." if requires_confirmation else None,
        ),
        predicted_plan=predicted_plan,
    )


def build_compat_execution_brief(contract: ExecutionContract) -> ExecutionBrief:
    phase_labels = [phase.label for phase in contract.predicted_plan.phases] if contract.predicted_plan else _default_phase_labels(contract.resolved_goal)
    phase_completion_checks = [
        list(phase.completion_signals)
        for phase in (contract.predicted_plan.phases if contract.predicted_plan else [])
    ] or [[] for _ in phase_labels]
    return ExecutionBrief(
        goal=contract.resolved_goal,
        app_name=contract.target_app,
        target_entities=dict(contract.target_entities),
        workflow_phases=phase_labels,
        phase_completion_checks=phase_completion_checks,
        success_criteria=list(contract.completion_criteria),
        guardrails=list(contract.guardrails),
        disambiguation_hints=[],
        completion_evidence=[
            signal
            for phase in (contract.predicted_plan.phases if contract.predicted_plan else [])
            for signal in phase.completion_signals
        ],
    )


async def build_plan(intent: IntentDraft, request: ResolveExecutionRequest, user_id: str = "dev-user") -> AutomationPlan:
    plan_id = str(uuid.uuid4())
    source_prompt = next(
        (
            str(item.text or "").strip()
            for item in intent.normalized_inputs
            if item.type == "text" and str(item.text or "").strip()
        ),
        intent.user_goal,
    )
    app_name = _resolve_app_name(intent)
    predicted_plan = build_predicted_execution_plan(
        summary=intent.user_goal,
        workflow_outline=list(intent.workflow_outline),
        entities=dict(intent.entities),
        app_name=app_name,
    )
    execution_contract = build_execution_contract(
        resolved_goal=intent.user_goal,
        app_name=app_name,
        entities=dict(intent.entities),
        predicted_plan=predicted_plan,
        requires_confirmation=intent.requires_confirmation,
    )
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
        source_prompt=source_prompt,
        model_id=intent.model_id,
        execution_contract=execution_contract,
        predicted_plan=predicted_plan,
        execution_brief=None,
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
    user_id: str = "dev-user",
    prompt: str,
    execution_mode: str,
    device_id: str | None = None,
    tab_id: int | None = None,
    app_name: str | None = None,
    intent_id: str = "",
) -> AutomationPlan:
    plan_id = str(uuid.uuid4())
    predicted_plan = build_predicted_execution_plan(
        summary=prompt,
        workflow_outline=[],
        entities={"app": app_name or ""},
        app_name=app_name,
    )
    execution_contract = build_execution_contract(
        resolved_goal=prompt,
        app_name=app_name,
        entities={"app": app_name or ""} if app_name else {},
        predicted_plan=predicted_plan,
        requires_confirmation=False,
    )
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
        source_prompt=prompt,
        model_id=None,
        execution_contract=execution_contract,
        predicted_plan=predicted_plan,
        execution_brief=None,
        targets=[target],
        steps=steps,
        requires_confirmation=False,
    )
    raw_plan = plan.model_dump(mode="json")
    raw_plan["user_id"] = user_id
    await save_plan(plan_id, raw_plan)
    return plan
