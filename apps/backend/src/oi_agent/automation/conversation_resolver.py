from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Any

from oi_agent.automation.conversation_task import (
    AssistantReplyPayload,
    ConversationConfirmation,
    ConversationResolution,
    ConversationTask,
    ConversationTiming,
)
from oi_agent.automation.conversation_task_shape import TaskShape, infer_task_shape, normalize_text
from oi_agent.automation.intent_extractor import extract_intent

_IMMEDIATE_TERMS = {"now", "right now", "immediately", "asap", "run now"}
_CONFIRM_TERMS = {"yes", "confirm", "confirmed", "proceed", "go ahead", "continue", "yes confirm", "yes you can proceed"}
_DECLINE_TERMS = {"no", "cancel", "stop", "don't", "do not", "no cancel"}
_RUN_ACTION_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("approve", ("approve", "approve it", "approve and continue", "allow it")),
    ("retry", ("retry", "try again", "rerun", "run again")),
    ("resume", ("resume", "continue", "continue it", "done", "i fixed it", "fixed it")),
    ("pause", ("pause", "hold on", "pause it")),
    ("stop", ("stop", "cancel it", "cancel run", "stop run", "abort")),
)

def _infer_task_shape(goal: str) -> TaskShape:
    return infer_task_shape(goal)


def parse_confirmation_reply(text: str) -> bool | None:
    normalized = normalize_text(text)
    if not normalized:
        return None
    if normalized in _CONFIRM_TERMS:
        return True
    if normalized in _DECLINE_TERMS:
        return False
    return None


def parse_run_action(text: str) -> str | None:
    normalized = normalize_text(text)
    if not normalized:
        return None
    for action, phrases in _RUN_ACTION_PATTERNS:
        if normalized in phrases:
            return action
    return None


def _extract_email(text: str) -> str | None:
    match = re.search(r"([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})", text, flags=re.IGNORECASE)
    return match.group(1) if match else None


def _parse_datetime_candidate(candidate: str) -> str | None:
    raw = candidate.strip()
    if not raw:
        return None
    for value in (raw, raw.replace("Z", "+00:00")):
        try:
            parsed = datetime.fromisoformat(value)
        except ValueError:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        return parsed.astimezone(UTC).isoformat()
    match = re.search(r"tomorrow(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?", raw.lower())
    if match:
        hour = int(match.group(1))
        minute = int(match.group(2) or "0")
        meridiem = match.group(3)
        if meridiem == "pm" and hour < 12:
            hour += 12
        if meridiem == "am" and hour == 12:
            hour = 0
        base = datetime.now(UTC) + timedelta(days=1)
        return base.replace(hour=hour, minute=minute, second=0, microsecond=0).isoformat()
    return None


def _parse_interval_seconds(text: str) -> int | None:
    normalized = normalize_text(text)
    match = re.search(r"every (\d+)\s*(second|seconds|minute|minutes|hour|hours|day|days|week|weeks)", normalized)
    if match:
        value = int(match.group(1))
        unit = match.group(2)
        multiplier = 1
        if unit.startswith("minute"):
            multiplier = 60
        elif unit.startswith("hour"):
            multiplier = 3600
        elif unit.startswith("day"):
            multiplier = 86400
        elif unit.startswith("week"):
            multiplier = 604800
        return max(1, value * multiplier)
    if "hourly" in normalized:
        return 3600
    if "daily" in normalized or "every day" in normalized:
        return 86400
    if "weekly" in normalized or "every week" in normalized:
        return 604800
    return None


def _normalize_timing(text: str, timezone: str, extracted_timing_mode: str, timing_candidates: list[str]) -> ConversationTiming:
    normalized = normalize_text(text)
    timing = ConversationTiming(timezone=timezone or "UTC", raw_user_text=text)
    if extracted_timing_mode == "immediate" or any(term in normalized for term in _IMMEDIATE_TERMS):
        timing.mode = "immediate"
        return timing
    if extracted_timing_mode in {"interval", "multi_time"} or any(token in normalized for token in ("every ", "daily", "weekly", "hourly")):
        interval_seconds = _parse_interval_seconds(text)
        if interval_seconds is None:
            for candidate in timing_candidates:
                interval_seconds = _parse_interval_seconds(candidate)
                if interval_seconds is not None:
                    break
        if interval_seconds is not None:
            timing.mode = "recurring"
            timing.recurrence = {"interval_seconds": interval_seconds, "type": "interval"}
        return timing

    candidates = [text, *timing_candidates]
    run_at = [value for value in (_parse_datetime_candidate(candidate) for candidate in candidates) if value]
    if extracted_timing_mode == "once" or run_at:
        timing.mode = "once"
        timing.run_at = run_at[:1]
    return timing


