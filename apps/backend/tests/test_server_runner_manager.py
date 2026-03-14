from __future__ import annotations

import pytest

from oi_agent.api.browser.server_runner_manager import ServerRunnerManager
from oi_agent.config import settings


@pytest.mark.asyncio
async def test_server_runner_manager_delegates_to_cloud_run_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    manager = ServerRunnerManager()
    monkeypatch.setattr(settings, "server_runner_backend", "cloud_run")

    async def fake_status(user_id: str):
        assert user_id == "user-123"
        return "cloud-status"

    monkeypatch.setattr(manager._cloud_run_backend, "status", fake_status)

    assert await manager.status("user-123") == "cloud-status"


@pytest.mark.asyncio
async def test_server_runner_manager_delegates_to_local_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    manager = ServerRunnerManager()
    monkeypatch.setattr(settings, "server_runner_backend", "local_process")

    async def fake_start(user_id: str):
        assert user_id == "user-456"
        return "local-start"

    monkeypatch.setattr(manager._local_backend, "start", fake_start)

    assert await manager.start("user-456") == "local-start"
