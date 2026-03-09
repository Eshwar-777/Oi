from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from oi_agent.automation.intent_extractor import derive_missing_fields
from oi_agent.automation.store import find_latest_intent_for_session, list_session_turns

ACTIVE_AUTOMATION_DECISIONS = {
    "ASK_CLARIFICATION",
    "ASK_EXECUTION_MODE",
    "REQUIRES_CONFIRMATION",
    "READY_TO_EXECUTE",
    "READY_TO_SCHEDULE",
    "READY_FOR_MULTI_TIME_SCHEDULE",
}

UPDATE_PREFIXES = (
    "actually",
    "instead",
    "use ",
    "change ",
    "make it ",
    "set it ",
    "run it ",
    "do it ",
    "send it ",
    "not ",
)

APP_NAMES = {
    "whatsapp",
    "gmail",
    "slack",
    "chrome",
    "notion",
    "telegram",
    "discord",
    "instagram",
    "linkedin",
    "spotify",
    "youtube",
}


@dataclass
class SessionContext:
    active_intent: dict[str, Any] | None = None
    recent_turns: list[dict[str, Any]] = field(default_factory=list)


def _word_count(text: str) -> int:
    return len([part for part in text.split() if part.strip()])


def _looks_like_message_answer(text: str) -> bool:
    lowered = text.strip().lower()
    if lowered.startswith("send "):
        lowered = lowered[5:].strip()
    if not lowered:
        return False
    if any(lowered.startswith(prefix) for prefix in UPDATE_PREFIXES):
        return False
    return _word_count(lowered) <= 8


def _looks_like_patch(current_text: str, extracted: Any, active_intent: dict[str, Any] | None) -> bool:
    if not active_intent:
        return False
    if active_intent.get("decision") not in ACTIVE_AUTOMATION_DECISIONS:
        return False

    lowered = current_text.strip().lower()
    if not lowered:
        return False
    if any(lowered.startswith(prefix) for prefix in UPDATE_PREFIXES):
        return True
    if extracted.timing_mode != "unknown":
        return True
    if any(app_name in lowered for app_name in APP_NAMES):
        return True
    if active_intent.get("decision") == "ASK_CLARIFICATION" and _looks_like_message_answer(current_text):
        return True
    if active_intent.get("goal_type") == "ui_automation" and extracted.goal_type == "general_chat" and _word_count(lowered) <= 8:
        return True
    return False


def merge_with_active_intent(
    *,
    current_text: str,
    extracted: Any,
    active_intent: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if not _looks_like_patch(current_text, extracted, active_intent):
        return None

    assert active_intent is not None
    previous_entities = dict(active_intent.get("entities") or {})
    merged_entities = dict(previous_entities)
    merged_entities.update(
        {key: value for key, value in extracted.entities.items() if value not in (None, "", [])}
    )

    previous_missing = [str(item) for item in list(active_intent.get("missing_fields") or [])]
    previous_risk_flags = [str(item) for item in list(active_intent.get("risk_flags") or [])]
    current_clean = current_text.strip()

    if (
        "message_text" in previous_missing
        and "MESSAGE_SEND" in previous_risk_flags
        and not str(extracted.entities.get("recipient", "")).strip()
        and not str(extracted.entities.get("app", "")).strip()
        and _looks_like_message_answer(current_text)
    ):
        candidate = current_clean
        if candidate.lower().startswith("send "):
            candidate = candidate[5:].strip()
        merged_entities["message_text"] = candidate

    timing_mode = extracted.timing_mode
    timing_candidates = list(extracted.timing_candidates)
    if timing_mode == "unknown":
        timing_mode = str(active_intent.get("timing_mode") or "unknown")
        timing_candidates = list(active_intent.get("timing_candidates") or [])

    missing_fields = derive_missing_fields(str(active_intent.get("user_goal") or current_text), merged_entities)
    if not missing_fields and previous_missing:
        # Preserve non-send clarification gaps if the previous intent still needs them.
        for field in previous_missing:
            if not str(merged_entities.get(field, "")).strip() and field not in missing_fields:
                missing_fields.append(field)

    return {
        "entities": merged_entities,
        "missing_fields": missing_fields,
        "timing_mode": timing_mode,
        "timing_candidates": timing_candidates,
        "goal_type": str(active_intent.get("goal_type") or extracted.goal_type),
        "can_automate": bool(active_intent.get("can_automate", extracted.can_automate)),
        "risk_flags": previous_risk_flags or list(extracted.risk_flags),
        "user_goal": str(active_intent.get("user_goal") or current_text),
        "source_intent_id": str(active_intent.get("intent_id") or ""),
    }


async def build_session_context(user_id: str, session_id: str) -> SessionContext:
    active_intent = await find_latest_intent_for_session(user_id, session_id)
    recent_turns = await list_session_turns(user_id, session_id, limit=12)
    return SessionContext(active_intent=active_intent, recent_turns=recent_turns)
