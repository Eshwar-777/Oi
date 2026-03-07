from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import uuid
from typing import Any

from oi_agent.automation.store import list_events as list_persisted_events
from oi_agent.automation.store import save_event


_lock = asyncio.Lock()
_subscribers: list[asyncio.Queue[dict[str, Any]]] = []


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def publish_event(
    *,
    session_id: str,
    run_id: str | None,
    event_type: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    event = {
        "event_id": str(uuid.uuid4()),
        "session_id": session_id,
        "run_id": run_id,
        "type": event_type,
        "timestamp": _now_iso(),
        "payload": payload,
    }
    await save_event(str(event["event_id"]), event)
    async with _lock:
        subscribers = list(_subscribers)
    for queue in subscribers:
        try:
            queue.put_nowait(event)
        except Exception:
            continue
    return event


async def list_events(
    *,
    session_id: str | None = None,
    run_id: str | None = None,
) -> list[dict[str, Any]]:
    return await list_persisted_events(session_id=session_id, run_id=run_id)


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
