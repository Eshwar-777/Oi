from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, Header, Query
from fastapi.responses import StreamingResponse

from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.automation.events import list_events, subscribe, unsubscribe
from oi_agent.automation.store import get_event, list_events_since
from oi_agent.observability.metrics import record_event_stream_connection

event_router = APIRouter(prefix="/api/events", tags=["automation-events"])


@event_router.get("")
async def get_events(
    session_id: str | None = Query(default=None),
    run_id: str | None = Query(default=None),
    user: dict[str, str] = Depends(get_current_user),
) -> dict[str, object]:
    return {"items": await list_events(user_id=user["uid"], session_id=session_id, run_id=run_id)}


@event_router.get("/stream")
async def stream_events(
    session_id: str | None = Query(default=None),
    run_id: str | None = Query(default=None),
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    user: dict[str, str] = Depends(get_current_user),
) -> StreamingResponse:
    user_id = user["uid"]
    record_event_stream_connection(surface="sse")

    async def generator():
        existing = await list_events(user_id=user_id, session_id=session_id, run_id=run_id)
        cursor_timestamp = ""
        seen_event_ids: set[str] = set()
        if last_event_id:
            previous = await get_event(last_event_id)
            if previous:
                cursor_timestamp = str(previous.get("timestamp", "") or "")
                seen_event_ids.add(last_event_id)

        existing = (
            await list_events_since(
                after_timestamp=cursor_timestamp,
                session_id=session_id,
                run_id=run_id,
            )
            if cursor_timestamp
            else await list_events(user_id=user_id, session_id=session_id, run_id=run_id)
        )
        for event in existing:
            event_id = str(event.get("event_id", "") or "")
            if event.get("user_id") != user_id:
                continue
            if event_id in seen_event_ids:
                continue
            if event_id:
                seen_event_ids.add(event_id)
            cursor_timestamp = max(cursor_timestamp, str(event.get("timestamp", "") or ""))
            yield f"id: {event_id}\ndata: {json.dumps(event)}\n\n"

        queue = await subscribe()
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                except TimeoutError:
                    persisted = (
                        await list_events_since(
                            after_timestamp=cursor_timestamp,
                            session_id=session_id,
                            run_id=run_id,
                        )
                        if cursor_timestamp
                        else await list_events(user_id=user_id, session_id=session_id, run_id=run_id)
                    )
                    for event in persisted:
                        event_id = str(event.get("event_id", "") or "")
                        if event.get("user_id") != user_id:
                            continue
                        if event_id in seen_event_ids:
                            continue
                        if event_id:
                            seen_event_ids.add(event_id)
                        cursor_timestamp = max(cursor_timestamp, str(event.get("timestamp", "") or ""))
                        yield f"id: {event_id}\ndata: {json.dumps(event)}\n\n"
                    yield "event: ping\ndata: {}\n\n"
                    continue
                if event.get("user_id") != user_id:
                    continue
                if session_id and event.get("session_id") != session_id:
                    continue
                if run_id and event.get("run_id") != run_id:
                    continue
                event_id = str(event.get("event_id", "") or "")
                if event_id in seen_event_ids:
                    continue
                if event_id:
                    seen_event_ids.add(event_id)
                cursor_timestamp = max(cursor_timestamp, str(event.get("timestamp", "") or ""))
                yield f"id: {event_id}\ndata: {json.dumps(event)}\n\n"
        finally:
            await unsubscribe(queue)

    return StreamingResponse(generator(), media_type="text/event-stream")
