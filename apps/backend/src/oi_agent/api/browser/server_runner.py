from __future__ import annotations

import asyncio
import contextlib
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import Any
import shutil

import httpx

from oi_agent.automation.sessions.manager import browser_session_manager
from oi_agent.automation.sessions.models import (
    BrowserPageRecord,
    BrowserSessionRecord,
    BrowserViewport,
    CreateBrowserSessionRequest,
    UpdateBrowserSessionRequest,
)
from oi_agent.config import settings

_MANAGED_BY = "backend_server_runner"


@dataclass
class ManagedServerBrowser:
    session_id: str
    port: int
    cdp_url: str
    process: asyncio.subprocess.Process


def _free_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        sock.listen(1)
        return int(sock.getsockname()[1])


async def _playwright_executable_path() -> str:
    from playwright.async_api import async_playwright

    playwright = await async_playwright().start()
    try:
        return playwright.chromium.executable_path
    finally:
        await playwright.stop()


async def _resolve_browser_executable() -> str:
    configured = settings.server_browser_executable_path.strip()
    if configured and Path(configured).exists():
        return configured
    with contextlib.suppress(Exception):
        candidate = await _playwright_executable_path()
        if candidate and Path(candidate).exists():
            return candidate
    for candidate in (
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        shutil.which("google-chrome"),
        shutil.which("chromium"),
        shutil.which("chromium-browser"),
    ):
        if candidate and Path(candidate).exists():
            return str(candidate)
    raise RuntimeError("No browser executable found for managed server browser. Install Playwright Chromium or set SERVER_BROWSER_EXECUTABLE_PATH.")


async def _wait_for_cdp(cdp_url: str, timeout_seconds: float = 12.0) -> dict[str, Any]:
    timeout = asyncio.get_running_loop().time() + timeout_seconds
    async with httpx.AsyncClient(timeout=httpx.Timeout(2.0, read=2.0)) as client:
        while asyncio.get_running_loop().time() < timeout:
            try:
                response = await client.get(f"{cdp_url}/json/version")
                response.raise_for_status()
                payload = response.json()
                if isinstance(payload, dict):
                    return payload
            except Exception:
                await asyncio.sleep(0.25)
    raise RuntimeError("Managed browser did not expose a CDP endpoint in time.")


async def _list_pages(cdp_url: str) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=httpx.Timeout(3.0, read=3.0)) as client:
        response = await client.get(f"{cdp_url}/json/list")
        response.raise_for_status()
        payload = response.json()
        return payload if isinstance(payload, list) else []


async def _bootstrap_page(cdp_url: str) -> None:
    pages = await _list_pages(cdp_url)
    usable = [
        page for page in pages
        if str(page.get("type", "") or "") == "page" and str(page.get("url", "") or "") != "about:blank"
    ]
    if usable:
        return
    bootstrap_url = settings.server_browser_bootstrap_url.strip() or "https://example.com"
    async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, read=5.0)) as client:
        request_url = f"{cdp_url}/json/new?{bootstrap_url}"
        response = await client.put(request_url)
        if not response.is_success:
            response = await client.get(request_url)
        response.raise_for_status()


class ServerBrowserRunnerManager:
    def __init__(self) -> None:
        self._managed: dict[str, ManagedServerBrowser] = {}
        self._lock = asyncio.Lock()

    async def ensure_session(self, *, user_id: str) -> BrowserSessionRecord:
        if not settings.server_browser_enabled:
            raise RuntimeError("Server browser launch is disabled.")
        async with self._lock:
            existing = await self._find_existing_session(user_id=user_id)
            if existing is not None:
                return existing

            executable = await _resolve_browser_executable()
            port = _free_port(settings.server_browser_host)
            cdp_url = f"http://{settings.server_browser_host}:{port}"
            profile_root = Path(settings.server_browser_profile_root).expanduser()
            profile_root.mkdir(parents=True, exist_ok=True)
            profile_dir = profile_root / user_id
            profile_dir.mkdir(parents=True, exist_ok=True)
            args = [
                executable,
                f"--remote-debugging-port={port}",
                f"--user-data-dir={profile_dir}",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-dev-shm-usage",
                "--disable-background-networking",
                "--disable-sync",
                "--disable-extensions",
            ]
            if settings.server_browser_headless:
                args.append("--headless=new")
            args.append("about:blank")
            process = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                version = await _wait_for_cdp(cdp_url)
                await _bootstrap_page(cdp_url)
                pages_raw = await _list_pages(cdp_url)
            except Exception:
                with contextlib.suppress(ProcessLookupError):
                    process.terminate()
                with contextlib.suppress(Exception):
                    await process.wait()
                raise

            pages = [
                BrowserPageRecord(
                    page_id=str(page.get("id", "") or ""),
                    url=str(page.get("url", "") or ""),
                    title=str(page.get("title", "") or ""),
                    is_active=index == 0,
                )
                for index, page in enumerate(pages_raw)
                if str(page.get("type", "") or "") == "page"
            ]
            session = await browser_session_manager.create_session(
                user_id=user_id,
                request=CreateBrowserSessionRequest(
                    origin="server_runner",
                    automation_engine="agent_browser",
                    runner_id=f"server-runner:{user_id}",
                    runner_label="Server browser",
                    page_id=pages[0].page_id if pages else None,
                    browser_version=str(version.get("Browser", "") or ""),
                    viewport=BrowserViewport(width=1440, height=900, dpr=1.0),
                    metadata={
                        "cdp_url": cdp_url,
                        "managed_by": _MANAGED_BY,
                    },
                ),
            )
            session = await browser_session_manager.update_session(
                session_id=session.session_id,
                request=UpdateBrowserSessionRequest(
                    status="ready",
                    browser_version=str(version.get("Browser", "") or ""),
                    page_id=pages[0].page_id if pages else None,
                    pages=pages,
                    viewport=BrowserViewport(width=1440, height=900, dpr=1.0),
                    metadata={
                        "cdp_url": cdp_url,
                        "managed_by": _MANAGED_BY,
                    },
                ),
            ) or session
            self._managed[session.session_id] = ManagedServerBrowser(
                session_id=session.session_id,
                port=port,
                cdp_url=cdp_url,
                process=process,
            )
            return session

    async def stop_session(self, *, user_id: str, session_id: str) -> None:
        async with self._lock:
            session = await browser_session_manager.get_session(session_id)
            if session is None or session.user_id != user_id:
                return
            managed = self._managed.pop(session_id, None)
            if managed is not None and managed.process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    managed.process.terminate()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(managed.process.wait(), timeout=5.0)
            await browser_session_manager.update_session(
                session_id=session_id,
                request=UpdateBrowserSessionRequest(status="stopped"),
            )

    async def shutdown(self) -> None:
        async with self._lock:
            managed_items = list(self._managed.values())
            self._managed.clear()
        for managed in managed_items:
            if managed.process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    managed.process.terminate()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(managed.process.wait(), timeout=5.0)

    async def _find_existing_session(self, *, user_id: str) -> BrowserSessionRecord | None:
        sessions = await browser_session_manager.list_sessions(user_id=user_id)
        for session in sessions:
            metadata = dict(session.metadata or {})
            cdp_url = str(metadata.get("cdp_url", "") or "").strip()
            if session.origin != "server_runner":
                continue
            if metadata.get("managed_by") != _MANAGED_BY:
                continue
            if session.status not in {"ready", "busy"} or not cdp_url:
                continue
            try:
                await _wait_for_cdp(cdp_url, timeout_seconds=1.0)
                return session
            except Exception:
                continue
        return None


server_browser_runner = ServerBrowserRunnerManager()
