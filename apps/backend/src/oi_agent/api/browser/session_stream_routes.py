from __future__ import annotations

import asyncio
import json
import time
import uuid
from datetime import UTC, datetime
from http.cookies import SimpleCookie
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from oi_agent.api.websocket import connection_manager
from oi_agent.auth.firebase_auth import (
    get_current_user,
    verify_firebase_id_token,
    verify_firebase_session_cookie,
)
from oi_agent.automation.sessions.manager import browser_session_manager
from oi_agent.automation.sessions.models import (
    AcquireSessionControlRequest,
    ReleaseSessionControlRequest,
    SessionControlAuditListResponse,
    SessionControlAuditRecord,
    SessionInputRequest,
)
from oi_agent.automation.store import list_session_control_audit, save_session_control_audit
from oi_agent.config import settings

session_stream_router = APIRouter()
_HIGH_FREQUENCY_INPUTS = {"move", "scroll"}
_TOUCH_CONTROL_INTERVAL_SECONDS = 2.0
_AUDIT_SAMPLE_INTERVAL_SECONDS = 1.0
_last_touch_control_at: dict[tuple[str, str], float] = {}
_last_sampled_audit_at: dict[tuple[str, str, str], float] = {}
_suppressed_audit_counts: dict[tuple[str, str, str], int] = {}


class SessionControlRequest(BaseModel):
    action: str = Field(..., min_length=1)
    url: str | None = None
    page_id: str | None = None
    page_title: str | None = None
    tab_index: int | None = None


async def _authenticate_session_view_websocket(
    websocket: WebSocket,
    *,
    session_id: str,
) -> dict[str, Any] | None:
    await websocket.accept()
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
        frame = json.loads(raw)
    except (TimeoutError, json.JSONDecodeError):
        await websocket.send_json({"type": "error", "detail": "Authentication required"})
        await websocket.close(code=1008)
        return None
    except WebSocketDisconnect:
        return None

    if not isinstance(frame, dict) or frame.get("type") != "session_view_auth":
        await websocket.send_json({"type": "error", "detail": "First frame must be session_view_auth"})
        await websocket.close(code=1008)
        return None

    payload = frame.get("payload", {})
    token = payload.get("token") if isinstance(payload, dict) else None

    session_cookie: str | None = None
    raw_cookie_header = websocket.headers.get("cookie", "")
    if raw_cookie_header:
        jar = SimpleCookie()
        jar.load(raw_cookie_header)
        morsel = jar.get(settings.auth_session_cookie_name)
        if morsel is not None:
            session_cookie = morsel.value

    claims: dict[str, Any] | None = None
    if isinstance(token, str) and token.strip():
        try:
            claims = await verify_firebase_id_token(token.strip())
        except Exception:
            claims = None
    if claims is None and session_cookie:
        try:
            claims = await verify_firebase_session_cookie(session_cookie)
        except Exception:
            claims = None
    if claims is None:
        await websocket.send_json({"type": "error", "detail": "Unauthorized"})
        await websocket.close(code=1008)
        return None

    session = await browser_session_manager.get_session(session_id)
    if session is None or session.user_id != claims["uid"]:
        await websocket.send_json({"type": "error", "detail": "Browser session not found."})
        await websocket.close(code=1008)
        return None

    await websocket.send_json({"type": "auth_ok", "payload": {"session_id": session_id}})
    return claims


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


def _should_refresh_control_lock(session_id: str, actor_id: str, input_type: str) -> bool:
    if input_type not in _HIGH_FREQUENCY_INPUTS:
        return True
    key = (session_id, actor_id)
    now = time.monotonic()
    last = _last_touch_control_at.get(key, 0.0)
    if now - last < _TOUCH_CONTROL_INTERVAL_SECONDS:
        return False
    _last_touch_control_at[key] = now
    return True


async def _record_input_audit_sampled(
    *,
    session_id: str,
    actor_id: str,
    actor_type: str,
    input_type: str,
    outcome: str,
    detail: str | None = None,
) -> None:
    if input_type not in _HIGH_FREQUENCY_INPUTS or outcome != "accepted":
        await _record_audit(
            session_id=session_id,
            actor_id=actor_id,
            actor_type=actor_type,
            action="input",
            input_type=input_type,
            outcome=outcome,
            detail=detail,
        )
        return

    key = (session_id, actor_id, input_type)
    now = time.monotonic()
    last = _last_sampled_audit_at.get(key, 0.0)
    if now - last < _AUDIT_SAMPLE_INTERVAL_SECONDS:
        _suppressed_audit_counts[key] = int(_suppressed_audit_counts.get(key, 0)) + 1
        return

    suppressed = int(_suppressed_audit_counts.pop(key, 0))
    sampled_detail = detail
    if suppressed > 0:
        sampled_detail = (
            f"{detail} · sampled after {suppressed} suppressed {input_type} events"
            if detail
            else f"sampled after {suppressed} suppressed {input_type} events"
        )
    _last_sampled_audit_at[key] = now
    await _record_audit(
        session_id=session_id,
        actor_id=actor_id,
        actor_type=actor_type,
        action="input",
        input_type=input_type,
        outcome=outcome,
        detail=sampled_detail,
    )


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


