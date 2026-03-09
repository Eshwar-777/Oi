from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from oi_agent.api.websocket import connection_manager
from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.automation.sessions.manager import browser_session_manager
from oi_agent.automation.sessions.models import (
    AcquireSessionControlRequest,
    ReleaseSessionControlRequest,
    SessionControlAuditListResponse,
    SessionControlAuditRecord,
    SessionInputRequest,
)
from oi_agent.automation.store import list_session_control_audit, save_session_control_audit

session_stream_router = APIRouter()


class SessionControlRequest(BaseModel):
    action: str = Field(..., min_length=1)
    url: str | None = None


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def _record_audit(
    *,
    session_id: str,
    actor_id: str,
    actor_type: str,
    action: str,
    outcome: str,
    input_type: str | None = None,
    target_url: str | None = None,
    detail: str | None = None,
) -> None:
    record = SessionControlAuditRecord(
        audit_id=str(uuid.uuid4()),
        session_id=session_id,
        actor_id=actor_id,
        actor_type=actor_type,  # type: ignore[arg-type]
        action=action,  # type: ignore[arg-type]
        input_type=input_type,
        target_url=target_url,
        outcome=outcome,  # type: ignore[arg-type]
        detail=detail,
        created_at=_now_iso(),
    )
    await save_session_control_audit(record.audit_id, record.model_dump(mode="json"))


