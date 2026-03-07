from __future__ import annotations

import asyncio
import json
import logging
from typing import cast

from fastapi import WebSocket, WebSocketDisconnect

from oi_agent.auth.firebase_auth import verify_firebase_id_token
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

    try:
        claims = await verify_firebase_id_token(token if isinstance(token, str) else None)
        uid = cast(str, claims["uid"])
    except Exception:
        await websocket.send_json({"type": "error", "detail": "Unauthorized"})
        await websocket.close(code=1008)
        return None

    if not await is_device_linked(uid, device_id):
        await websocket.send_json({"type": "error", "detail": "Device not linked"})
        await websocket.close(code=1008)
        return None

    await websocket.send_json({"type": "auth_ok", "payload": {"device_id": device_id}})
    return uid, device_id
