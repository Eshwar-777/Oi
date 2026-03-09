from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages active WebSocket connections grouped by device_id."""

    def __init__(self) -> None:
        self._connections: dict[str, WebSocket] = {}
        self._device_users: dict[str, str] = {}
        self._runner_connections: dict[str, WebSocket] = {}
        self._runner_users: dict[str, str] = {}
        self._runner_sessions: dict[str, str] = {}
        self._pending_results: dict[tuple[str, str], asyncio.Future[dict[str, Any]]] = {}
        self._pending_cmds_by_device: dict[str, set[str]] = {}
        self._browser_subscribers: dict[str, set[str]] = {}
        self._browser_run_owner_user: dict[str, str] = {}
        self._session_subscribers: dict[str, set[str]] = {}
        self._session_frame_queues: dict[str, list[asyncio.Queue[dict[str, Any]]]] = {}
        self._latest_session_frames: dict[str, dict[str, Any]] = {}
        self._attached_targets: dict[str, dict[int, dict[str, Any]]] = {}
        self._send_timeout_seconds = 8.0
        self._send_timeout_failures: dict[str, int] = {}
        self._last_seen: dict[str, float] = {}
        self._broadcast_semaphore = asyncio.Semaphore(20)

    async def connect(self, device_id: str, user_id: str, websocket: WebSocket) -> None:
        old = self._connections.get(device_id)
        if old is not None and old is not websocket:
            try:
                await old.close(code=1000)
            except Exception:
                pass
            self.disconnect(device_id)
        self._connections[device_id] = websocket
        self._device_users[device_id] = user_id
        self._last_seen[device_id] = time.time()
        self._send_timeout_failures[device_id] = 0
        logger.info("WebSocket connected: device=%s", device_id)

    async def connect_runner(
        self,
        runner_id: str,
        user_id: str,
        websocket: WebSocket,
        session_id: str | None = None,
    ) -> None:
        old = self._runner_connections.get(runner_id)
        if old is not None and old is not websocket:
            try:
                await old.close(code=1000)
            except Exception:
                pass
            self.disconnect_runner(runner_id)
        self._runner_connections[runner_id] = websocket
        self._runner_users[runner_id] = user_id
        self._last_seen[runner_id] = time.time()
        self._send_timeout_failures[runner_id] = 0
        if session_id:
            self._runner_sessions[runner_id] = session_id
        logger.info("Runner WebSocket connected: runner=%s session=%s", runner_id, session_id or "")

    def disconnect(self, device_id: str) -> None:
        self._connections.pop(device_id, None)
        self._device_users.pop(device_id, None)
        self._last_seen.pop(device_id, None)
        self._send_timeout_failures.pop(device_id, None)
        for run_id, subs in list(self._browser_subscribers.items()):
            subs.discard(device_id)
            if not subs:
                self._browser_subscribers.pop(run_id, None)
                self._browser_run_owner_user.pop(run_id, None)
        self._attached_targets.pop(device_id, None)
        pending_cmds = self._pending_cmds_by_device.pop(device_id, set())
        for cmd_id in pending_cmds:
            fut = self._pending_results.pop((device_id, cmd_id), None)
            if fut is not None and not fut.done():
                fut.set_exception(ConnectionError(f"Device {device_id} disconnected"))
        logger.info("WebSocket disconnected: device=%s", device_id)

    def disconnect_runner(self, runner_id: str) -> None:
        self._runner_connections.pop(runner_id, None)
        self._runner_users.pop(runner_id, None)
        self._last_seen.pop(runner_id, None)
        self._send_timeout_failures.pop(runner_id, None)
        session_id = self._runner_sessions.pop(runner_id, None)
        if session_id:
            # keep subscribers intact; they may reconnect
            pass
        logger.info("Runner WebSocket disconnected: runner=%s", runner_id)

    async def send_to_device(self, device_id: str, data: dict[str, Any]) -> bool:
        websocket = self._connections.get(device_id)
        if websocket is None:
            return False
        try:
            await asyncio.wait_for(
                websocket.send_json(data),
                timeout=self._send_timeout_seconds,
            )
            self._send_timeout_failures[device_id] = 0
            return True
        except TimeoutError:
            failures = int(self._send_timeout_failures.get(device_id, 0)) + 1
            self._send_timeout_failures[device_id] = failures
            logger.warning(
                "WebSocket send timed out: device=%s failures=%d",
                device_id,
                failures,
            )
            if failures >= 3:
                self.disconnect(device_id)
            return False
        except RuntimeError:
            logger.warning("WebSocket runtime send failure: device=%s", device_id)
            self.disconnect(device_id)
            return False

    async def send_to_runner(self, runner_id: str, data: dict[str, Any]) -> bool:
        websocket = self._runner_connections.get(runner_id)
        if websocket is None:
            return False
        try:
            await asyncio.wait_for(
                websocket.send_json(data),
                timeout=self._send_timeout_seconds,
            )
            self._send_timeout_failures[runner_id] = 0
            return True
        except TimeoutError:
            failures = int(self._send_timeout_failures.get(runner_id, 0)) + 1
            self._send_timeout_failures[runner_id] = failures
            if failures >= 3:
                self.disconnect_runner(runner_id)
            return False
        except Exception:
            self.disconnect_runner(runner_id)
            return False
        except Exception:
            logger.warning("WebSocket send failed: device=%s", device_id)
            self.disconnect(device_id)
            return False

    async def broadcast_to_devices(
        self, device_ids: list[str], data: dict[str, Any]
    ) -> None:
        async def _send_one(device_id: str) -> None:
            async with self._broadcast_semaphore:
                await self.send_to_device(device_id, data)

        await asyncio.gather(*[_send_one(device_id) for device_id in device_ids], return_exceptions=True)

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

        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        pending_key = (device_id, cmd_id)
        self._pending_results[pending_key] = future
        self._pending_cmds_by_device.setdefault(device_id, set()).add(cmd_id)

        sent = await self.send_to_device(device_id, command)
        if not sent:
            self._pending_results.pop(pending_key, None)
            self._pending_cmds_by_device.get(device_id, set()).discard(cmd_id)
            return {"status": "error", "data": "Device not connected"}

        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except TimeoutError:
            return {"status": "error", "data": f"Extension command timed out after {timeout}s"}
        except asyncio.CancelledError:
            raise
        finally:
            self._pending_results.pop(pending_key, None)
            self._pending_cmds_by_device.get(device_id, set()).discard(cmd_id)

    def resolve_pending_result(self, device_id: str, cmd_id: str, payload: dict[str, Any]) -> bool:
        future = self._pending_results.pop((device_id, cmd_id), None)
        if future and not future.done():
            future.set_result(payload)
            self._pending_cmds_by_device.get(device_id, set()).discard(cmd_id)
            return True
        return False

    def subscribe_browser_stream(self, subscriber_device_id: str, run_id: str) -> bool:
        subscriber_user = self._device_users.get(subscriber_device_id, "")
        owner_user = self._browser_run_owner_user.get(run_id, "")
        if owner_user and subscriber_user and owner_user != subscriber_user:
            return False
        if run_id not in self._browser_subscribers:
            self._browser_subscribers[run_id] = set()
        self._browser_subscribers[run_id].add(subscriber_device_id)
        return True

    def unsubscribe_browser_stream(self, subscriber_device_id: str, run_id: str) -> None:
        subs = self._browser_subscribers.get(run_id)
        if subs:
            subs.discard(subscriber_device_id)
            if not subs:
                self._browser_subscribers.pop(run_id, None)

    async def broadcast_browser_frame(self, run_id: str, frame: dict[str, Any]) -> None:
        subs = self._browser_subscribers.get(run_id, set())
        async def _send_one(sub_id: str) -> tuple[str, bool]:
            async with self._broadcast_semaphore:
                sent = await self.send_to_device(sub_id, frame)
            return sub_id, sent

        results = await asyncio.gather(*[_send_one(sub_id) for sub_id in list(subs)], return_exceptions=True)
        for row in results:
            if isinstance(row, tuple):
                sub_id, sent = row
                if not sent:
                    subs.discard(sub_id)
        if not subs:
            self._browser_subscribers.pop(run_id, None)
            self._browser_run_owner_user.pop(run_id, None)

    def set_run_owner(self, run_id: str, source_device_id: str) -> None:
        user_id = self._device_users.get(source_device_id, "")
        if user_id:
            self._browser_run_owner_user.setdefault(run_id, user_id)

    def touch_device(self, device_id: str) -> None:
        if device_id in self._connections or device_id in self._runner_connections:
            self._last_seen[device_id] = time.time()

    def get_last_seen(self, device_id: str) -> float:
        return float(self._last_seen.get(device_id, 0.0))

    def get_user_for_device(self, device_id: str) -> str:
        return str(self._device_users.get(device_id, "") or self._runner_users.get(device_id, ""))

    def get_connected_device_ids_for_user(self, user_id: str) -> list[str]:
        if not user_id:
            return []
        return [device_id for device_id, owner in self._device_users.items() if owner == user_id]

    def get_extension_device_ids(self) -> list[str]:
        return list(self._connections.keys())

    def bind_runner_session(self, runner_id: str, session_id: str) -> None:
        self._runner_sessions[runner_id] = session_id

    def get_runner_for_session(self, session_id: str) -> str | None:
        for runner_id, candidate in self._runner_sessions.items():
            if candidate == session_id:
                return runner_id
        return None

    def subscribe_session_stream(self, subscriber_device_id: str, session_id: str) -> bool:
        subscriber_user = self._device_users.get(subscriber_device_id, "")
        runner_id = self.get_runner_for_session(session_id)
        owner_user = self._runner_users.get(runner_id or "", "")
        if owner_user and subscriber_user and owner_user != subscriber_user:
            return False
        self._session_subscribers.setdefault(session_id, set()).add(subscriber_device_id)
        return True

    def unsubscribe_session_stream(self, subscriber_device_id: str, session_id: str) -> None:
        subs = self._session_subscribers.get(session_id)
        if subs:
            subs.discard(subscriber_device_id)
            if not subs:
                self._session_subscribers.pop(session_id, None)

    async def broadcast_session_frame(self, session_id: str, frame: dict[str, Any]) -> None:
        self._latest_session_frames[session_id] = frame
        subs = self._session_subscribers.get(session_id, set())

        async def _send_one(sub_id: str) -> tuple[str, bool]:
            async with self._broadcast_semaphore:
                sent = await self.send_to_device(sub_id, frame)
            return sub_id, sent

        results = await asyncio.gather(*[_send_one(sub_id) for sub_id in list(subs)], return_exceptions=True)
        for row in results:
            if isinstance(row, tuple):
                sub_id, sent = row
                if not sent:
                    subs.discard(sub_id)
        if not subs:
            self._session_subscribers.pop(session_id, None)
        queues = list(self._session_frame_queues.get(session_id, []))
        for queue in queues:
            try:
                queue.put_nowait(frame)
            except Exception:
                continue

    def get_latest_session_frame(self, session_id: str) -> dict[str, Any] | None:
        row = self._latest_session_frames.get(session_id)
        return dict(row) if isinstance(row, dict) else None

    def subscribe_session_queue(self, session_id: str) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._session_frame_queues.setdefault(session_id, []).append(queue)
        return queue

    def unsubscribe_session_queue(self, session_id: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        queues = self._session_frame_queues.get(session_id, [])
        if queue in queues:
            queues.remove(queue)
        if not queues:
            self._session_frame_queues.pop(session_id, None)

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
