from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from typing import Any

from oi_agent.automation.store import list_events as list_persisted_events
from oi_agent.automation.store import save_event
from oi_agent.observability.metrics import record_automation_event

_lock = asyncio.Lock()
_subscribers: list[asyncio.Queue[dict[str, Any]]] = []


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def publish_event(
    *,
    user_id: str,
    session_id: str,
    run_id: str | None,
    event_type: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    event = {
        "event_id": str(uuid.uuid4()),
        "user_id": user_id,
        "session_id": session_id,
        "run_id": run_id,
        "type": event_type,
        "timestamp": _now_iso(),
        "payload": payload,
    }
    record_automation_event(event_type)
    await save_event(str(event["event_id"]), event)
    async with _lock:
        subscribers = list(_subscribers)
    for queue in subscribers:
        try:
            queue.put_nowait(event)
        except Exception:
            continue
    try:
        from oi_agent.automation.notification_fanout import safe_fanout_automation_notification

        asyncio.create_task(safe_fanout_automation_notification(event))
    except Exception:
        pass
    return event


async def publish_activity_event(
    *,
    user_id: str,
    session_id: str,
    run_id: str,
    summary: str,
    tone: str = "neutral",
) -> dict[str, Any] | None:
    cleaned = str(summary or "").strip()
    if not cleaned:
        return None
    return await publish_event(
        user_id=user_id,
        session_id=session_id,
        run_id=run_id,
        event_type="run.activity",
        payload={
            "run_id": run_id,
            "summary": cleaned,
            "tone": tone,
        },
    )


async def list_events(
    *,
    user_id: str,
    session_id: str | None = None,
    run_id: str | None = None,
) -> list[dict[str, Any]]:
    return await list_persisted_events(user_id=user_id, session_id=session_id, run_id=run_id)


async def subscribe() -> asyncio.Queue[dict[str, Any]]:
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    async with _lock:
        _subscribers.append(queue)
    return queue


async def unsubscribe(queue: asyncio.Queue[dict[str, Any]]) -> None:
    async with _lock:
        if queue in _subscribers:
            _subscribers.remove(queue)


async def reset_events() -> None:
    async with _lock:
        _subscribers.clear()
