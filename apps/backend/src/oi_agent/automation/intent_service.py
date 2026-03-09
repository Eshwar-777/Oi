from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import cast

from oi_agent.automation.events import publish_event
from oi_agent.automation.intent_extractor import (
    _extract_entities_fallback,
    extract_intent,
    flatten_inputs,
    resolve_model_selection,
)
from oi_agent.automation.models import (
    ChatPrimeRequest,
    ChatPrimeResponse,
    ChatTurnRequest,
    ChatTurnResponse,
    ConversationDecision,
    ExecutionIntent,
    GoalType,
    IntentDraft,
    TaskInterpretation,
)
from oi_agent.automation.response_composer import compose_intent_response
from oi_agent.automation.session_context import build_session_context, merge_with_active_intent
from oi_agent.automation.store import get_prepared_turn, save_intent, save_session_turn

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _decision(
    *,
    interpretation: TaskInterpretation,
    goal_type: str,
    missing_fields: list[str],
    timing_mode: str,
    can_automate: bool,
    requires_confirmation: bool,
) -> ConversationDecision:
    if interpretation.task_kind == "general_chat" or goal_type == "general_chat":
        return "GENERAL_CHAT"
    if missing_fields:
        return "ASK_CLARIFICATION"
    if not can_automate or interpretation.task_kind not in {"browser_automation", "unknown"} or goal_type != "ui_automation":
        return "BLOCKED"
    if interpretation.execution_intent == "unspecified" and timing_mode == "unknown":
        return "ASK_EXECUTION_MODE"
    if requires_confirmation:
        return "REQUIRES_CONFIRMATION"
    if interpretation.execution_intent == "immediate" or timing_mode == "immediate":
        return "READY_TO_EXECUTE"
    if interpretation.execution_intent in {"once", "recurring"} or timing_mode in {"once", "interval"}:
        return "READY_TO_SCHEDULE"
    return "READY_FOR_MULTI_TIME_SCHEDULE"


def _timing_mode_from_interpretation(execution_intent: ExecutionIntent, timing_mode: str) -> str:
    if execution_intent == "immediate":
        return "immediate"
    if execution_intent == "once":
        return "once" if timing_mode == "unknown" else timing_mode
    if execution_intent == "recurring":
        return "multi_time" if timing_mode == "multi_time" else "interval"
    return timing_mode


def _schedule_background(task_name: str, coro: asyncio.Future[object] | asyncio.coroutines.Coroutine[object, object, object]) -> None:
    async def _runner() -> None:
        try:
            await coro
        except Exception:
            logger.exception("Automation background task failed: %s", task_name)

    asyncio.create_task(_runner())


