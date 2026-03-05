from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages active WebSocket connections grouped by device_id."""

    def __init__(self) -> None:
        self._connections: dict[str, WebSocket] = {}
        self._pending_results: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._browser_subscribers: dict[str, set[str]] = {}
        self._attached_targets: dict[str, dict[int, dict[str, Any]]] = {}
        self._send_timeout_seconds = 5.0

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
            await asyncio.wait_for(
                websocket.send_json(data),
                timeout=self._send_timeout_seconds,
            )
            return True
        except Exception:
            logger.warning("WebSocket send failed/timed out: device=%s", device_id)
            self.disconnect(device_id)
            return False

    async def broadcast_to_devices(
        self, device_ids: list[str], data: dict[str, Any]
    ) -> None:
        for device_id in device_ids:
            await self.send_to_device(device_id, data)

    def is_connected(self, device_id: str) -> bool:
        return device_id in self._connections

    async def send_command_and_wait(
        self,
        device_id: str,
        command: dict[str, Any],
        timeout: float = 30.0,
    ) -> dict[str, Any]:
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
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending_results.pop(cmd_id, None)
            return {"status": "error", "data": f"Extension command timed out after {timeout}s"}

    def resolve_pending_result(self, cmd_id: str, payload: dict[str, Any]) -> bool:
        future = self._pending_results.pop(cmd_id, None)
        if future and not future.done():
            future.set_result(payload)
            return True
        return False

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

    def set_target_attached(self, device_id: str, payload: dict[str, Any]) -> None:
        raw_tab_id = payload.get("tab_id", 0)
        tab_id = int(raw_tab_id) if raw_tab_id else 0
        info = {k: v for k, v in payload.items() if k not in ("device_id", "_attached")}
        if device_id not in self._attached_targets:
            self._attached_targets[device_id] = {}
        self._attached_targets[device_id][tab_id] = info

    def set_target_detached(self, device_id: str, tab_id: int | None = None) -> None:
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
        self, device_id: str, tab_id: int | None = None
    ) -> dict[str, Any] | None:
        tabs = self._attached_targets.get(device_id, {})
        if tab_id is not None:
            return tabs.get(tab_id)
        if tabs:
            return next(iter(tabs.values()))
        return None

    def get_attached_tabs(self, device_id: str) -> list[dict[str, Any]]:
        tabs = self._attached_targets.get(device_id, {})
        return [{"tab_id": tid, **info} for tid, info in tabs.items()]

    def list_attached_targets(self) -> list[dict[str, Any]]:
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