def _requires_confirmation(goal: str, slots: dict[str, Any], risk_flags: list[str]) -> ConversationConfirmation:
    recipient = str(slots.get("recipient", "") or "")
    subject = "execute this automation"
    if recipient:
        subject = f"send to {recipient}"
    if any(flag in {"SENSITIVE_ACTION"} for flag in risk_flags):
        return ConversationConfirmation(
            required=True,
            subject=subject,
            reason="This may trigger a sensitive action.",
        )
    return ConversationConfirmation(required=False, subject=subject)


def _delegates_email_content(goal: str) -> bool:
    lowered_goal = normalize_text(goal)
    delegation_phrases = (
        "anything you want",
        "any thing you want",
        "whatever you want",
        "any subject",
        "any body",
        "any message",
        "write anything",
        "say anything",
        "make up the subject",
        "make up the message",
        "compose anything",
        "arbitrary content",
    )
    return any(phrase in lowered_goal for phrase in delegation_phrases)


def _delegates_choice(goal: str) -> bool:
    lowered_goal = normalize_text(goal)
    delegation_phrases = (
        "any suitable",
        "any good",
        "any decent",
        "any option",
        "any one",
        "choose one",
        "pick one",
        "choose yourself",
        "pick yourself",
        "decide yourself",
        "you choose",
        "you pick",
        "best option",
        "best one",
        "whatever fits",
        "whichever fits",
        "select one for me",
        "choose for me",
        "pick for me",
        "continue without asking",
    )
    return any(phrase in lowered_goal for phrase in delegation_phrases)


def _is_selection_field(field: str) -> bool:
    normalized = field.strip().lower()
    if normalized in {"selection", "choice", "option", "item", "target"}:
        return True
    return any(token in normalized for token in ("product", "listing", "selection", "choice", "option"))


def _is_email_composition_request(goal: str) -> bool:
    lowered_goal = normalize_text(goal)
    task_shape = _infer_task_shape(goal)
    if task_shape.cross_app_transfer:
        return False
    composition_verbs = (
        "send",
        "compose",
        "reply",
        "forward",
        "write",
    )
    composition_fields = (
        "subject",
        "body",
        "message text",
        "message_text",
        "recipient",
    )
    if any(field in lowered_goal for field in composition_fields):
        return True
    if any(verb in lowered_goal for verb in composition_verbs):
        return "email" in lowered_goal or "gmail" in lowered_goal
    if "draft" in lowered_goal:
        draft_folder_signals = (
            "drafts folder",
            "drafts view",
            "open drafts",
            "go to drafts",
            "latest draft",
            "visible draft",
        )
        if any(signal in lowered_goal for signal in draft_folder_signals):
            return False
        return "email" in lowered_goal or "gmail" in lowered_goal
    return False


def _is_browser_cross_app_transfer_request(goal: str) -> bool:
    task_shape = _infer_task_shape(goal)
    return task_shape.cross_app_transfer and (
        task_shape.visible_state_dependence or task_shape.requires_live_ui
    )


def _missing_fields(slots: dict[str, Any], extracted_missing_fields: list[str], goal: str) -> list[str]:
    if _is_browser_cross_app_transfer_request(goal):
        return []
    missing: list[str] = []
    candidate_fields = list(dict.fromkeys(list(extracted_missing_fields) + ["recipient", "subject", "message_text"]))
    wants_email = _is_email_composition_request(goal)
    email_content_delegated = _delegates_email_content(goal)
    delegated_choice = _delegates_choice(goal)
    for field in candidate_fields:
        if delegated_choice and _is_selection_field(field):
            continue
        if field == "recipient" and wants_email and not str(slots.get("recipient", "") or "").strip():
            missing.append(field)
        if (
            field == "subject"
            and wants_email
            and not email_content_delegated
            and not str(slots.get("subject", "") or "").strip()
        ):
            missing.append(field)
        if (
            field in {"message_text", "body"}
            and wants_email
            and not email_content_delegated
            and not str(slots.get("message_text", "") or slots.get("body", "") or "").strip()
        ):
            missing.append("message_text")
        if field not in {"recipient", "subject", "message_text", "body"} and not str(slots.get(field, "") or "").strip():
            missing.append(field)
    return list(dict.fromkeys(missing))


