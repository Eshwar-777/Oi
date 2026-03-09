from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.automation.events import list_events, subscribe, unsubscribe

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
    user: dict[str, str] = Depends(get_current_user),
) -> StreamingResponse:
    user_id = user["uid"]

    async def generator():
        existing = await list_events(user_id=user_id, session_id=session_id, run_id=run_id)
        for event in existing:
            yield f"data: {json.dumps(event)}\n\n"

        queue = await subscribe()
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                except TimeoutError:
                    yield "event: ping\ndata: {}\n\n"
                    continue
                if event.get("user_id") != user_id:
                    continue
                if session_id and event.get("session_id") != session_id:
                    continue
                if run_id and event.get("run_id") != run_id:
                    continue
                yield f"data: {json.dumps(event)}\n\n"
        finally:
            await unsubscribe(queue)

    return StreamingResponse(generator(), media_type="text/event-stream")
