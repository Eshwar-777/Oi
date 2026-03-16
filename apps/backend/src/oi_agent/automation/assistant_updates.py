from __future__ import annotations

import uuid
from datetime import UTC, datetime

from oi_agent.automation.conversation_task import ConversationTask
from oi_agent.automation.events import publish_event
from oi_agent.automation.store import (
    find_conversation_task_for_session,
    save_conversation_task,
    save_session_turn,
    update_conversation,
)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _badges_for_run_state(run_state: str, task: ConversationTask) -> list[str]:
    if run_state in {"running", "starting", "resuming", "retrying"}:
        return ["Running"]
    if run_state in {"waiting_for_user_action", "waiting_for_human", "paused"}:
        return ["Needs attention"]
    if task.phase == "scheduled":
        return ["Scheduled"]
    return []


def _apply_task_state_from_run(task: ConversationTask, run_state: str) -> None:
    if run_state in {"completed", "succeeded"}:
        task.phase = "completed"
        task.status = "completed"
        task.execution.active_run_action_needed = None
        return
    if run_state in {"failed"}:
        task.phase = "failed"
        task.status = "failed"
        task.execution.active_run_action_needed = run_state
        return
    if run_state in {"waiting_for_human", "waiting_for_user_action", "paused"}:
        task.phase = "awaiting_user_action"
        task.status = "active"
        task.execution.active_run_action_needed = run_state
        return
    if run_state in {"cancelled", "canceled"}:
        task.phase = "cancelled"
        task.status = "cancelled"
        task.execution.active_run_action_needed = None

async def publish_assistant_run_update(
    *,
    user_id: str,
    session_id: str,
    run_id: str,
    text: str,
    run_state: str,
) -> None:
    cleaned = str(text or "").strip()
    normalized_state = str(run_state or "").strip().lower()
    if not cleaned:
        return

    timestamp = _now_iso()
    should_persist_turn = normalized_state in {"completed", "failed", "waiting_for_human"}
    if should_persist_turn:
        turn_id = f"assistant-run:{run_id}:{normalized_state}:{uuid.uuid4()}"
        await save_session_turn(
            session_id,
            turn_id,
            {
                "turn_id": turn_id,
                "session_id": session_id,
                "user_id": user_id,
                "role": "assistant",
                "text": cleaned,
                "timestamp": timestamp,
                "metadata": {
                    "source": "run_update",
                    "run_id": run_id,
                    "run_state": normalized_state,
                },
            },
        )
        await publish_event(
            user_id=user_id,
            session_id=session_id,
            run_id=run_id,
            event_type="assistant.message",
            payload={"message_id": turn_id, "text": cleaned},
        )

    raw_task = await find_conversation_task_for_session(user_id, session_id)
    if not raw_task:
        return
    task = ConversationTask.model_validate(raw_task)
    if task.active_run_id and task.active_run_id != run_id:
        return

    task.last_assistant_message = cleaned
    task.updated_at = timestamp
    _apply_task_state_from_run(task, normalized_state)
    await save_conversation_task(task.task_id, task.model_dump(mode="json"))
    await update_conversation(
        task.conversation_id,
        {
            "updated_at": task.updated_at,
            "last_assistant_text": cleaned,
            "last_run_state": normalized_state,
            "has_unread_updates": normalized_state in {"running", "starting", "resuming", "retrying"},
            "has_errors": normalized_state in {"failed", "waiting_for_human", "waiting_for_user_action"},
            "badges": _badges_for_run_state(normalized_state, task),
        },
    )
