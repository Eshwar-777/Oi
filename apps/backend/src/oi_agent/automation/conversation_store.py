from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from oi_agent.automation.conversation_task import ConversationTask
from oi_agent.automation.store import (
    delete_conversation as delete_conversation_record,
)
from oi_agent.automation.store import (
    delete_conversation_task,
    find_conversation_task_for_conversation,
    find_conversation_task_for_session,
    get_conversation,
    list_conversation_tasks_for_conversation,
    save_conversation,
    save_conversation_task,
)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def load_conversation_task(user_id: str, session_id: str) -> ConversationTask | None:
    row = await find_conversation_task_for_session(user_id, session_id)
    if not row:
        return None
    return ConversationTask.model_validate(row)


async def load_conversation_task_by_conversation_id(
    user_id: str,
    conversation_id: str,
) -> ConversationTask | None:
    row = await find_conversation_task_for_conversation(user_id, conversation_id)
    if not row:
        return None
    return ConversationTask.model_validate(row)


async def load_conversation(user_id: str, conversation_id: str) -> dict[str, Any] | None:
    row = await get_conversation(conversation_id)
    if not row or row.get("user_id") != user_id:
        return None
    return row


async def create_conversation_record(
    *,
    user_id: str,
    title: str,
    session_id: str,
    model_id: str | None,
    automation_engine: str | None = None,
    conversation_id: str | None = None,
) -> dict[str, Any]:
    now = _now_iso()
    resolved_conversation_id = str(conversation_id or uuid.uuid4())
    record: dict[str, Any] = {
        "conversation_id": resolved_conversation_id,
        "user_id": user_id,
        "session_id": session_id,
        "title": title,
        "summary": "",
        "created_at": now,
        "updated_at": now,
        "selected_model": model_id or "auto",
        "selected_automation_engine": str(automation_engine or "agent_browser"),
        "last_assistant_text": None,
        "last_user_text": None,
        "last_run_state": None,
        "has_unread_updates": False,
        "has_errors": False,
        "badges": [],
    }
    await save_conversation(resolved_conversation_id, record)
    return record


async def create_conversation_task(
    *,
    user_id: str,
    conversation_id: str,
    session_id: str,
    goal: str,
    model_id: str | None,
    automation_engine: str | None,
    timezone: str,
) -> ConversationTask:
    now = _now_iso()
    task = ConversationTask(
        task_id=str(uuid.uuid4()),
        conversation_id=conversation_id,
        legacy_intent_id=str(uuid.uuid4()),
        session_id=session_id,
        user_id=user_id,
        user_goal=goal,
        resolved_goal=goal,
        model_id=model_id,
        automation_engine=str(automation_engine or "agent_browser"),  # type: ignore[arg-type]
        created_at=now,
        updated_at=now,
    )
    task.timing.timezone = timezone or "UTC"
    await save_task(task)
    return task


async def save_task(task: ConversationTask) -> ConversationTask:
    task.updated_at = _now_iso()
    await save_conversation_task(task.task_id, task.model_dump(mode="json"))
    return task


async def delete_conversation_data(user_id: str, conversation_id: str) -> bool:
    conversation = await load_conversation(user_id, conversation_id)
    if conversation is None:
        return False

    tasks = await list_conversation_tasks_for_conversation(user_id, conversation_id)
    for task in tasks:
        task_id = str(task.get("task_id", "") or "").strip()
        if task_id:
            await delete_conversation_task(task_id)

    await delete_conversation_record(conversation_id)
    return True
