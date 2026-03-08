from __future__ import annotations

import uuid
from typing import Any

from oi_agent.automation.models import AssistantMessage, IntentDraft, SuggestedNextAction

_FIELD_LABELS = {
    "goal": "what you want me to do",
    "message_text": "the message you want to send",
    "recipient": "who this should go to",
    "app": "which app to use",
    "timing_mode": "when and how to run it",
}


def _label_for_field(field_name: str) -> str:
    return _FIELD_LABELS.get(field_name, field_name.replace("_", " "))


def _join_human_labels(fields: list[str]) -> str:
    labels = [_label_for_field(field) for field in fields]
    if not labels:
        return "one more detail"
    if len(labels) == 1:
        return labels[0]
    if len(labels) == 2:
        return f"{labels[0]} and {labels[1]}"
    return f"{', '.join(labels[:-1])}, and {labels[-1]}"


def assistant_message(text: str) -> AssistantMessage:
    return AssistantMessage(message_id=str(uuid.uuid4()), text=text)


def _is_greeting(text: str) -> bool:
    normalized = " ".join((text or "").strip().lower().split())
    return normalized in {
        "hi",
        "hello",
        "hey",
        "hii",
        "yo",
        "good morning",
        "good afternoon",
        "good evening",
    }


def compose_intent_response(intent: IntentDraft) -> tuple[AssistantMessage, list[SuggestedNextAction]]:
    if intent.decision == "GENERAL_CHAT" or intent.goal_type == "general_chat":
        if _is_greeting(intent.user_goal):
            text = "Hi. I can help you automate something or answer a question."
        else:
            text = "I can help with questions or UI automation. What would you like to do?"
        return assistant_message(text), []

    if intent.decision == "ASK_CLARIFICATION":
        recipient = str(intent.entities.get("recipient", "") or "").strip()
        if "app" in intent.missing_fields and recipient and "MESSAGE_SEND" in intent.risk_flags:
            text = f"I can help with that. Which app should I use to message {recipient.title()}?"
        elif "message_text" in intent.missing_fields and recipient and "MESSAGE_SEND" in intent.risk_flags:
            text = f"I can help with that. What message should I send to {recipient.title()}?"
        elif "recipient" in intent.missing_fields and str(intent.entities.get("message_text", "") or "").strip():
            text = "I can help with that. Who should I send it to?"
        else:
            text = f"I understand the task, but I still need {_join_human_labels(intent.missing_fields)}."
        return assistant_message(text), [
            SuggestedNextAction(type="reply_text", label="Reply", payload={"intent_id": intent.intent_id})
        ]

    if intent.decision == "ASK_EXECUTION_MODE":
        text = "I understand the task. Do you want me to run it now, schedule it for later, or repeat it on a schedule?"
        return assistant_message(text), [
            SuggestedNextAction(type="select_execution_mode", label="Choose run mode", payload={"intent_id": intent.intent_id})
        ]

    if intent.decision == "REQUIRES_CONFIRMATION":
        text = "I understand the task, but it may trigger a sensitive action. Please confirm before I continue."
        return assistant_message(text), [
            SuggestedNextAction(type="confirm", label="Confirm", payload={"intent_id": intent.intent_id})
        ]

    if intent.decision == "READY_TO_EXECUTE":
        return assistant_message("I understand the task and it is ready to run."), [
            SuggestedNextAction(type="start_run", label="Run now", payload={"intent_id": intent.intent_id, "mode": "immediate"})
        ]

    if intent.decision == "READY_FOR_MULTI_TIME_SCHEDULE":
        return assistant_message("I understand the task and can schedule it at multiple times."), [
            SuggestedNextAction(type="open_schedule_builder", label="Review schedule", payload={"intent_id": intent.intent_id, "mode": "multi_time"})
        ]

    if intent.decision == "READY_TO_SCHEDULE":
        return assistant_message("I understand the task and can schedule it."), [
            SuggestedNextAction(type="open_schedule_builder", label="Review schedule", payload={"intent_id": intent.intent_id, "mode": intent.timing_mode})
        ]

    if intent.decision == "BLOCKED" and intent.attachment_warning:
        return assistant_message(intent.attachment_warning), [
            SuggestedNextAction(type="reply_text", label="Attach app and retry", payload={"intent_id": intent.intent_id})
        ]

    return assistant_message("I understand the request, but it is not ready for automation yet."), [
        SuggestedNextAction(type="reply_text", label="Refine request", payload={"intent_id": intent.intent_id})
    ]


def compose_resolution_message(status: str) -> AssistantMessage:
    if status == "awaiting_confirmation":
        return assistant_message("This task is ready for confirmation before execution.")
    if status == "queued":
        return assistant_message("The task has been queued and is ready to start.")
    return assistant_message("The task has been scheduled.")


def compose_confirmation_message(confirmed: bool) -> AssistantMessage:
    if not confirmed:
        return assistant_message("The confirmation was declined, so I cancelled the prepared run.")
    return assistant_message("Confirmation received. The task is ready.")


def compose_run_action_message(action: str) -> AssistantMessage:
    mapping = {
        "pause": "The run is paused.",
        "resume": "The run is ready to continue.",
        "approve_sensitive_action": "Sensitive action approved. The run is resuming.",
        "stop": "The run has been stopped.",
        "retry": "A retry has been requested.",
    }
    return assistant_message(mapping.get(action, "The run was updated."))


def compose_interruption_message(reason: str | None = None) -> AssistantMessage:
    return assistant_message(reason or "I noticed activity on the page, so I paused to avoid conflicting actions.")


def compose_completion_payload(result_text: str | None = None) -> dict[str, Any]:
    return {"message": result_text or "The task completed successfully."}


def compose_cancellation_payload() -> dict[str, Any]:
    return {"message": "I stopped the task because it was interrupted or cancelled."}
