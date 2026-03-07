from __future__ import annotations

import uuid

from oi_agent.automation.intent_extractor import extract_intent, flatten_inputs
from oi_agent.automation.models import ChatTurnRequest, ChatTurnResponse, ConversationDecision, IntentDraft
from oi_agent.automation.events import publish_event
from oi_agent.automation.response_composer import compose_intent_response
from oi_agent.automation.store import save_intent


def _decision(
    *,
    goal_type: str,
    missing_fields: list[str],
    timing_mode: str,
    can_automate: bool,
    requires_confirmation: bool,
) -> ConversationDecision:
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
    await publish_event(
        session_id=payload.session_id,
        run_id=None,
        event_type="understanding.started",
        payload={"label": "Analyzing your request"},
    )
    combined_text = flatten_inputs(payload.inputs)
    extracted = await extract_intent(combined_text)
    entities = extracted.entities
    missing_fields = extracted.missing_fields
    timing_mode = extracted.timing_mode
    timing_candidates = extracted.timing_candidates
    goal_type = extracted.goal_type
    can_automate = extracted.can_automate
    risk_flags = extracted.risk_flags
    requires_confirmation = bool(risk_flags)
    decision = _decision(
        goal_type=goal_type,
        missing_fields=missing_fields,
        timing_mode=timing_mode,
        can_automate=can_automate,
        requires_confirmation=requires_confirmation,
    )

    intent = IntentDraft(
        intent_id=str(uuid.uuid4()),
        session_id=payload.session_id,
        user_goal=extracted.user_goal or combined_text or "Untitled request",
        goal_type=goal_type,
        normalized_inputs=payload.inputs,
        entities=entities,
        missing_fields=missing_fields,
        timing_mode=timing_mode,  # type: ignore[arg-type]
        timing_candidates=timing_candidates,
        can_automate=can_automate,
        confidence=extracted.confidence,
        decision=decision,
        requires_confirmation=requires_confirmation,
        risk_flags=risk_flags,
    )
    await save_intent(intent.intent_id, intent.model_dump(mode="json"))
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
                "question": compose_intent_response(intent)[0].text,
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
                "question": compose_intent_response(intent)[0].text,
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
                "message": compose_intent_response(intent)[0].text,
            },
        )
    assistant, actions = compose_intent_response(intent)
    return ChatTurnResponse(
        assistant_message=assistant,
        intent_draft=intent,
        suggested_next_actions=actions,
    )
