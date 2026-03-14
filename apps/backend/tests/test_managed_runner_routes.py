from __future__ import annotations

from httpx import ASGITransport, AsyncClient
import pytest
import pytest_asyncio
from fastapi import FastAPI

from oi_agent.api.browser.managed_runner_routes import managed_runner_router
from oi_agent.api.browser.server_runner_manager import server_runner_manager
from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.automation.sessions.models import ManagedRunnerStatus


@pytest_asyncio.fixture
async def app() -> FastAPI:
    test_app = FastAPI()
    test_app.include_router(managed_runner_router)

    async def fake_get_current_user() -> dict[str, str]:
        return {"uid": "user-123", "email": "test@example.com"}

    test_app.dependency_overrides[get_current_user] = fake_get_current_user
    return test_app


@pytest_asyncio.fixture
async def client(app: FastAPI):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as current_client:
        yield current_client


@pytest.mark.asyncio
async def test_get_managed_runner_status(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_status(user_id: str) -> ManagedRunnerStatus:
        assert user_id == "user-123"
        return ManagedRunnerStatus(enabled=True, state="ready", session_id="sess-1", runner_id="runner-1")

    monkeypatch.setattr(server_runner_manager, "status", fake_status)

    response = await client.get("/browser/server-runner")

    assert response.status_code == 200
    assert response.json()["runner"]["session_id"] == "sess-1"


@pytest.mark.asyncio
async def test_start_managed_runner(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_start(user_id: str) -> ManagedRunnerStatus:
        assert user_id == "user-123"
        return ManagedRunnerStatus(enabled=True, state="ready", session_id="sess-2", runner_id="runner-2")

    monkeypatch.setattr(server_runner_manager, "start", fake_start)

    response = await client.post("/browser/server-runner/start")

    assert response.status_code == 200
    body = response.json()
    assert body["runner"]["runner_id"] == "runner-2"
    assert body["runner"]["state"] == "ready"


@pytest.mark.asyncio
async def test_start_managed_runner_returns_503_on_runtime_error(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_start(_: str) -> ManagedRunnerStatus:
        raise RuntimeError("Remote sessions are not enabled on this backend.")

    monkeypatch.setattr(server_runner_manager, "start", fake_start)

    response = await client.post("/browser/server-runner/start")

    assert response.status_code == 503
    assert response.json()["detail"] == "Remote sessions are not enabled on this backend."


@pytest.mark.asyncio
async def test_stop_managed_runner(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_stop(user_id: str) -> ManagedRunnerStatus:
        assert user_id == "user-123"
        return ManagedRunnerStatus(enabled=True, state="idle", runner_id="runner-3")

    monkeypatch.setattr(server_runner_manager, "stop", fake_stop)

    response = await client.post("/browser/server-runner/stop")

    assert response.status_code == 200
    assert response.json()["runner"]["state"] == "idle"