def _clarification_question(missing_fields: list[str]) -> str:
    if missing_fields == ["subject"]:
        return "What should the email subject be?"
    if missing_fields == ["message_text"]:
        return "What should the message or email body say?"
    if missing_fields == ["recipient"]:
        return "Who should I send it to?"
    joined = ", ".join(field.replace("_", " ") for field in missing_fields)
    return f"I need a bit more information before I can continue. Please provide: {joined}."


def _extract_slot_patch_from_reply(text: str, missing_fields: list[str]) -> dict[str, Any]:
    patch: dict[str, Any] = {}
    stripped = text.strip()
    if not stripped:
        return patch

    email = _extract_email(stripped)
    if "recipient" in missing_fields and email:
        patch["recipient"] = email

    subject_match = re.search(r"subject(?: should be| is|:)?\s+(.+)", stripped, flags=re.IGNORECASE)
    if "subject" in missing_fields and subject_match:
        patch["subject"] = subject_match.group(1).strip()

    body_match = re.search(r"(?:body|message|email should be|email body should be|text)(?: should be| is|:)?\s+(.+)", stripped, flags=re.IGNORECASE)
    if "message_text" in missing_fields and body_match:
        patch["message_text"] = body_match.group(1).strip()
        patch.setdefault("body", patch["message_text"])

    if "subject" in missing_fields and len(missing_fields) == 1 and "subject" not in patch:
        patch["subject"] = stripped
    if "message_text" in missing_fields and len(missing_fields) == 1 and "message_text" not in patch:
        patch["message_text"] = stripped
        patch["body"] = stripped
    generic_fields = [field for field in missing_fields if field not in {"recipient", "subject", "message_text", "body"}]
    if len(generic_fields) == 1 and generic_fields[0] not in patch:
        patch[generic_fields[0]] = stripped
    return patch


def _is_likely_new_request(text: str) -> bool:
    lowered = normalize_text(text)
    return any(token in lowered for token in ("open ", "send ", "create ", "book ", "go to ", "navigate ", "launch "))


def _should_default_to_immediate(
    *,
    goal: str,
    task_kind: str,
    extracted_timing_mode: str,
) -> bool:
    if extracted_timing_mode != "unknown":
        return False
    if task_kind != "browser_automation":
        return False
    task_shape = _infer_task_shape(goal)
    return task_shape.timing_intent == "unspecified"