@session_stream_router.websocket("/ws/browser-session/{session_id}")
async def browser_session_live_socket(
    websocket: WebSocket,
    session_id: str,
) -> None:
    claims = await _authenticate_session_view_websocket(websocket, session_id=session_id)
    if claims is None:
        return

    actor_id = f"user:{claims['uid']}"
    actor_type = "web"
    queue = connection_manager.subscribe_session_queue(session_id)

    async def send_frames() -> None:
        latest = connection_manager.get_latest_session_frame(session_id)
        if latest:
            await websocket.send_json({"type": "session_frame", "payload": latest})
        while True:
            try:
                frame = await asyncio.wait_for(queue.get(), timeout=15.0)
            except TimeoutError:
                await websocket.send_json({"type": "ping", "payload": {}})
                continue
            await websocket.send_json({"type": "session_frame", "payload": frame})

    async def handle_control(payload: dict[str, Any]) -> None:
        session = await browser_session_manager.get_session(session_id)
        if session is None or session.user_id != claims["uid"]:
            await websocket.send_json({"type": "error", "detail": "Browser session not found."})
            return
        runner_id = connection_manager.get_runner_for_session(session_id)
        if not runner_id:
            await websocket.send_json({"type": "error", "detail": "No runner connected for this browser session."})
            return
        sent = await connection_manager.send_to_runner(
            runner_id,
            {
                "type": "session_control",
                "payload": {
                    "session_id": session_id,
                    "action": payload.get("action"),
                    "url": payload.get("url"),
                    "page_id": payload.get("page_id"),
                    "page_title": payload.get("page_title"),
                    "tab_index": payload.get("tab_index"),
                },
            },
        )
        if not sent:
            await websocket.send_json({"type": "error", "detail": "Runner is not reachable."})
            await _record_audit(
                session_id=session_id,
                actor_id=actor_id,
                actor_type=actor_type,
                action=str(payload.get("action") or "unknown"),
                outcome="rejected",
                target_url=str(payload.get("url") or "") or None,
                detail="Runner is not reachable.",
            )
            return
        await _record_audit(
            session_id=session_id,
            actor_id=actor_id,
            actor_type=actor_type,
            action=str(payload.get("action") or "unknown"),
            outcome="accepted",
            target_url=str(payload.get("url") or "") or None,
        )
        await websocket.send_json({"type": "session_control_ack", "payload": {"action": payload.get("action")}})

    async def handle_input(payload: dict[str, Any]) -> None:
        session = await browser_session_manager.get_session(session_id)
        if session is None or session.user_id != claims["uid"]:
            await websocket.send_json({"type": "error", "detail": "Browser session not found."})
            return
        lock = session.controller_lock
        if lock is None or lock.actor_id != str(payload.get("actor_id") or actor_id):
            await websocket.send_json({"type": "error", "detail": "Acquire controller lock before sending remote input."})
            await _record_audit(
                session_id=session_id,
                actor_id=str(payload.get("actor_id") or actor_id),
                actor_type=actor_type,
                action="input",
                input_type=str(payload.get("input_type") or "") or None,
                outcome="rejected",
                detail="Controller lock required before injecting input.",
            )
            return
        runner_id = connection_manager.get_runner_for_session(session_id)
        if not runner_id:
            await websocket.send_json({"type": "error", "detail": "No runner connected for this browser session."})
            return
        sent = await connection_manager.send_to_runner(
            runner_id,
            {
                "type": "session_control",
                "payload": {
                    "session_id": session_id,
                    "action": "input",
                    "actor_id": str(payload.get("actor_id") or actor_id),
                    "input_type": payload.get("input_type"),
                    "x": payload.get("x"),
                    "y": payload.get("y"),
                    "text": payload.get("text"),
                    "delta_x": payload.get("delta_x"),
                    "delta_y": payload.get("delta_y"),
                    "key": payload.get("key"),
                    "button": payload.get("button"),
                    "page_id": payload.get("page_id"),
                },
            },
        )
        if not sent:
            await websocket.send_json({"type": "error", "detail": "Runner is not reachable."})
            return
        input_type = str(payload.get("input_type") or "")
        actor = str(payload.get("actor_id") or actor_id)
        if _should_refresh_control_lock(session_id, actor, input_type):
            await browser_session_manager.touch_control(session_id=session_id, actor_id=actor)
        await _record_input_audit_sampled(
            session_id=session_id,
            actor_id=actor,
            actor_type=lock.actor_type,
            input_type=input_type,
            outcome="accepted",
        )
        await websocket.send_json({"type": "session_input_ack", "payload": {"input_type": input_type}})

    sender = asyncio.create_task(send_frames())
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "detail": "Invalid JSON"})
                continue
            if not isinstance(frame, dict):
                await websocket.send_json({"type": "error", "detail": "Frame must be a JSON object"})
                continue
            frame_type = str(frame.get("type") or "")
            payload = frame.get("payload", {})
            if frame_type == "ping":
                await websocket.send_json({"type": "pong", "payload": {}})
                continue
            if frame_type == "session_control":
                if not isinstance(payload, dict):
                    await websocket.send_json({"type": "error", "detail": "Invalid session_control payload"})
                    continue
                await handle_control(payload)
                continue
            if frame_type == "session_input":
                if not isinstance(payload, dict):
                    await websocket.send_json({"type": "error", "detail": "Invalid session_input payload"})
                    continue
                await handle_input(payload)
                continue
    except WebSocketDisconnect:
        pass
    finally:
        sender.cancel()
        connection_manager.unsubscribe_session_queue(session_id, queue)


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
                "page_id": payload.page_id,
                "page_title": payload.page_title,
                "tab_index": payload.tab_index,
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
                "page_id": payload.page_id,
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
    if _should_refresh_control_lock(session_id, payload.actor_id, payload.input_type):
        await browser_session_manager.touch_control(
            session_id=session_id,
            actor_id=payload.actor_id,
        )
    await _record_input_audit_sampled(
        session_id=session_id,
        actor_id=payload.actor_id,
        actor_type=lock.actor_type,
        input_type=payload.input_type,
        outcome="accepted",
    )
    return {"ok": True, "session_id": session_id, "input_type": payload.input_type}
