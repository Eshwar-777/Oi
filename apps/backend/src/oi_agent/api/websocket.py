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
    """Manages active WebSocket connections grouped by device_id.

    Supports multiple attached browser tabs per device, pending extension
    result futures, and browser-frame subscribers.
    """

    def __init__(self) -> None:
        self._connections: dict[str, WebSocket] = {}
        self._pending_results: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._browser_subscribers: dict[str, set[str]] = {}
        # device_id -> { tab_id (int) -> target_info dict }
        self._attached_targets: dict[str, dict[int, dict[str, Any]]] = {}

    async def connect(self, device_id: str, websocket: WebSocket) -> None:
        self._connections[device_id] = websocket
        logger.info("WebSocket connected: device=%s", device_id)

    def disconnect(self, device_id: str) -> None:
        self._connections.pop(device_id, None)
        for run_id, subs in list(self._browser_subscribers.items()):
            subs.discard(device_id)
            if not subs:
                self._browser_subscribers.pop(run_id, None)
        self._attached_targets.pop(device_id, None)
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

    # -- Extension request/reply -------------------------------------------

    async def send_command_and_wait(
        self,
        device_id: str,
        command: dict[str, Any],
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        """Send an extension_command and wait for the matching extension_result."""
        cmd_id = command.get("payload", {}).get("cmd_id", "")
        if not cmd_id:
            import uuid
            cmd_id = str(uuid.uuid4())[:8]
            command.setdefault("payload", {})["cmd_id"] = cmd_id

        future: asyncio.Future[dict[str, Any]] = asyncio.get_event_loop().create_future()
        self._pending_results[cmd_id] = future

        sent = await self.send_to_device(device_id, command)
        if not sent:
            self._pending_results.pop(cmd_id, None)
            return {"status": "error", "data": "Device not connected"}

        try:
            result = await asyncio.wait_for(future, timeout=timeout)
            return result
        except asyncio.TimeoutError:
            self._pending_results.pop(cmd_id, None)
            return {"status": "error", "data": f"Extension command timed out after {timeout}s"}

    def resolve_pending_result(self, cmd_id: str, payload: dict[str, Any]) -> bool:
        """Called when we receive an extension_result that matches a pending command."""
        future = self._pending_results.pop(cmd_id, None)
        if future and not future.done():
            future.set_result(payload)
            return True
        return False

    # -- Browser frame subscribers -----------------------------------------

    def subscribe_browser_stream(self, subscriber_device_id: str, run_id: str) -> None:
        if run_id not in self._browser_subscribers:
            self._browser_subscribers[run_id] = set()
        self._browser_subscribers[run_id].add(subscriber_device_id)

    def unsubscribe_browser_stream(self, subscriber_device_id: str, run_id: str) -> None:
        subs = self._browser_subscribers.get(run_id)
        if subs:
            subs.discard(subscriber_device_id)
            if not subs:
                self._browser_subscribers.pop(run_id, None)

    async def broadcast_browser_frame(self, run_id: str, frame: dict[str, Any]) -> None:
        subs = self._browser_subscribers.get(run_id, set())
        for sub_id in list(subs):
            sent = await self.send_to_device(sub_id, frame)
            if not sent:
                subs.discard(sub_id)
        if not subs:
            self._browser_subscribers.pop(run_id, None)

    def get_extension_device_ids(self) -> list[str]:
        return list(self._connections.keys())

    # -- Attached browser target state (multi-tab) -------------------------

    def set_target_attached(self, device_id: str, payload: dict[str, Any]) -> None:
        """Record an attached tab for a device."""
        raw_tab_id = payload.get("tab_id", 0)
        tab_id = int(raw_tab_id) if raw_tab_id else 0
        info = {k: v for k, v in payload.items() if k not in ("device_id", "_attached")}
        if device_id not in self._attached_targets:
            self._attached_targets[device_id] = {}
        self._attached_targets[device_id][tab_id] = info

    def set_target_detached(self, device_id: str, tab_id: int | None = None) -> None:
        """Remove one or all attached tabs for a device."""
        if tab_id is not None:
            tabs = self._attached_targets.get(device_id, {})
            tabs.pop(tab_id, None)
            if not tabs:
                self._attached_targets.pop(device_id, None)
        else:
            self._attached_targets.pop(device_id, None)

    def has_attached_target(self, device_id: str) -> bool:
        return bool(self._attached_targets.get(device_id))

    def is_attach_state_known(self, device_id: str) -> bool:
        return device_id in self._attached_targets or device_id in self._connections

    def get_attached_target(
        self, device_id: str, tab_id: int | None = None,
    ) -> dict[str, Any] | None:
        """Get info for a specific tab, or the first attached tab."""
        tabs = self._attached_targets.get(device_id, {})
        if tab_id is not None:
            return tabs.get(tab_id)
        if tabs:
            return next(iter(tabs.values()))
        return None

    def get_attached_tabs(self, device_id: str) -> list[dict[str, Any]]:
        """Return all attached tabs for a device."""
        tabs = self._attached_targets.get(device_id, {})
        return [{"tab_id": tid, **info} for tid, info in tabs.items()]

    def list_attached_targets(self) -> list[dict[str, Any]]:
        """Return all devices with their attached tab info."""
        rows: list[dict[str, Any]] = []
        for device_id in self.get_extension_device_ids():
            tabs = self.get_attached_tabs(device_id)
            rows.append(
                {
                    "device_id": device_id,
                    "connected": True,
                    "attached": bool(tabs),
                    "attached_tab_count": len(tabs),
                    "tabs": tabs,
                    "target": tabs[0] if tabs else None,
                }
            )
        return rows


connection_manager = ConnectionManager()


async def _is_device_linked(uid: str, device_id: str) -> bool:
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
    """Bidirectional WebSocket for extension communication, browser-frame
    streaming, and remote device control."""
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
                await websocket.send_json({
                    "type": "voice_stream",
                    "payload": {"message": "Voice streaming not yet implemented"},
                })

            elif frame_type == "extension_result":
                payload = frame.get("payload", {})
                cmd_id = payload.get("cmd_id", "")
                if cmd_id:
                    connection_manager.resolve_pending_result(cmd_id, payload)
                logger.info("Extension result from device=%s: %s", device_id, payload.get("action", ""))

            elif frame_type == "browser_frame":
                payload = frame.get("payload", {})
                run_id = payload.get("run_id", "")
                if run_id:
                    await connection_manager.broadcast_browser_frame(run_id, frame)

            elif frame_type == "target_attached":
                payload = frame.get("payload", {})
                connection_manager.set_target_attached(device_id, payload if isinstance(payload, dict) else {})
                await websocket.send_json({"type": "target_attached_ack"})

            elif frame_type == "target_detached":
                payload = frame.get("payload", {})
                raw_tab_id = payload.get("tab_id") if isinstance(payload, dict) else None
                tab_id = int(raw_tab_id) if raw_tab_id is not None else None
                connection_manager.set_target_detached(device_id, tab_id)
                await websocket.send_json({"type": "target_detached_ack"})

            elif frame_type == "browser_stream_subscribe":
                run_id = frame.get("payload", {}).get("run_id", "")
                if run_id:
                    connection_manager.subscribe_browser_stream(device_id, run_id)
                    await websocket.send_json({"type": "browser_stream_subscribe", "payload": {"run_id": run_id, "status": "subscribed"}})

            elif frame_type == "browser_stream_unsubscribe":
                run_id = frame.get("payload", {}).get("run_id", "")
                if run_id:
                    connection_manager.unsubscribe_browser_stream(device_id, run_id)

            elif frame_type == "remote_input":
                payload = frame.get("payload", {})
                target_device = payload.get("target_device_id", "")
                if target_device:
                    await connection_manager.send_to_device(target_device, frame)

            else:
                await websocket.send_json({
                    "type": "error",
                    "detail": f"Unknown frame type: {frame_type}",
                })
    except WebSocketDisconnect:
        connection_manager.disconnect(device_id)
