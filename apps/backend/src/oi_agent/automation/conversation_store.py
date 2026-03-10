from __future__ import annotations

import uuid
from datetime import UTC, datetime

from oi_agent.automation.conversation_task import ConversationTask
from oi_agent.automation.store import (
    find_conversation_task_for_session,
    save_conversation_task,
)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def load_conversation_task(user_id: str, session_id: str) -> ConversationTask | None:
    row = await find_conversation_task_for_session(user_id, session_id)
    if not row:
        return None
    return ConversationTask.model_validate(row)


async def create_conversation_task(
    *,
    user_id: str,
    session_id: str,
    goal: str,
    model_id: str | None,
    timezone: str,
) -> ConversationTask:
    now = _now_iso()
    task = ConversationTask(
        task_id=str(uuid.uuid4()),
        legacy_intent_id=str(uuid.uuid4()),
        session_id=session_id,
        user_id=user_id,
        user_goal=goal,
        resolved_goal=goal,
        model_id=model_id,
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