async def resolve_turn(task: ConversationTask | None, text: str, timezone: str, requested_model: str | None) -> ConversationResolution:
    if task and task.phase == "awaiting_confirmation":
        confirmed = parse_confirmation_reply(text)
        if confirmed is not None:
            return ConversationResolution(
                assistant_reply=AssistantReplyPayload(
                    kind="confirmation",
                    text="Confirmed. I’m proceeding now." if confirmed else "Understood. I won’t continue with that automation.",
                ),
                next_phase="ready_to_execute" if confirmed else "cancelled",
                action_request="confirm",
                action_payload={"confirmed": confirmed},
                confidence=1.0,
                intent_type="continue_task",
            )

    if task and task.active_run_id and task.phase in {"awaiting_user_action", "executing", "failed"}:
        run_action = parse_run_action(text)
        if run_action:
            return ConversationResolution(
                assistant_reply=AssistantReplyPayload(
                    kind="status_update",
                    text="I’m handling that run update now.",
                ),
                next_phase=task.phase,
                action_request="run_control",
                action_payload={"action": run_action, "run_id": task.active_run_id},
                confidence=1.0,
                intent_type="run_control",
            )

    if task and task.execution.missing_fields and not _is_likely_new_request(text):
        patch = _extract_slot_patch_from_reply(text, task.execution.missing_fields)
        slots = dict(task.slots)
        slots.update(patch)
        missing_fields = [field for field in task.execution.missing_fields if field not in patch and not (field == "message_text" and patch.get("body"))]
        if missing_fields:
            question = _clarification_question(missing_fields)
            return ConversationResolution(
                assistant_reply=AssistantReplyPayload(kind="clarification", text=question),
                task_patch={
                    "slots": slots,
                    "execution": {
                        **task.execution.model_dump(mode="json"),
                        "missing_fields": missing_fields,
                        "clarification_question": question,
                    },
                },
                next_phase="collecting_requirements",
                action_request="ask",
                confidence=0.9,
            )
        timing = task.timing
        if timing.mode == "unknown":
            return ConversationResolution(
                assistant_reply=AssistantReplyPayload(
                    kind="clarification",
                    text="I understand the task. Tell me whether to run it now, later at a specific time, or on a repeating schedule.",
                ),
                task_patch={
                    "slots": slots,
                    "execution": {
                        **task.execution.model_dump(mode="json"),
                        "missing_fields": [],
                        "clarification_question": None,
                    },
                },
                next_phase="awaiting_timing",
                action_request="ask",
                confidence=0.9,
            )

    if task and task.phase == "awaiting_timing":
        timing = _normalize_timing(text, timezone, "unknown", [])
        if timing.mode == "unknown":
            return ConversationResolution(
                assistant_reply=AssistantReplyPayload(
                    kind="clarification",
                    text="Tell me to run it now, give me a specific time like `tomorrow at 9am`, or describe the repeating schedule.",
                ),
                next_phase="awaiting_timing",
                action_request="ask",
                confidence=0.9,
            )
        confirmation = task.confirmation
        action_request = "execute" if timing.mode == "immediate" else "schedule"
        if confirmation.required and confirmation.confirmed is not True:
            subject = confirmation.subject or "continue"
            return ConversationResolution(
                assistant_reply=AssistantReplyPayload(
                    kind="confirmation",
                    text=f"{confirmation.reason or 'This needs confirmation.'} Please confirm before I {subject}.",
                ),
                task_patch={
                    "timing": timing.model_dump(mode="json"),
                    "confirmation": confirmation.model_dump(mode="json"),
                },
                next_phase="awaiting_confirmation",
                action_request=action_request,  # type: ignore[arg-type]
                confidence=0.95,
            )
        return ConversationResolution(
            assistant_reply=AssistantReplyPayload(
                kind="status_update",
                text="I’m starting that now." if action_request == "execute" else "I’m creating that schedule now.",
            ),
            task_patch={"timing": timing.model_dump(mode="json")},
            next_phase="ready_to_execute",
            action_request=action_request,  # type: ignore[arg-type]
            confidence=0.95,
        )

    extracted = await extract_intent(text, requested_model=requested_model)
    timing = _normalize_timing(text, timezone, extracted.timing_mode, extracted.timing_candidates)
    slots = dict(getattr(task, "slots", {}) or {})
    slots.update(extracted.entities)
    if not slots.get("message_text") and slots.get("body"):
        slots["message_text"] = slots["body"]
    if not slots.get("body") and slots.get("message_text"):
        slots["body"] = slots["message_text"]

    if extracted.goal_type == "general_chat":
        return ConversationResolution(
            assistant_reply=AssistantReplyPayload(
                kind="reply",
                text=(
                    "Hi. I can help you automate something or answer a question."
                    if normalize_text(text) in {"hi", "hello", "hey", "hii", "yo"}
                    else "I can help with questions or UI automation. What would you like to do?"
                ),
            ),
            task_patch={
                "goal_type": "general_chat",
                "resolved_goal": extracted.user_goal,
                "execution": {
                    "task_kind": "general_chat",
                    "missing_fields": [],
                    "workflow_outline": [],
                    "risk_flags": [],
                    "clarification_question": None,
                },
                "timing": {"mode": "unknown", "timezone": timezone or "UTC", "run_at": [], "recurrence": {}, "raw_user_text": text},
            },
            next_phase="general_chat",
            action_request="reply",
            confidence=extracted.confidence,
            intent_type="general_chat",
        )

    goal = extracted.user_goal or (task.user_goal if task else text.strip())
    if _should_default_to_immediate(
        goal=goal,
        task_kind=extracted.task_kind,
        extracted_timing_mode=extracted.timing_mode,
    ):
        timing.mode = "immediate"
    missing_fields = _missing_fields(slots, extracted.missing_fields, goal)
    confirmation = _requires_confirmation(goal, slots, extracted.risk_flags)

    if missing_fields:
        question = extracted.clarification_hints[0] if extracted.clarification_hints else _clarification_question(missing_fields)
        return ConversationResolution(
            assistant_reply=AssistantReplyPayload(kind="clarification", text=question),
            task_patch={
                "user_goal": goal,
                "resolved_goal": goal,
                "goal_type": "ui_automation",
                "slots": slots,
                "timing": timing.model_dump(mode="json"),
                "confirmation": confirmation.model_dump(mode="json"),
                "execution": {
                    "task_kind": "ui_automation",
                    "missing_fields": missing_fields,
                    "workflow_outline": list(extracted.workflow_outline),
                    "risk_flags": list(extracted.risk_flags),
                    "clarification_question": question,
                },
            },
            next_phase="collecting_requirements",
            action_request="ask",
            confidence=extracted.confidence,
            intent_type="new_task" if task is None else "continue_task",
        )

    if timing.mode == "unknown":
        return ConversationResolution(
            assistant_reply=AssistantReplyPayload(
                kind="clarification",
                text="I understand the task. Tell me whether to run it now, later at a specific time, or on a repeating schedule.",
            ),
            task_patch={
                "user_goal": goal,
                "resolved_goal": goal,
                "goal_type": "ui_automation",
                "slots": slots,
                "timing": timing.model_dump(mode="json"),
                "confirmation": confirmation.model_dump(mode="json"),
                "execution": {
                    "task_kind": "ui_automation",
                    "missing_fields": [],
                    "workflow_outline": list(extracted.workflow_outline),
                    "risk_flags": list(extracted.risk_flags),
                    "clarification_question": None,
                },
            },
            next_phase="awaiting_timing",
            action_request="ask",
            confidence=extracted.confidence,
            intent_type="new_task" if task is None else "continue_task",
        )

    if confirmation.required and confirmation.confirmed is not True:
        subject = confirmation.subject or "this automation"
        return ConversationResolution(
            assistant_reply=AssistantReplyPayload(
                kind="confirmation",
                text=f"{confirmation.reason or 'This needs confirmation.'} Please confirm before I {subject}.",
            ),
            task_patch={
                "user_goal": goal,
                "resolved_goal": goal,
                "goal_type": "ui_automation",
                "slots": slots,
                "timing": timing.model_dump(mode="json"),
                "confirmation": confirmation.model_dump(mode="json"),
                "execution": {
                    "task_kind": "ui_automation",
                    "missing_fields": [],
                    "workflow_outline": list(extracted.workflow_outline),
                    "risk_flags": list(extracted.risk_flags),
                    "clarification_question": None,
                },
            },
            next_phase="awaiting_confirmation",
            action_request="confirm",
            confidence=extracted.confidence,
            intent_type="new_task" if task is None else "continue_task",
        )

    action_request = "execute" if timing.mode == "immediate" else "schedule"
    response_text = "I’m starting that now." if action_request == "execute" else "I’m creating that schedule now."
    return ConversationResolution(
        assistant_reply=AssistantReplyPayload(kind="status_update", text=response_text),
        task_patch={
            "user_goal": goal,
            "resolved_goal": goal,
            "goal_type": "ui_automation",
            "slots": slots,
            "timing": timing.model_dump(mode="json"),
            "confirmation": {**confirmation.model_dump(mode="json"), "confirmed": True if not confirmation.required else confirmation.confirmed},
            "execution": {
                "task_kind": "ui_automation",
                "missing_fields": [],
                "workflow_outline": list(extracted.workflow_outline),
                "risk_flags": list(extracted.risk_flags),
                "clarification_question": None,
            },
        },
        next_phase="ready_to_execute",
        action_request=action_request,  # type: ignore[arg-type]
        confidence=extracted.confidence,
        intent_type="new_task" if task is None else "continue_task",
    )