@session_stream_router.get("/browser/sessions/{session_id}/frame")
async def get_latest_session_frame(
    session_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    session = await browser_session_manager.get_session(session_id)
    if session is None or session.user_id != user["uid"]:
        raise HTTPException(status_code=404, detail="Browser session not found.")
    frame = connection_manager.get_latest_session_frame(session_id)
    return {"session_id": session_id, "frame": frame}


@session_stream_router.get("/browser/sessions/{session_id}/stream")
async def stream_session_frames(
    session_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> StreamingResponse:
    session = await browser_session_manager.get_session(session_id)
    if session is None or session.user_id != user["uid"]:
        raise HTTPException(status_code=404, detail="Browser session not found.")

    async def generator():
        latest = connection_manager.get_latest_session_frame(session_id)
        if latest:
            yield f"data: {json.dumps(latest)}\n\n"

        queue = connection_manager.subscribe_session_queue(session_id)
        try:
            while True:
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=15.0)
                except TimeoutError:
                    yield "event: ping\ndata: {}\n\n"
                    continue
                yield f"data: {json.dumps(frame)}\n\n"
        finally:
            connection_manager.unsubscribe_session_queue(session_id, queue)

    return StreamingResponse(generator(), media_type="text/event-stream")


@session_stream_router.get(
    "/browser/sessions/{session_id}/audit",
    response_model=SessionControlAuditListResponse,
)
async def get_session_control_audit(
    session_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> SessionControlAuditListResponse:
    session = await browser_session_manager.get_session(session_id)
    if session is None or session.user_id != user["uid"]:
        raise HTTPException(status_code=404, detail="Browser session not found.")
    items = [SessionControlAuditRecord.model_validate(row) for row in await list_session_control_audit(session_id)]
    return SessionControlAuditListResponse(items=items)


@session_stream_router.post("/browser/sessions/{session_id}/control")
async def control_session(
    session_id: str,
    payload: SessionControlRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    session = await browser_session_manager.get_session(session_id)
    if session is None or session.user_id != user["uid"]:
        raise HTTPException(status_code=404, detail="Browser session not found.")
    actor_id = f"user:{user['uid']}"
    actor_type = "web"
    runner_id = connection_manager.get_runner_for_session(session_id)
    if not runner_id:
        await _record_audit(
            session_id=session_id,
            actor_id=actor_id,
            actor_type=actor_type,
            action=payload.action,
            outcome="rejected",
            target_url=payload.url,
            detail="Runner is not connected.",
        )
        raise HTTPException(status_code=409, detail="No runner connected for this browser session.")
    sent = await connection_manager.send_to_runner(
        runner_id,
        {
            "type": "session_control",
            "payload": {
                "session_id": session_id,
                "action": payload.action,
                "url": payload.url,
            },
        },
    )
    if not sent:
        await _record_audit(
            session_id=session_id,
            actor_id=actor_id,
            actor_type=actor_type,
            action=payload.action,
            outcome="rejected",
            target_url=payload.url,
            detail="Runner is not reachable.",
        )
        raise HTTPException(status_code=409, detail="Runner is not reachable.")
    await _record_audit(
        session_id=session_id,
        actor_id=actor_id,
        actor_type=actor_type,
        action=payload.action,
        outcome="accepted",
        target_url=payload.url,
    )
    return {"ok": True, "session_id": session_id, "action": payload.action}


@session_stream_router.post("/browser/sessions/{session_id}/controller/acquire")
async def acquire_session_control(
    session_id: str,
    payload: AcquireSessionControlRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    session = await browser_session_manager.get_session(session_id)
    if session is None or session.user_id != user["uid"]:
        raise HTTPException(status_code=404, detail="Browser session not found.")
    updated = await browser_session_manager.acquire_control(
        session_id=session_id,
        actor_id=payload.actor_id,
        actor_type=payload.actor_type,
        priority=payload.priority,
        ttl_seconds=payload.ttl_seconds,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Browser session not found.")
    lock = updated.controller_lock
    if lock is None or lock.actor_id != payload.actor_id:
        await _record_audit(
            session_id=session_id,
            actor_id=payload.actor_id,
            actor_type=payload.actor_type,
            action="acquire",
            outcome="rejected",
            detail="Controller lock is already held by another actor.",
        )
        raise HTTPException(
            status_code=409,
            detail="Browser session is currently controlled by another actor.",
        )
    from oi_agent.automation.run_service import mark_browser_session_human_control

    await mark_browser_session_human_control(
        browser_session_id=session_id,
        actor_id=payload.actor_id,
    )
    await _record_audit(
        session_id=session_id,
        actor_id=payload.actor_id,
        actor_type=payload.actor_type,
        action="acquire",
        outcome="accepted",
    )
    return {"ok": True, "session": updated}


@session_stream_router.post("/browser/sessions/{session_id}/controller/release")
async def release_session_control(
    session_id: str,
    payload: ReleaseSessionControlRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    session = await browser_session_manager.get_session(session_id)
    if session is None or session.user_id != user["uid"]:
        raise HTTPException(status_code=404, detail="Browser session not found.")
    updated = await browser_session_manager.release_control(
        session_id=session_id,
        actor_id=payload.actor_id,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Browser session not found.")
    from oi_agent.automation.run_service import release_browser_session_human_control

    await release_browser_session_human_control(
        browser_session_id=session_id,
        actor_id=payload.actor_id,
    )
    await _record_audit(
        session_id=session_id,
        actor_id=payload.actor_id,
        actor_type=session.controller_lock.actor_type if session.controller_lock else "web",
        action="release",
        outcome="accepted",
    )
    return {"ok": True, "session": updated}


@session_stream_router.post("/browser/sessions/{session_id}/input")
async def send_session_input(
    session_id: str,
    payload: SessionInputRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    session = await browser_session_manager.get_session(session_id)
    if session is None or session.user_id != user["uid"]:
        raise HTTPException(status_code=404, detail="Browser session not found.")
    lock = session.controller_lock
    if lock is None or lock.actor_id != payload.actor_id:
        await _record_audit(
            session_id=session_id,
            actor_id=payload.actor_id,
            actor_type="web",
            action="input",
            input_type=payload.input_type,
            outcome="rejected",
            detail="Controller lock required before injecting input.",
        )
        raise HTTPException(
            status_code=409,
            detail="Acquire controller lock before sending remote input.",
        )
    runner_id = connection_manager.get_runner_for_session(session_id)
    if not runner_id:
        await _record_audit(
            session_id=session_id,
            actor_id=payload.actor_id,
            actor_type=lock.actor_type,
            action="input",
            input_type=payload.input_type,
            outcome="rejected",
            detail="Runner is not connected.",
        )
        raise HTTPException(status_code=409, detail="No runner connected for this browser session.")
    sent = await connection_manager.send_to_runner(
        runner_id,
        {
            "type": "session_control",
            "payload": {
                "session_id": session_id,
                "action": "input",
                "actor_id": payload.actor_id,
                "input_type": payload.input_type,
                "x": payload.x,
                "y": payload.y,
                "text": payload.text,
                "delta_x": payload.delta_x,
                "delta_y": payload.delta_y,
                "key": payload.key,
                "button": payload.button,
            },
        },
    )
    if not sent:
        await _record_audit(
            session_id=session_id,
            actor_id=payload.actor_id,
            actor_type=lock.actor_type,
            action="input",
            input_type=payload.input_type,
            outcome="rejected",
            detail="Runner is not reachable.",
        )
        raise HTTPException(status_code=409, detail="Runner is not reachable.")
    await browser_session_manager.touch_control(
        session_id=session_id,
        actor_id=payload.actor_id,
    )
    await _record_audit(
        session_id=session_id,
        actor_id=payload.actor_id,
        actor_type=lock.actor_type,
        action="input",
        input_type=payload.input_type,
        outcome="accepted",
    )
    return {"ok": True, "session_id": session_id, "input_type": payload.input_type}
