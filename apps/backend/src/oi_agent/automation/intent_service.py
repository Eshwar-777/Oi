from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import cast

from oi_agent.automation.app_attachment import evaluate_app_attachment
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
    GoalType,
    IntentDraft,
)
from oi_agent.automation.response_composer import compose_intent_response
from oi_agent.automation.session_context import build_session_context, merge_with_active_intent
from oi_agent.automation.store import get_prepared_turn, save_intent, save_session_turn


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _decision(
    *,
    goal_type: str,
    missing_fields: list[str],
    timing_mode: str,
    can_automate: bool,
    requires_confirmation: bool,
) -> ConversationDecision:
    if goal_type == "general_chat":
        return "GENERAL_CHAT"
    if missing_fields:
        return "ASK_CLARIFICATION"
    if not can_automate or goal_type != "ui_automation":
        return "BLOCKED"
    if timing_mode == "unknown":
        return "ASK_EXECUTION_MODE"
    if requires_confirmation:
        return "REQUIRES_CONFIRMATION"
    if timing_mode == "immediate":
        return "READY_TO_EXECUTE"
    if timing_mode in {"once", "interval"}:
        return "READY_TO_SCHEDULE"
    return "READY_FOR_MULTI_TIME_SCHEDULE"


async def understand_turn(payload: ChatTurnRequest) -> ChatTurnResponse:
    from oi_agent.api.websocket import connection_manager

    if payload.prepare_token:
        prepared = await get_prepared_turn(payload.prepare_token)
        if prepared and prepared.get("session_id") != payload.session_id:
            payload.prepare_token = None

    user_turn_id = str(uuid.uuid4())
    combined_text = flatten_inputs(payload.inputs)
    await save_session_turn(
        payload.session_id,
        user_turn_id,
        {
            "turn_id": user_turn_id,
            "session_id": payload.session_id,
            "role": "user",
            "text": combined_text,
            "timestamp": _now_iso(),
        },
    )
    await publish_event(
        session_id=payload.session_id,
        run_id=None,
        event_type="understanding.started",
        payload={"label": "Analyzing your request"},
    )
    requested_model = payload.client_context.model
    resolved_model, _ = resolve_model_selection(requested_model)
    extracted = await extract_intent(combined_text, requested_model=requested_model)
    session_context = await build_session_context(payload.session_id)
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
    else:
        entities = dict(extracted.entities)
        missing_fields = list(extracted.missing_fields)
        timing_mode = extracted.timing_mode
        timing_candidates = list(extracted.timing_candidates)
        goal_type = cast(GoalType, extracted.goal_type)
        can_automate = extracted.can_automate
        risk_flags = list(extracted.risk_flags)
        user_goal = str(combined_text or extracted.user_goal or "Untitled request")
    attachment_status = evaluate_app_attachment(
        app_name=str(entities.get("app", "") or "").strip() or None,
        attached_rows=connection_manager.list_attached_targets(),
    )
    requires_confirmation = bool(risk_flags)
    decision = _decision(
        goal_type=goal_type,
        missing_fields=missing_fields,
        timing_mode=timing_mode,
        can_automate=can_automate,
        requires_confirmation=requires_confirmation,
    )
    if attachment_status and not attachment_status.attached:
        decision = "BLOCKED"

    intent = IntentDraft(
        intent_id=str(uuid.uuid4()),
        session_id=payload.session_id,
        user_goal=user_goal or combined_text or extracted.user_goal or "Untitled request",
        goal_type=goal_type,
        normalized_inputs=payload.inputs,
        entities=entities,
        missing_fields=missing_fields,
        timing_mode=timing_mode,  # type: ignore[arg-type]
        timing_candidates=timing_candidates,
        can_automate=can_automate,
        confidence=extracted.confidence,
        model_id=resolved_model,
        decision=decision,
        requires_confirmation=requires_confirmation,
        risk_flags=risk_flags,
        attachment_warning=attachment_status.message if attachment_status and not attachment_status.attached else None,
    )
    assistant, actions = compose_intent_response(intent)
    intent_row = intent.model_dump(mode="json")
    intent_row["_saved_at"] = _now_iso()
    await save_intent(intent.intent_id, intent_row)
    assistant_turn_id = str(uuid.uuid4())
    await save_session_turn(
        payload.session_id,
        assistant_turn_id,
        {
            "turn_id": assistant_turn_id,
            "session_id": payload.session_id,
            "role": "assistant",
            "text": assistant.text,
            "timestamp": _now_iso(),
            "decision": intent.decision,
            "intent_id": intent.intent_id,
        },
    )
    await publish_event(
        session_id=payload.session_id,
        run_id=None,
        event_type="understanding.completed",
        payload={"intent_id": intent.intent_id, "decision": intent.decision},
    )
    if intent.decision == "ASK_CLARIFICATION":
        await publish_event(
            session_id=payload.session_id,
            run_id=None,
            event_type="clarification.requested",
            payload={
                "intent_id": intent.intent_id,
                "question": assistant.text,
                "missing_fields": intent.missing_fields,
            },
        )
    elif intent.decision == "ASK_EXECUTION_MODE":
        await publish_event(
            session_id=payload.session_id,
            run_id=None,
            event_type="execution_mode.requested",
            payload={
                "intent_id": intent.intent_id,
                "question": assistant.text,
                "allowed_modes": ["immediate", "once", "interval", "multi_time"],
            },
        )
    elif intent.decision == "REQUIRES_CONFIRMATION":
        await publish_event(
            session_id=payload.session_id,
            run_id=None,
            event_type="confirmation.requested",
            payload={
                "intent_id": intent.intent_id,
                "message": assistant.text,
            },
        )
    return ChatTurnResponse(
        assistant_message=assistant,
        intent_draft=intent,
        suggested_next_actions=actions,
    )


async def prepare_turn(payload: ChatPrimeRequest) -> ChatPrimeResponse:
    from oi_agent.api.websocket import connection_manager

    prepare_token = str(uuid.uuid4())
    expires_at = (datetime.now(UTC) + timedelta(minutes=5)).isoformat()
    partial_text = flatten_inputs(payload.partial_inputs)
    partial_entities = _extract_entities_fallback(partial_text)
    attachment_status = evaluate_app_attachment(
        app_name=str(partial_entities.get("app", "") or "").strip() or None,
        attached_rows=connection_manager.list_attached_targets(),
    )
    return ChatPrimeResponse(
        prepare_token=prepare_token,
        expires_at=expires_at,
        session_id=payload.session_id,
        attachment_warning=attachment_status.message if attachment_status and not attachment_status.attached else None,
    )
