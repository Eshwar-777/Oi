from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import shlex
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import httpx

from oi_agent.automation.sessions.manager import browser_session_manager
from oi_agent.automation.sessions.models import BrowserSessionRecord, ManagedRunnerPhase, ManagedRunnerStatus, UpdateBrowserSessionRequest
from oi_agent.config import settings
from oi_agent.observability.metrics import record_managed_runner_event

logger = logging.getLogger(__name__)

_MANAGER_ROOT = Path(__file__).resolve().parents[4]
_REPO_ROOT = _MANAGER_ROOT.parents[1] if len(_MANAGER_ROOT.parents) > 1 else _MANAGER_ROOT
_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"


def _runner_id(user_id: str) -> str:
    token = "".join(ch for ch in user_id if ch.isalnum()).lower()[:12] or "user"
    return f"server-runner-{token}"


def _runner_label() -> str:
    return "Remote session"


def _normalize_backend_name(value: str) -> str:
    normalized = value.strip().lower()
    return normalized if normalized in {"local_process", "cloud_run"} else "local_process"


def _find_runner_session(sessions: list[BrowserSessionRecord], runner_id: str) -> BrowserSessionRecord | None:
    return next((item for item in sessions if item.origin == "server_runner" and item.runner_id == runner_id), None)


def _preferred_cloud_run_service_url(service: dict[str, object]) -> str:
    candidates: list[str] = []

    direct_urls = service.get("urls")
    if isinstance(direct_urls, list):
        for entry in direct_urls:
            url = str(entry or "").strip()
            if url:
                candidates.append(url)

    metadata = service.get("metadata")
    if isinstance(metadata, dict):
        annotations = metadata.get("annotations")
        if isinstance(annotations, dict):
            raw_urls = str(annotations.get("run.googleapis.com/urls") or "").strip()
            if raw_urls:
                with contextlib.suppress(Exception):
                    parsed = json.loads(raw_urls)
                    if isinstance(parsed, list):
                        for entry in parsed:
                            url = str(entry or "").strip()
                            if url:
                                candidates.append(url)

    status = service.get("status")
    if isinstance(status, dict):
        address = status.get("address")
        if isinstance(address, dict):
            url = str(address.get("url") or "").strip()
            if url:
                candidates.append(url)
        for key in ("url", "uri"):
            url = str(status.get(key) or "").strip()
            if url:
                candidates.append(url)

    for key in ("url", "uri"):
        url = str(service.get(key) or "").strip()
        if url:
            candidates.append(url)

    seen: set[str] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        return candidate
    return ""


class _ServerRunnerBackend(Protocol):
    async def status(self, user_id: str) -> ManagedRunnerStatus: ...
    async def start(self, user_id: str) -> ManagedRunnerStatus: ...
    async def stop(self, user_id: str) -> ManagedRunnerStatus: ...
    async def shutdown(self) -> None: ...


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


