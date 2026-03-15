from __future__ import annotations

import asyncio
import json
import logging
from typing import cast
from http.cookies import SimpleCookie

from fastapi import WebSocket, WebSocketDisconnect

from oi_agent.auth.firebase_auth import verify_firebase_id_token, verify_firebase_session_cookie
from oi_agent.config import settings
from oi_agent.devices.firestore_client import get_firestore

logger = logging.getLogger(__name__)


async def is_device_linked(uid: str, device_id: str) -> bool:
    if settings.env == "dev" and uid == "dev-user":
        return True

    try:
        db = get_firestore()
        device_snap = await db.collection("devices").document(device_id).get()
        if not device_snap.exists:
            return False
        if device_snap.to_dict().get("status") != "active":
            return False

        link_snap = await (
            db.collection("devices").document(device_id)
            .collection("links").document(uid).get()
        )
        link_data = link_snap.to_dict() if link_snap.exists else {}
        return bool(link_snap.exists and link_data.get("status") == "active")
    except Exception as exc:
        logger.warning("WebSocket device-link check failed: %s", exc)
        return False


async def authenticate_websocket(websocket: WebSocket) -> tuple[str, str] | None:
    await websocket.accept()

    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=10)
        frame = json.loads(raw)
    except (TimeoutError, json.JSONDecodeError):
        await websocket.send_json({"type": "error", "detail": "Authentication required"})
        await websocket.close(code=1008)
        return None
    except WebSocketDisconnect:
        return None

    if frame.get("type") != "auth":
        await websocket.send_json({"type": "error", "detail": "First frame must be auth"})
        await websocket.close(code=1008)
        return None

    payload = frame.get("payload", {})
    token = payload.get("token") if isinstance(payload, dict) else None
    device_id = payload.get("device_id") if isinstance(payload, dict) else None
    if not isinstance(device_id, str) or not device_id:
        await websocket.send_json({"type": "error", "detail": "Missing device_id"})
        await websocket.close(code=1008)
        return None

    session_cookie: str | None = None
    raw_cookie_header = websocket.headers.get("cookie", "")
    if raw_cookie_header:
        jar = SimpleCookie()
        jar.load(raw_cookie_header)
        morsel = jar.get(settings.auth_session_cookie_name)
        if morsel is not None:
            session_cookie = morsel.value

    claims: dict[str, object] | None = None
    if isinstance(token, str) and token:
        try:
            claims = await verify_firebase_id_token(token)
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
    uid = cast(str, claims["uid"])

    # First-party app clients can authenticate directly instead of pairing as devices.
    if device_id.startswith(("web:", "mobile:", "desktop:")):
        await websocket.send_json({"type": "auth_ok", "payload": {"device_id": device_id}})
        return uid, device_id

    if not await is_device_linked(uid, device_id):
        await websocket.send_json({"type": "error", "detail": "Device not linked"})
        await websocket.close(code=1008)
        return None

    await websocket.send_json({"type": "auth_ok", "payload": {"device_id": device_id}})
    return uid, device_id


async def authenticate_runner_websocket(websocket: WebSocket) -> tuple[str, str, str | None] | None:
    await websocket.accept()

    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=10)
        frame = json.loads(raw)
    except (TimeoutError, json.JSONDecodeError):
        await websocket.send_json({"type": "error", "detail": "Runner authentication required"})
        await websocket.close(code=1008)
        return None
    except WebSocketDisconnect:
        return None

    if frame.get("type") != "runner_auth":
        await websocket.send_json({"type": "error", "detail": "First frame must be runner_auth"})
        await websocket.close(code=1008)
        return None

    payload = frame.get("payload", {})
    secret = payload.get("secret") if isinstance(payload, dict) else None
    runner_id = payload.get("runner_id") if isinstance(payload, dict) else None
    user_id = payload.get("user_id") if isinstance(payload, dict) else None
    session_id = payload.get("session_id") if isinstance(payload, dict) else None

    if not isinstance(runner_id, str) or not runner_id or not isinstance(user_id, str) or not user_id:
        await websocket.send_json({"type": "error", "detail": "Missing runner_id or user_id"})
        await websocket.close(code=1008)
        return None

    configured_secret = settings.runner_shared_secret.strip()
    if not configured_secret or secret != configured_secret:
        await websocket.send_json({"type": "error", "detail": "Runner unauthorized"})
        await websocket.close(code=1008)
        return None

    await websocket.send_json({"type": "auth_ok", "payload": {"runner_id": runner_id, "session_id": session_id}})
    return user_id, runner_id, session_id if isinstance(session_id, str) and session_id else None