async def understand_turn(payload: ChatTurnRequest, user_id: str) -> ChatTurnResponse:
    if payload.prepare_token:
        prepared = await get_prepared_turn(payload.prepare_token)
        if prepared and prepared.get("session_id") != payload.session_id:
            payload.prepare_token = None

    user_turn_id = str(uuid.uuid4())
    combined_text = flatten_inputs(payload.inputs)
    _schedule_background(
        "save_user_turn",
        save_session_turn(
            payload.session_id,
            user_turn_id,
            {
                "turn_id": user_turn_id,
                "user_id": user_id,
                "session_id": payload.session_id,
                "role": "user",
                "text": combined_text,
                "timestamp": _now_iso(),
            },
        ),
    )
    _schedule_background(
        "understanding_started",
        publish_event(
            user_id=user_id,
            session_id=payload.session_id,
            run_id=None,
            event_type="understanding.started",
            payload={"label": "Analyzing your request"},
        ),
    )
    requested_model = payload.client_context.model
    resolved_model, _ = resolve_model_selection(requested_model)
    extracted, session_context = await asyncio.gather(
        extract_intent(combined_text, requested_model=requested_model),
        build_session_context(user_id, payload.session_id),
    )
    merged = merge_with_active_intent(
        current_text=combined_text,
        extracted=extracted,
        active_intent=session_context.active_intent,
    )
    if merged is not None:
        entities = dict(merged["entities"])
        missing_fields = list(merged["missing_fields"])
        timing_mode = str(merged["timing_mode"])
        timing_candidates = list(merged["timing_candidates"])
        goal_type = cast(GoalType, str(merged["goal_type"]))
        can_automate = bool(merged["can_automate"])
        risk_flags = list(merged["risk_flags"])
        user_goal = str(merged["user_goal"] or combined_text or extracted.user_goal or "Untitled request")
        active_interpretation = (
            dict(session_context.active_intent.get("interpretation") or {})
            if isinstance(session_context.active_intent, dict)
            else {}
        )
        workflow_outline = list(
            active_interpretation.get("workflow_outline")
            or extracted.workflow_outline
        )
        interpretation = TaskInterpretation(
            task_kind=str(
                active_interpretation.get("task_kind")
                or extracted.task_kind
                or ("browser_automation" if goal_type == "ui_automation" else goal_type)
            ),  # type: ignore[arg-type]
            execution_intent=str(
                extracted.execution_intent
                if extracted.execution_intent != "unspecified"
                else active_interpretation.get("execution_intent")
                or "unspecified"
            ),  # type: ignore[arg-type]
            workflow_outline=workflow_outline,
            clarification_hints=list(
                extracted.clarification_hints
                or active_interpretation.get("clarification_hints")
                or []
            ),
            confidence=max(extracted.confidence, float(active_interpretation.get("confidence") or 0.0)),
        )
    else:
        entities = dict(extracted.entities)
        missing_fields = list(extracted.missing_fields)
        timing_mode = extracted.timing_mode
        timing_candidates = list(extracted.timing_candidates)
        goal_type = cast(GoalType, extracted.goal_type)
        can_automate = extracted.can_automate
        risk_flags = list(extracted.risk_flags)
        user_goal = str(combined_text or extracted.user_goal or "Untitled request")
        workflow_outline = list(extracted.workflow_outline)
        interpretation = TaskInterpretation(
            task_kind=extracted.task_kind,  # type: ignore[arg-type]
            execution_intent=extracted.execution_intent,  # type: ignore[arg-type]
            workflow_outline=workflow_outline,
            clarification_hints=list(extracted.clarification_hints),
            confidence=extracted.confidence,
        )
    timing_mode = _timing_mode_from_interpretation(
        cast(ExecutionIntent, interpretation.execution_intent),
        timing_mode,
    )
    requires_confirmation = bool(risk_flags)
    decision = _decision(
        interpretation=interpretation,
        goal_type=goal_type,
        missing_fields=missing_fields,
        timing_mode=timing_mode,
        can_automate=can_automate,
        requires_confirmation=requires_confirmation,
    )

    intent = IntentDraft(
        intent_id=str(uuid.uuid4()),
        session_id=payload.session_id,
        user_goal=user_goal or combined_text or extracted.user_goal or "Untitled request",
        goal_type=goal_type,
        workflow_outline=workflow_outline,
        interpretation=interpretation,
        normalized_inputs=payload.inputs,
        entities=entities,
        missing_fields=missing_fields,
        timing_mode=timing_mode,
        timing_candidates=timing_candidates,
        can_automate=can_automate,
        confidence=extracted.confidence,
        model_id=resolved_model,
        decision=decision,
        requires_confirmation=requires_confirmation,
        risk_flags=risk_flags,
    )
    assistant, actions = compose_intent_response(intent)
    intent_row = intent.model_dump(mode="json")
    intent_row["user_id"] = user_id
    intent_row["_saved_at"] = _now_iso()
    await save_intent(intent.intent_id, intent_row)
    assistant_turn_id = str(uuid.uuid4())
    _schedule_background(
        "save_assistant_turn",
        save_session_turn(
            payload.session_id,
            assistant_turn_id,
            {
                "turn_id": assistant_turn_id,
                "user_id": user_id,
                "session_id": payload.session_id,
                "role": "assistant",
                "text": assistant.text,
                "timestamp": _now_iso(),
                "decision": intent.decision,
                "intent_id": intent.intent_id,
            },
        ),
    )
    _schedule_background(
        "understanding_completed",
        publish_event(
            user_id=user_id,
            session_id=payload.session_id,
            run_id=None,
            event_type="understanding.completed",
            payload={"intent_id": intent.intent_id, "decision": intent.decision},
        ),
    )
    if intent.decision == "ASK_CLARIFICATION":
        _schedule_background(
            "clarification_requested",
            publish_event(
                user_id=user_id,
                session_id=payload.session_id,
                run_id=None,
                event_type="clarification.requested",
                payload={
                    "intent_id": intent.intent_id,
                    "question": assistant.text,
                    "missing_fields": intent.missing_fields,
                },
            ),
        )
    elif intent.decision == "ASK_EXECUTION_MODE":
        _schedule_background(
            "execution_mode_requested",
            publish_event(
                user_id=user_id,
                session_id=payload.session_id,
                run_id=None,
                event_type="execution_mode.requested",
                payload={
                    "intent_id": intent.intent_id,
                    "question": assistant.text,
                    "allowed_modes": ["immediate", "once", "interval", "multi_time"],
                },
            ),
        )
    elif intent.decision == "REQUIRES_CONFIRMATION":
        _schedule_background(
            "confirmation_requested",
            publish_event(
                user_id=user_id,
                session_id=payload.session_id,
                run_id=None,
                event_type="confirmation.requested",
                payload={
                    "intent_id": intent.intent_id,
                    "message": assistant.text,
                },
            ),
        )
    return ChatTurnResponse(
        assistant_message=assistant,
        intent_draft=intent,
        suggested_next_actions=actions,
    )


async def prepare_turn(payload: ChatPrimeRequest) -> ChatPrimeResponse:
    prepare_token = str(uuid.uuid4())
    expires_at = (datetime.now(UTC) + timedelta(minutes=5)).isoformat()
    return ChatPrimeResponse(
        prepare_token=prepare_token,
        expires_at=expires_at,
        session_id=payload.session_id,
        attachment_warning=None,
    )