class _LocalProcessServerRunnerBackend:
    def __init__(self) -> None:
        self._handles: dict[str, _ManagedRunnerHandle] = {}
        self._lock = asyncio.Lock()

    def _configured(self) -> bool:
        return (
            settings.server_runner_enabled
            and _normalize_backend_name(settings.server_runner_backend) == "local_process"
            and bool(settings.server_runner_command.strip())
        )

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

    async def status(self, user_id: str) -> ManagedRunnerStatus:
        if not self._configured():
            return ManagedRunnerStatus(enabled=False, state="disabled")
        handle = self._handles.get(user_id)
        if handle is None:
            sessions = await browser_session_manager.list_sessions(user_id=user_id)
            existing = _find_runner_session(sessions, _runner_id(user_id))
            return ManagedRunnerStatus(
                enabled=True,
                state="ready" if existing and existing.status == "ready" else "idle",
                origin="server_runner",
                runner_id=existing.runner_id or _runner_id(user_id) if existing else _runner_id(user_id),
                runner_label=existing.runner_label or _runner_label() if existing else _runner_label(),
                session_id=existing.session_id if existing else None,
                error=None if existing or not settings.server_runner_enabled else "Remote session is not running.",
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
            raise RuntimeError("Remote sessions are not enabled on this backend.")

        async with self._lock:
            handle = self._handles.get(user_id)
            if handle is None:
                handle = _ManagedRunnerHandle(
                    user_id=user_id,
                    runner_id=_runner_id(user_id),
                    runner_label=_runner_label(),
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
                raise RuntimeError("Remote session worker command is empty.")
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
                handle.error = "Timed out while creating the remote session."
                record_managed_runner_event(origin="server_runner", event="start_timeout")
                raise RuntimeError(handle.error) from exc

            if process.returncode is not None:
                stderr = await process.stderr.read()
                handle.state = "error"
                handle.error = stderr.decode("utf-8", errors="ignore").strip() or "Remote session worker exited during startup."
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
        await self._mark_session_stopped(handle.session_id)
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
                raise RuntimeError("Remote session worker exited before reporting readiness.")
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
        handle.error = stderr or f"Remote session worker exited with code {returncode}."
        record_managed_runner_event(origin="server_runner", event="process_exited")
        await self._mark_session_stopped(handle.session_id)

    async def _mark_session_stopped(self, session_id: str | None) -> None:
        if not session_id:
            return
        with contextlib.suppress(Exception):
            await browser_session_manager.update_session(
                session_id=session_id,
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


class _CloudRunServerRunnerBackend:
    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = {}
        self._errors: dict[str, str] = {}
        self._details: dict[str, str] = {}
        self._phases: dict[str, ManagedRunnerPhase] = {}
        self._retry_counts: dict[str, int] = {}
        self._retrying: dict[str, bool] = {}
        self._credentials = None
        self._detected_project = ""

    def _configured(self) -> bool:
        return (
            settings.server_runner_enabled
            and _normalize_backend_name(settings.server_runner_backend) == "cloud_run"
            and bool(settings.server_runner_cloud_run_worker_image.strip())
            and bool(self._project().strip())
            and bool(settings.gcp_location.strip())
        )

    def _project(self) -> str:
        return settings.gcp_project.strip() or self._detected_project.strip()

    def _service_name(self, user_id: str) -> str:
        prefix = settings.server_runner_cloud_run_service_prefix.strip().lower() or "oi-remote-session"
        normalized_prefix = "".join(ch if ch.isalnum() or ch == "-" else "-" for ch in prefix).strip("-") or "oi-remote-session"
        digest = hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:12]
        max_prefix_length = max(1, 63 - len(digest) - 1)
        trimmed_prefix = normalized_prefix[:max_prefix_length].strip("-") or "oi"
        return f"{trimmed_prefix}-{digest}"

    def _service_url(self, user_id: str) -> str:
        project = self._project()
        location = settings.gcp_location.strip()
        return f"https://run.googleapis.com/v2/projects/{project}/locations/{location}/services/{self._service_name(user_id)}"

    def _api_base_url(self) -> str:
        configured = settings.server_runner_api_base_url.strip()
        if configured:
            return configured
        return f"http://127.0.0.1:{settings.app_port}"

    async def status(self, user_id: str) -> ManagedRunnerStatus:
        if not self._configured():
            return ManagedRunnerStatus(enabled=False, state="disabled", phase="idle")
        runner_id = _runner_id(user_id)
        sessions = await browser_session_manager.list_sessions(user_id=user_id)
        existing = _find_runner_session(sessions, runner_id)
        service = await self._get_service(user_id)
        if existing and existing.status == "ready":
            return ManagedRunnerStatus(
                enabled=True,
                state="ready",
                phase="ready",
                origin="server_runner",
                runner_id=runner_id,
                runner_label=existing.runner_label or _runner_label(),
                session_id=existing.session_id,
                error=None,
                detail=None,
                retry_count=self._retry_counts.get(user_id, 0),
            )
        if service is not None:
            return ManagedRunnerStatus(
                enabled=True,
                state="starting",
                phase=self._phases.get(user_id, "connecting"),
                origin="server_runner",
                runner_id=runner_id,
                runner_label=_runner_label(),
                session_id=existing.session_id if existing else None,
                error=self._errors.get(user_id),
                detail=self._details.get(user_id),
                retry_count=self._retry_counts.get(user_id, 0),
                can_retry=False,
                is_retrying=self._retrying.get(user_id, False),
            )
        if error := self._errors.get(user_id):
            return ManagedRunnerStatus(
                enabled=True,
                state="error",
                phase="failed",
                origin="server_runner",
                runner_id=runner_id,
                runner_label=_runner_label(),
                session_id=existing.session_id if existing else None,
                error=error,
                detail=self._details.get(user_id),
                retry_count=self._retry_counts.get(user_id, 0),
                can_retry=True,
                is_retrying=False,
            )
        return ManagedRunnerStatus(
            enabled=True,
            state="idle",
            phase="idle",
            origin="server_runner",
            runner_id=runner_id,
            runner_label=_runner_label(),
            session_id=existing.session_id if existing else None,
            retry_count=self._retry_counts.get(user_id, 0),
        )

    async def start(self, user_id: str) -> ManagedRunnerStatus:
        if not self._configured():
            raise RuntimeError("Remote sessions are not enabled on this backend.")
        lock = self._locks.setdefault(user_id, asyncio.Lock())
        async with lock:
            current = await self.status(user_id)
            if current.state == "ready":
                record_managed_runner_event(origin="server_runner", event="start_reused")
                return current
            record_managed_runner_event(origin="server_runner", event="start_in_progress")
            self._errors.pop(user_id, None)
            self._details.pop(user_id, None)
            self._phases[user_id] = "provisioning"
            self._retry_counts[user_id] = 0
            self._retrying[user_id] = False
            attempts = 0
            max_retries = 1
            while True:
                try:
                    self._phases[user_id] = "provisioning"
                    await self._recreate_service(user_id)
                    self._phases[user_id] = "booting_browser"
                    ready_status = await self._wait_for_session_ready(
                        user_id,
                        timeout_seconds=settings.server_runner_start_timeout_seconds,
                    )
                except RuntimeError as exc:
                    attempts += 1
                    self._retry_counts[user_id] = attempts
                    raw_error = str(exc).strip() or "Remote session startup failed."
                    self._details[user_id] = raw_error
                    if attempts <= max_retries:
                        self._retrying[user_id] = True
                        self._phases[user_id] = "provisioning"
                        with contextlib.suppress(Exception):
                            await self._delete_service_if_present(user_id)
                        continue
                    self._retrying[user_id] = False
                    self._phases[user_id] = "failed"
                    self._errors[user_id] = self._friendly_start_error(raw_error)
                    with contextlib.suppress(Exception):
                        await self._delete_service_if_present(user_id)
                    record_managed_runner_event(origin="server_runner", event="start_timeout")
                    raise RuntimeError(self._errors[user_id]) from exc
                self._errors.pop(user_id, None)
                self._details.pop(user_id, None)
                self._retrying[user_id] = False
                self._phases[user_id] = "ready"
                record_managed_runner_event(origin="server_runner", event="start_succeeded")
                return ready_status

    async def stop(self, user_id: str) -> ManagedRunnerStatus:
        if not self._configured():
            return ManagedRunnerStatus(enabled=False, state="disabled", phase="idle")
        lock = self._locks.setdefault(user_id, asyncio.Lock())
        async with lock:
            record_managed_runner_event(origin="server_runner", event="stop_requested")
            self._phases[user_id] = "idle"
            await self._delete_service_if_present(user_id)
            await self._mark_user_sessions_stopped(user_id)
            self._errors.pop(user_id, None)
            self._details.pop(user_id, None)
            self._retry_counts[user_id] = 0
            self._retrying[user_id] = False
            return ManagedRunnerStatus(
                enabled=True,
                state="idle",
                phase="idle",
                origin="server_runner",
                runner_id=_runner_id(user_id),
                runner_label=_runner_label(),
                session_id=None,
                cdp_url=None,
                error=None,
                detail=None,
            )

    async def shutdown(self) -> None:
        return

    async def _recreate_service(self, user_id: str) -> None:
        service_url = self._service_url(user_id)
        existing = await self._get_service(user_id)
        if existing is not None:
            await self._delete_service_if_present(user_id)
        response = await self._request(
            "POST",
            f"{service_url.rsplit('/', 1)[0]}?serviceId={self._service_name(user_id)}",
            json_body=self._build_service_spec(user_id),
            accepted_statuses={200, 201},
        )
        await self._wait_for_operation(response)

    async def _delete_service_if_present(self, user_id: str) -> None:
        response = await self._request("DELETE", self._service_url(user_id), accepted_statuses={200, 202, 204, 404})
        if response.status_code == 404:
            return
        if response.status_code == 204:
            return
        await self._wait_for_operation(response)

    async def _wait_for_session_ready(self, user_id: str, *, timeout_seconds: int) -> ManagedRunnerStatus:
        runner_id = _runner_id(user_id)
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        while asyncio.get_running_loop().time() < deadline:
            sessions = await browser_session_manager.list_sessions(user_id=user_id)
            existing = _find_runner_session(sessions, runner_id)
            if existing and existing.status == "ready":
                return ManagedRunnerStatus(
                    enabled=True,
                    state="ready",
                    phase="ready",
                    origin="server_runner",
                    runner_id=runner_id,
                    runner_label=existing.runner_label or _runner_label(),
                    session_id=existing.session_id,
                    error=None,
                )
            service = await self._get_service(user_id)
            if service is not None:
                self._phases[user_id] = "connecting"
            await asyncio.sleep(2)
        raise RuntimeError("Timed out while creating the remote session.")

    def _friendly_start_error(self, detail: str) -> str:
        lowered = detail.lower()
        if "timed out" in lowered:
            return "We couldn’t start your remote browser right now. Retry or use this computer instead."
        if "fetch failed" in lowered or "cdp" in lowered or "chrome" in lowered:
            return "The remote browser started but never became reachable. Retry or use this computer instead."
        return "We couldn’t start your remote browser right now. Retry or use this computer instead."

    async def _mark_user_sessions_stopped(self, user_id: str) -> None:
        runner_id = _runner_id(user_id)
        sessions = await browser_session_manager.list_sessions(user_id=user_id)
        for session in sessions:
            if session.origin != "server_runner" or session.runner_id != runner_id:
                continue
            with contextlib.suppress(Exception):
                await browser_session_manager.update_session(
                    session_id=session.session_id,
                    request=UpdateBrowserSessionRequest(status="stopped"),
                )

    def _build_service_spec(self, user_id: str) -> dict[str, object]:
        runner_id = _runner_id(user_id)
        env_items = {
            "OI_RUNNER_ENABLED": "1",
            "OI_RUNNER_API_URL": self._api_base_url(),
            "OI_RUNNER_SECRET": settings.runner_shared_secret,
            "OI_RUNNER_USER_ID": user_id,
            "OI_RUNNER_ORIGIN": "server_runner",
            "OI_RUNNER_LABEL": _runner_label(),
            "OI_RUNNER_ID": runner_id,
            "OI_RUNNER_BOOTSTRAP_URL": settings.server_runner_bootstrap_url,
            "OI_RUNNER_CHROME_PATH": settings.server_runner_chrome_path.strip() or "/usr/bin/chromium",
            "OI_RUNNER_CHROME_USER_DATA_DIR": "/tmp/chrome-profile",
        }
        container: dict[str, object] = {
            "image": settings.server_runner_cloud_run_worker_image.strip(),
            "env": [{"name": key, "value": value} for key, value in env_items.items()],
            "resources": {
                "limits": {
                    "cpu": settings.server_runner_cloud_run_cpu.strip() or "1",
                    "memory": settings.server_runner_cloud_run_memory.strip() or "2Gi",
                }
            },
        }
        template: dict[str, object] = {
            "timeout": f"{max(60, settings.server_runner_cloud_run_timeout_seconds)}s",
            "maxInstanceRequestConcurrency": 1,
            "scaling": {
                "minInstanceCount": max(0, settings.server_runner_cloud_run_min_instances),
                "maxInstanceCount": max(1, settings.server_runner_cloud_run_max_instances),
            },
            "containers": [container],
        }
        service_account = settings.server_runner_cloud_run_service_account.strip()
        if service_account:
            template["serviceAccount"] = service_account
        return {
            "ingress": self._ingress_value(),
            "template": template,
            "labels": {
                "oi-user": hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:16],
                "oi-runner-origin": "server-runner",
            },
        }

    def _ingress_value(self) -> str:
        normalized = settings.server_runner_cloud_run_ingress.strip().lower()
        mapping = {
            "all": "INGRESS_TRAFFIC_ALL",
            "internal": "INGRESS_TRAFFIC_INTERNAL_ONLY",
            "internal-and-cloud-load-balancing": "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
        }
        return mapping.get(normalized, "INGRESS_TRAFFIC_INTERNAL_ONLY")

    async def _get_service(self, user_id: str) -> dict[str, object] | None:
        response = await self._request("GET", self._service_url(user_id), accepted_statuses={200, 404})
        if response.status_code == 404:
            return None
        return response.json()

    async def _wait_for_operation(self, response: httpx.Response) -> dict[str, object] | None:
        payload = response.json() if response.content else {}
        if not isinstance(payload, dict):
            return None
        name = str(payload.get("name") or "").strip()
        if not name:
            return payload
        deadline = asyncio.get_running_loop().time() + max(30, settings.server_runner_start_timeout_seconds)
        while asyncio.get_running_loop().time() < deadline:
            operation = await self._request(
                "GET",
                f"https://run.googleapis.com/v2/{name}",
                accepted_statuses={200},
            )
            data = operation.json()
            if isinstance(data, dict) and data.get("done"):
                error = data.get("error")
                if isinstance(error, dict) and error:
                    message = str(error.get("message") or "Cloud Run operation failed.")
                    raise RuntimeError(message)
                return data
            await asyncio.sleep(1.5)
        raise RuntimeError("Timed out while waiting for the remote session worker operation.")

    async def _request(
        self,
        method: str,
        url: str,
        *,
        json_body: dict[str, object] | None = None,
        accepted_statuses: set[int],
    ) -> httpx.Response:
        headers = await self._authorized_headers()
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.request(method, url, headers=headers, json=json_body)
        if response.status_code not in accepted_statuses:
            detail = response.text.strip() or f"Unexpected status {response.status_code}"
            raise RuntimeError(f"Remote session worker request failed: {detail}")
        return response

    async def _authorized_headers(self) -> dict[str, str]:
        token = await asyncio.to_thread(self._refresh_access_token)
        return {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

    def _refresh_access_token(self) -> str:
        try:
            import google.auth
            from google.auth.transport.requests import Request
        except ImportError as exc:
            raise RuntimeError("google-auth is required for Cloud Run remote sessions.") from exc

        if self._credentials is None:
            credentials, detected_project = google.auth.default(scopes=[_CLOUD_PLATFORM_SCOPE])
            self._credentials = credentials
            self._detected_project = detected_project or ""
        credentials = self._credentials
        if credentials is None:
            raise RuntimeError("Could not load Google Cloud credentials for remote sessions.")
        if not getattr(credentials, "valid", False) or not getattr(credentials, "token", None):
            credentials.refresh(Request())
        return str(credentials.token)


class ServerRunnerManager:
    def __init__(self) -> None:
        self._local_backend = _LocalProcessServerRunnerBackend()
        self._cloud_run_backend = _CloudRunServerRunnerBackend()

    def _backend(self) -> _ServerRunnerBackend:
        if _normalize_backend_name(settings.server_runner_backend) == "cloud_run":
            return self._cloud_run_backend
        return self._local_backend

    async def status(self, user_id: str) -> ManagedRunnerStatus:
        return await self._backend().status(user_id)

    async def start(self, user_id: str) -> ManagedRunnerStatus:
        return await self._backend().start(user_id)

    async def stop(self, user_id: str) -> ManagedRunnerStatus:
        return await self._backend().stop(user_id)

    async def resolve_session_cdp_url(
        self,
        *,
        user_id: str,
        origin: str,
        metadata: dict[str, str] | None,
    ) -> str:
        cdp_url = str((metadata or {}).get("cdp_url", "") or "").strip()
        if origin != "server_runner":
            return cdp_url
        if _normalize_backend_name(settings.server_runner_backend) != "cloud_run":
            return cdp_url
        service = await self._cloud_run_backend._get_service(user_id)
        if not isinstance(service, dict):
            return cdp_url
        service_url = _preferred_cloud_run_service_url(service)
        if not service_url:
            return cdp_url
        return f"{service_url.rstrip('/')}/cdp"

    async def shutdown(self) -> None:
        await self._backend().shutdown()


server_runner_manager = ServerRunnerManager()
