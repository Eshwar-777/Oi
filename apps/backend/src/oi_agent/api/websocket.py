from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from oi_agent.auth.firebase_auth import verify_firebase_id_token
from oi_agent.config import settings
from oi_agent.devices.firestore_client import get_firestore

logger = logging.getLogger(__name__)

ws_router = APIRouter()


class ConnectionManager:
    """Manages active WebSocket connections grouped by device_id."""

    def __init__(self) -> None:
        self._connections: dict[str, WebSocket] = {}

    async def connect(self, device_id: str, websocket: WebSocket) -> None:
        self._connections[device_id] = websocket
        logger.info("WebSocket connected: device=%s", device_id)

    def disconnect(self, device_id: str) -> None:
        self._connections.pop(device_id, None)
        logger.info("WebSocket disconnected: device=%s", device_id)

    async def send_to_device(self, device_id: str, data: dict[str, Any]) -> bool:
        websocket = self._connections.get(device_id)
        if websocket is None:
            return False
        try:
            await websocket.send_json(data)
            return True
        except Exception:
            self.disconnect(device_id)
            return False

    async def broadcast_to_devices(
        self, device_ids: list[str], data: dict[str, Any]
    ) -> None:
        for device_id in device_ids:
            await self.send_to_device(device_id, data)

    def is_connected(self, device_id: str) -> bool:
        return device_id in self._connections


connection_manager = ConnectionManager()


async def _is_device_linked(uid: str, device_id: str) -> bool:
    """Check that the websocket device belongs to the authenticated user."""
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
        return link_snap.exists and link_snap.to_dict().get("status") == "active"
    except Exception as exc:
        logger.warning("WebSocket device-link check failed: %s", exc)
        return False


async def _authenticate_websocket(websocket: WebSocket) -> tuple[str, str] | None:
    """Require an auth frame and return (uid, device_id) when valid."""
    await websocket.accept()

    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=10)
        frame = json.loads(raw)
    except (TimeoutError, asyncio.TimeoutError, json.JSONDecodeError):
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
        uid = claims["uid"]
    except Exception:
        await websocket.send_json({"type": "error", "detail": "Unauthorized"})
        await websocket.close(code=1008)
        return None

    if not await _is_device_linked(uid, device_id):
        await websocket.send_json({"type": "error", "detail": "Device not linked"})
        await websocket.close(code=1008)
        return None

    await websocket.send_json({"type": "auth_ok", "payload": {"device_id": device_id}})
    return uid, device_id


@ws_router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Bidirectional WebSocket for voice streaming and extension communication.

    Clients must send an initial auth frame with Firebase token + device_id.
    """
    auth_context = await _authenticate_websocket(websocket)
    if auth_context is None:
        return
    _, device_id = auth_context
    await connection_manager.connect(device_id, websocket)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "detail": "Invalid JSON"})
                continue

            frame_type = frame.get("type", "")

            if frame_type == "ping":
                await websocket.send_json({"type": "pong"})
            elif frame_type == "auth":
                await websocket.send_json({"type": "error", "detail": "Already authenticated"})
            elif frame_type == "voice_stream":
                # Voice streaming frames are forwarded to the Gemini Live API.
                # Placeholder: actual integration in backend-converse phase.
                await websocket.send_json({
                    "type": "voice_stream",
                    "payload": {"message": "Voice streaming not yet implemented"},
                })
            elif frame_type == "extension_result":
                # Results from the browser extension's content scripts.
                logger.info(
                    "Extension result from device=%s: %s",
                    device_id,
                    frame.get("payload", {}),
                )
            else:
                await websocket.send_json({
                    "type": "error",
                    "detail": f"Unknown frame type: {frame_type}",
                })
    except WebSocketDisconnect:
        connection_manager.disconnect(device_id)
