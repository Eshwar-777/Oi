from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Any

from oi_agent.automation.conversation_task import (
    AssistantReplyPayload,
    ConversationConfirmation,
    ConversationIntentType,
    ConversationResolution,
    ConversationTask,
    ConversationTiming,
)
from oi_agent.automation.conversation_task_shape import TaskShape, infer_task_shape, normalize_text
from oi_agent.automation.intent_extractor import extract_intent
from oi_agent.automation.slot_extractor import extract_slots_for_fields

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

_FOLLOW_UP_DETAIL_PATTERNS = (
    "subject ",
    "subject:",
    "body ",
    "body:",
    "message ",
    "message:",
    "recipient ",
    "recipient:",
    "to ",
    "tomorrow",
    "today",
    "at ",
    "every ",
    "daily",
    "weekly",
    "hourly",
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


def classify_turn_mode(task: ConversationTask | None, text: str) -> ConversationIntentType:
    normalized = normalize_text(text)
    if not normalized:
        return "continue_task" if task else "general_chat"

    if task and task.phase == "awaiting_confirmation":
        if parse_confirmation_reply(text) is not None:
            return "continue_task"

    if task and task.active_run_id:
        if parse_run_action(text) is not None:
            return "run_control"
        if task.phase in {"completed", "failed", "cancelled"}:
            return "new_task"
        if _is_likely_new_request(text, task):
            return "new_task"
        return "continue_task"

    if task and task.phase == "general_chat":
        return "new_task" if _is_likely_new_request(text, task) else "general_chat"

    if task and task.phase in {"completed", "failed", "cancelled"}:
        return "new_task"

    if task:
        if task.phase in {"collecting_requirements", "awaiting_timing"} and not _is_likely_new_request(text, task):
            return "continue_task"
        return "continue_task"

    return "general_chat"


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


def _extract_email(text: str) -> str | None:
    match = re.search(r"([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})", text, flags=re.IGNORECASE)
    return match.group(1) if match else None


async def _merge_schema_slots(
    text: str,
    slots: dict[str, Any],
    field_names: list[str],
    requested_model: str | None,
) -> dict[str, Any]:
    if not field_names:
        return dict(slots)
    extracted = await extract_slots_for_fields(
        text,
        [field_name for field_name in field_names if not str(slots.get(field_name, "") or "").strip()],
        requested_model=requested_model,
    )
    merged = dict(slots)
    merged.update(extracted)
    if not merged.get("message_text") and merged.get("body"):
        merged["message_text"] = merged["body"]
    if not merged.get("body") and merged.get("message_text"):
        merged["body"] = merged["message_text"]
    return merged


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


def _requires_checkout_details(goal: str, extracted_missing_fields: list[str]) -> bool:
    lowered = normalize_text(goal)
    if not lowered:
        return False
    browse_before_checkout_markers = (
        "find ",
        "search",
        "look for",
        "browse",
        "select ",
        "choose ",
        "pick ",
        "first from the list",
        "first result",
        "from the list",
        "under ",
        "less than ",
        "add to cart",
    )
    stop_before_payment_markers = (
        "stop before payment",
        "stop at payment",
        "before payment confirmation",
        "before placing the order",
        "before placing order",
        "before final payment",
        "up to payment confirmation",
    )
    if any(marker in lowered for marker in stop_before_payment_markers):
        return False
    if any(marker in lowered for marker in browse_before_checkout_markers):
        return False
    if any(field in {"payment_method", "shipping_address"} for field in extracted_missing_fields):
        return True
    purchase_markers = (
        "checkout",
        "buy now",
        "purchase",
        "order it",
        "pay ",
    )
    if any(marker in lowered for marker in purchase_markers):
        return True
    return bool(re.search(r"\b(?:place|complete|submit|finish)\s+(?:an?\s+|the\s+)?order\b", lowered))


def _checkout_related_fields(goal: str, extracted_missing_fields: list[str]) -> list[str]:
    lowered = normalize_text(goal)
    if not lowered:
        return []
    has_checkout_markers = any(
        marker in lowered
        for marker in (
            "checkout",
            "buy now",
            "purchase",
            "order it",
            "place order",
            "place an order",
            "place the order",
            "complete order",
            "complete the order",
            "finish order",
            "finish the order",
        )
    )
    if not has_checkout_markers and not any(
        field in {"payment_method", "shipping_address", "payment_details", "billing_details", "billing_address"}
        for field in extracted_missing_fields
    ):
        return []
    return ["payment_method", "shipping_address"]


def _is_browser_context_satisfied_missing_field(field: str, slots: dict[str, Any], goal: str) -> bool:
    normalized = normalize_text(field)
    if not normalized:
        return False
    current_url = str(slots.get("current_url", "") or "").strip()
    current_title = str(slots.get("current_title", "") or "").strip()
    attached_browser_context = bool(
        str(slots.get("app", "") or "").strip()
        or current_url
        or current_title
    )
    if not attached_browser_context:
        return False
    if normalized in {"target", "app", "site", "website"}:
        return True
    if any(token in normalized for token in ("commerce site", "shopping site", "browser site", "current site")):
        return True
    if any(token in normalized for token in ("product to search for", "search query", "search term", "product query")):
        # If the active page is already a non-home browsing/search surface, let the runtime continue from live state.
        if current_url or current_title:
            return True
    return False


def _missing_fields(slots: dict[str, Any], extracted_missing_fields: list[str], goal: str) -> list[str]:
    if _is_browser_cross_app_transfer_request(goal):
        return []
    missing: list[str] = []
    attached_browser_context = bool(
        str(slots.get("app", "") or "").strip()
        or str(slots.get("current_url", "") or "").strip()
        or str(slots.get("current_title", "") or "").strip()
    )
    requires_checkout = _requires_checkout_details(goal, extracted_missing_fields)
    filtered_extracted_fields = list(extracted_missing_fields)
    if requires_checkout:
        filtered_extracted_fields = [
            field
            for field in filtered_extracted_fields
            if field not in {"payment_details", "billing_details", "billing_address"}
        ]
    else:
        filtered_extracted_fields = [
            field
            for field in filtered_extracted_fields
            if field not in {"payment_details", "payment_method", "shipping_address", "billing_details", "billing_address"}
        ]
    candidate_fields = list(dict.fromkeys(list(filtered_extracted_fields) + ["recipient", "subject", "message_text"]))
    wants_email = _is_email_composition_request(goal)
    email_content_delegated = _delegates_email_content(goal)
    delegated_choice = _delegates_choice(goal)
    for field in candidate_fields:
        if field == "target" and attached_browser_context:
            continue
        if _is_browser_context_satisfied_missing_field(field, slots, goal):
            continue
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
    if requires_checkout:
        if not str(slots.get("payment_method", "") or "").strip():
            missing.append("payment_method")
        if not str(slots.get("shipping_address", "") or "").strip():
            missing.append("shipping_address")
    return list(dict.fromkeys(missing))


def _clarification_hint_matches_missing_fields(hint: str, missing_fields: list[str]) -> bool:
    normalized_hint = normalize_text(hint)
    if not normalized_hint:
        return False
    for field in missing_fields:
        normalized_field = normalize_text(field.replace("_", " "))
        if normalized_field and normalized_field in normalized_hint:
            return True
    return False


def _clarification_question(missing_fields: list[str]) -> str:
    if missing_fields == ["payment_method"]:
        return "Which payment method should I use?"
    if missing_fields == ["shipping_address"]:
        return "What shipping address should I use?"
    if missing_fields == ["payment_method", "shipping_address"]:
        return "To complete the order, I need your preferred payment method and shipping address."
    if missing_fields == ["subject"]:
        return "What should the email subject be?"
    if missing_fields == ["message_text"]:
        return "What should the message or email body say?"
    if missing_fields == ["recipient"]:
        return "Who should I send it to?"
    joined = ", ".join(field.replace("_", " ") for field in missing_fields)
    return f"I need a bit more information before I can continue. Please provide: {joined}."

def _looks_like_follow_up_detail(text: str) -> bool:
    lowered = normalize_text(text)
    if not lowered:
        return False
    if parse_confirmation_reply(text) is not None or parse_run_action(text) is not None:
        return True
    if _extract_email(text):
        return True
    return any(lowered.startswith(pattern) for pattern in _FOLLOW_UP_DETAIL_PATTERNS)


def _is_likely_new_request(text: str, task: ConversationTask | None = None) -> bool:
    lowered = normalize_text(text)
    if not lowered or _looks_like_follow_up_detail(text):
        return False
    if len(lowered.split()) <= 3:
        return False
    next_shape = _infer_task_shape(text)
    explicit_request_language = any(token in lowered for token in ("open ", "send ", "create ", "book ", "go to ", "navigate ", "launch ", "schedule ", "find ", "search ", "reply ", "draft ", "write ", "remind me"))
    shape_implies_task = (
        next_shape.execution_surface in {"browser", "schedule"}
        or next_shape.cross_app_transfer
        or next_shape.timing_intent in {"once", "recurring", "immediate"}
    )
    if not explicit_request_language and not shape_implies_task:
        return False
    if task is None:
        return True

    current_goal = str(task.resolved_goal or task.user_goal or "").strip()
    current_shape = _infer_task_shape(current_goal) if current_goal else TaskShape()

    if next_shape.timing_intent in {"once", "recurring", "immediate"} and task.phase not in {"awaiting_timing", "collecting_requirements"}:
        return True
    if next_shape.apps and current_shape.apps and next_shape.apps != current_shape.apps:
        return True
    if next_shape.cross_app_transfer and not current_shape.cross_app_transfer:
        return True
    if next_shape.requires_live_ui and not current_shape.requires_live_ui and next_shape.execution_surface == "browser":
        return True
    if next_shape.operation_chain and current_shape.operation_chain and next_shape.operation_chain != current_shape.operation_chain:
        return True
    if next_shape.operation_chain and not current_shape.operation_chain:
        return True
    return False


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
    turn_mode = classify_turn_mode(task, text)

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

    if turn_mode == "run_control" and task and task.active_run_id and task.phase in {"awaiting_user_action", "executing", "failed"}:
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
                intent_type=turn_mode,
            )

    if task and task.execution.missing_fields and not _is_likely_new_request(text, task):
        slots = await _merge_schema_slots(text, dict(task.slots), task.execution.missing_fields, requested_model)
        missing_fields = [
            field
            for field in task.execution.missing_fields
            if not str(slots.get(field, "") or "").strip()
            and not (field == "message_text" and str(slots.get("body", "") or "").strip())
        ]
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
                    "user_goal": task.user_goal,
                    "resolved_goal": task.resolved_goal,
                    "slots": slots,
                    "timing": timing.model_dump(mode="json"),
                    "confirmation": confirmation.model_dump(mode="json"),
                    "execution": {
                        **task.execution.model_dump(mode="json"),
                        "missing_fields": [],
                        "clarification_question": None,
                    },
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
            task_patch={
                "user_goal": task.user_goal,
                "resolved_goal": task.resolved_goal,
                "slots": slots,
                "timing": timing.model_dump(mode="json"),
                "confirmation": {
                    **confirmation.model_dump(mode="json"),
                    "confirmed": True if not confirmation.required else confirmation.confirmed,
                },
                "execution": {
                    **task.execution.model_dump(mode="json"),
                    "missing_fields": [],
                    "clarification_question": None,
                },
            },
            next_phase="ready_to_execute",
            action_request=action_request,  # type: ignore[arg-type]
            confidence=0.95,
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
            intent_type=turn_mode,
        )

    goal = extracted.user_goal or (task.user_goal if task else text.strip())
    precomputed_missing_fields = _missing_fields(slots, extracted.missing_fields, goal)
    optional_checkout_fields = [
        field
        for field in _checkout_related_fields(goal, extracted.missing_fields)
        if not str(slots.get(field, "") or "").strip()
    ]
    slots = await _merge_schema_slots(
        text,
        slots,
        list(dict.fromkeys(precomputed_missing_fields + optional_checkout_fields)),
        requested_model,
    )
    if _should_default_to_immediate(
        goal=goal,
        task_kind=extracted.task_kind,
        extracted_timing_mode=extracted.timing_mode,
    ):
        timing.mode = "immediate"
    missing_fields = _missing_fields(slots, extracted.missing_fields, goal)
    confirmation = _requires_confirmation(goal, slots, extracted.risk_flags)

    if missing_fields:
        hinted_question = extracted.clarification_hints[0] if extracted.clarification_hints else ""
        question = (
            hinted_question
            if hinted_question and _clarification_hint_matches_missing_fields(hinted_question, missing_fields)
            else _clarification_question(missing_fields)
        )
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
            intent_type="new_task" if turn_mode == "new_task" or task is None else "continue_task",
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
            intent_type="new_task" if turn_mode == "new_task" or task is None else "continue_task",
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
            intent_type="new_task" if turn_mode == "new_task" or task is None else "continue_task",
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
        intent_type="new_task" if turn_mode == "new_task" or task is None else "continue_task",
    )
