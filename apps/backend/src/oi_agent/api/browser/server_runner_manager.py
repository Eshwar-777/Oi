from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import shlex
from dataclasses import dataclass, field
from pathlib import Path

from oi_agent.automation.sessions.manager import browser_session_manager
from oi_agent.automation.sessions.models import ManagedRunnerStatus, UpdateBrowserSessionRequest
from oi_agent.config import settings
from oi_agent.observability.metrics import record_managed_runner_event

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[5]


@dataclass
class _ManagedRunnerHandle:
    user_id: str
    runner_id: str
    runner_label: str
    process: asyncio.subprocess.Process | None = None
    state: str = "idle"
    session_id: str | None = None
    cdp_url: str | None = None
    error: str | None = None
    stdout_task: asyncio.Task[None] | None = None
    stderr_task: asyncio.Task[None] | None = None
    wait_task: asyncio.Task[None] | None = None
    start_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class ServerRunnerManager:
    def __init__(self) -> None:
        self._handles: dict[str, _ManagedRunnerHandle] = {}
        self._lock = asyncio.Lock()

    def _configured(self) -> bool:
        return settings.server_runner_enabled and bool(settings.server_runner_command.strip())

    def _api_base_url(self) -> str:
        configured = settings.server_runner_api_base_url.strip()
        if configured:
            return configured
        return f"http://127.0.0.1:{settings.app_port}"

    def _cwd(self) -> str:
        configured = settings.server_runner_cwd.strip()
        if configured:
            return configured
        return str(_REPO_ROOT)

    def _runner_id(self, user_id: str) -> str:
        token = "".join(ch for ch in user_id if ch.isalnum()).lower()[:12] or "user"
        return f"server-runner-{token}"

    def _runner_label(self) -> str:
        return "Managed remote browser"

    async def status(self, user_id: str) -> ManagedRunnerStatus:
        if not self._configured():
            return ManagedRunnerStatus(enabled=False, state="disabled")
        handle = self._handles.get(user_id)
        if handle is None:
            sessions = await browser_session_manager.list_sessions(user_id=user_id)
            existing = next((item for item in sessions if item.origin == "server_runner"), None)
            return ManagedRunnerStatus(
                enabled=True,
                state="ready" if existing and existing.status == "ready" else "idle",
                origin="server_runner",
                runner_id=existing.runner_id or self._runner_id(user_id) if existing else self._runner_id(user_id),
                runner_label=existing.runner_label or self._runner_label() if existing else self._runner_label(),
                session_id=existing.session_id if existing else None,
                error=None if existing or not settings.server_runner_enabled else "Managed remote browser is not running.",
            )
        process_alive = handle.process is not None and handle.process.returncode is None
        state = handle.state
        if not process_alive and state in {"starting", "ready"}:
            state = "error" if handle.error else "idle"
        return ManagedRunnerStatus(
            enabled=True,
            state=state,  # type: ignore[arg-type]
            origin="server_runner",
            runner_id=handle.runner_id,
            runner_label=handle.runner_label,
            session_id=handle.session_id,
            cdp_url=handle.cdp_url,
            error=handle.error,
        )

    async def start(self, user_id: str) -> ManagedRunnerStatus:
        if not self._configured():
            raise RuntimeError("Managed remote browser is not enabled on this backend.")

        async with self._lock:
            handle = self._handles.get(user_id)
            if handle is None:
                handle = _ManagedRunnerHandle(
                    user_id=user_id,
                    runner_id=self._runner_id(user_id),
                    runner_label=self._runner_label(),
                )
                self._handles[user_id] = handle

        async with handle.start_lock:
            process_alive = handle.process is not None and handle.process.returncode is None
            if process_alive and handle.state == "ready":
                record_managed_runner_event(origin="server_runner", event="start_reused")
                return await self.status(user_id)
            if process_alive and handle.state == "starting":
                record_managed_runner_event(origin="server_runner", event="start_in_progress")
                return await self.status(user_id)
            if handle.process is not None and handle.process.returncode is not None:
                await self._finalize_handle(handle)

            command = shlex.split(settings.server_runner_command)
            if not command:
                raise RuntimeError("Managed remote browser command is empty.")
            env = os.environ.copy()
            env.update(
                {
                    "OI_RUNNER_ENABLED": "1",
                    "OI_RUNNER_API_URL": self._api_base_url(),
                    "OI_RUNNER_SECRET": settings.runner_shared_secret,
                    "OI_RUNNER_USER_ID": user_id,
                    "OI_RUNNER_ORIGIN": "server_runner",
                    "OI_RUNNER_LABEL": handle.runner_label,
                    "OI_RUNNER_ID": handle.runner_id,
                    "OI_RUNNER_BOOTSTRAP_URL": settings.server_runner_bootstrap_url,
                    "OI_RUNNER_CHROME_USER_DATA_DIR": f"/tmp/oi-server-runner-{handle.runner_id}",
                }
            )
            if settings.server_runner_chrome_path.strip():
                env["OI_RUNNER_CHROME_PATH"] = settings.server_runner_chrome_path.strip()
            if settings.server_runner_cdp_url.strip():
                env["OI_RUNNER_CDP_URL"] = settings.server_runner_cdp_url.strip()

            handle.state = "starting"
            handle.error = None
            handle.session_id = None
            handle.cdp_url = None
            process = await asyncio.create_subprocess_exec(
                *command,
                cwd=self._cwd(),
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            handle.process = process
            assert process.stdout is not None
            assert process.stderr is not None
            try:
                payload = await asyncio.wait_for(
                    self._read_ready_payload(process.stdout, handle.runner_id),
                    timeout=settings.server_runner_start_timeout_seconds,
                )
            except TimeoutError as exc:
                await self._terminate_process(process)
                handle.state = "error"
                handle.error = "Timed out while starting the managed remote browser."
                record_managed_runner_event(origin="server_runner", event="start_timeout")
                raise RuntimeError(handle.error) from exc

            if process.returncode is not None:
                stderr = await process.stderr.read()
                handle.state = "error"
                handle.error = (stderr.decode("utf-8", errors="ignore").strip() or "Managed remote browser exited during startup.")
                record_managed_runner_event(origin="server_runner", event="start_failed")
                raise RuntimeError(handle.error)

            handle.session_id = str(payload.get("sessionId") or "").strip() or None
            handle.cdp_url = str(payload.get("cdpUrl") or "").strip() or None
            handle.state = "ready"
            record_managed_runner_event(origin="server_runner", event="start_succeeded")
            handle.stdout_task = asyncio.create_task(self._drain_stream(process.stdout, handle.runner_id, "stdout"))
            handle.stderr_task = asyncio.create_task(self._drain_stream(process.stderr, handle.runner_id, "stderr"))
            handle.wait_task = asyncio.create_task(self._watch_process(handle))
            return await self.status(user_id)

    async def stop(self, user_id: str) -> ManagedRunnerStatus:
        handle = self._handles.get(user_id)
        if handle is None:
            return await self.status(user_id)
        handle.state = "stopping"
        if handle.process is not None and handle.process.returncode is None:
            await self._terminate_process(handle.process)
        record_managed_runner_event(origin="server_runner", event="stop_requested")
        await self._mark_session_stopped(handle)
        await self._finalize_handle(handle)
        return ManagedRunnerStatus(
            enabled=self._configured(),
            state="idle" if self._configured() else "disabled",
            origin="server_runner",
            runner_id=handle.runner_id,
            runner_label=handle.runner_label,
            session_id=None,
            cdp_url=None,
            error=None,
        )

    async def shutdown(self) -> None:
        handles = list(self._handles.values())
        for handle in handles:
            with contextlib.suppress(Exception):
                await self.stop(handle.user_id)

    async def _drain_stream(self, stream: asyncio.StreamReader, runner_id: str, stream_name: str) -> None:
        while True:
            line = await stream.readline()
            if not line:
                return
            logger.info(
                "Managed runner output",
                extra={"runner_id": runner_id, "stream": stream_name, "message": line.decode("utf-8", errors="ignore").rstrip()},
            )

    async def _read_ready_payload(self, stream: asyncio.StreamReader, runner_id: str) -> dict[str, object]:
        while True:
            line = await stream.readline()
            if not line:
                raise RuntimeError("Managed remote browser exited before reporting readiness.")
            message = line.decode("utf-8", errors="ignore").strip()
            if not message:
                continue
            try:
                payload = json.loads(message)
            except json.JSONDecodeError:
                logger.info(
                    "Managed runner startup output",
                    extra={"runner_id": runner_id, "stream": "stdout", "message": message},
                )
                continue
            if isinstance(payload, dict) and payload.get("runner") == "ready":
                return payload
            logger.info(
                "Managed runner startup payload",
                extra={"runner_id": runner_id, "stream": "stdout", "message": message},
            )

    async def _watch_process(self, handle: _ManagedRunnerHandle) -> None:
        process = handle.process
        if process is None:
            return
        returncode = await process.wait()
        if returncode == 0 and handle.state == "stopping":
            return
        stderr = ""
        if process.stderr is not None:
            more = await process.stderr.read()
            stderr = more.decode("utf-8", errors="ignore").strip()
        handle.state = "error"
        handle.error = stderr or f"Managed remote browser exited with code {returncode}."
        record_managed_runner_event(origin="server_runner", event="process_exited")
        await self._mark_session_stopped(handle)

    async def _mark_session_stopped(self, handle: _ManagedRunnerHandle) -> None:
        if not handle.session_id:
            return
        with contextlib.suppress(Exception):
            await browser_session_manager.update_session(
                session_id=handle.session_id,
                request=UpdateBrowserSessionRequest(status="stopped"),
            )

    async def _finalize_handle(self, handle: _ManagedRunnerHandle) -> None:
        for task in (handle.stdout_task, handle.stderr_task, handle.wait_task):
            if task is None:
                continue
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        handle.process = None
        handle.stdout_task = None
        handle.stderr_task = None
        handle.wait_task = None

    async def _terminate_process(self, process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=10)
        except TimeoutError:
            process.kill()
            await process.wait()


server_runner_manager = ServerRunnerManager()
