from __future__ import annotations

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from oi_agent.api.browser.session_stream_routes import (
    _session_frame_message,
    _session_frame_payload,
    session_stream_router,
)
from oi_agent.api.websocket import connection_manager
from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.automation.sessions.manager import browser_session_manager
from oi_agent.automation.sessions.models import BrowserSessionRecord


@pytest_asyncio.fixture
async def app() -> FastAPI:
    test_app = FastAPI()
    test_app.include_router(session_stream_router)

    async def fake_get_current_user() -> dict[str, str]:
        return {"uid": "user-123", "email": "test@example.com"}

    test_app.dependency_overrides[get_current_user] = fake_get_current_user
    return test_app


@pytest_asyncio.fixture
async def client(app: FastAPI):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as current_client:
        yield current_client


def _session_record() -> BrowserSessionRecord:
    return BrowserSessionRecord(
        session_id="sess-1",
        user_id="user-123",
        origin="server_runner",
        automation_engine="agent_browser",
        status="ready",
        created_at="2026-03-16T00:00:00+00:00",
        updated_at="2026-03-16T00:00:00+00:00",
    )


def test_session_frame_payload_unwraps_nested_message() -> None:
    frame = {
        "type": "session_frame",
        "payload": {
            "session_id": "sess-1",
            "screenshot": "data:image/png;base64,abc",
            "current_url": "https://example.com",
        },
        "timestamp": "2026-03-16T00:00:00+00:00",
    }

    assert _session_frame_payload(frame) == frame["payload"]
    assert _session_frame_message(frame) == frame


def test_session_frame_message_wraps_flat_payload() -> None:
    payload = {
        "session_id": "sess-1",
        "screenshot": "data:image/png;base64,abc",
        "current_url": "https://example.com",
    }

    assert _session_frame_payload(payload) == payload
    assert _session_frame_message(payload) == {
        "type": "session_frame",
        "payload": payload,
    }


@pytest.mark.asyncio
async def test_get_latest_session_frame_returns_inner_payload(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_get_session(session_id: str) -> BrowserSessionRecord | None:
        assert session_id == "sess-1"
        return _session_record()

    monkeypatch.setattr(browser_session_manager, "get_session", fake_get_session)
    monkeypatch.setattr(
        connection_manager,
        "get_latest_session_frame",
        lambda session_id: {
            "type": "session_frame",
            "payload": {
                "session_id": session_id,
                "screenshot": "data:image/png;base64,abc",
                "current_url": "https://example.com",
                "page_title": "Example",
                "page_id": "page-1",
                "timestamp": "2026-03-16T00:00:00+00:00",
            },
        },
    )

    response = await client.get("/browser/sessions/sess-1/frame")

    assert response.status_code == 200
    assert response.json() == {
        "session_id": "sess-1",
        "frame": {
            "session_id": "sess-1",
            "screenshot": "data:image/png;base64,abc",
            "current_url": "https://example.com",
            "page_title": "Example",
            "page_id": "page-1",
            "timestamp": "2026-03-16T00:00:00+00:00",
        },
    }
