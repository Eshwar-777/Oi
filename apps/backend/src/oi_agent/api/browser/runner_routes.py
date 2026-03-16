from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException

from oi_agent.automation.sessions.manager import browser_session_manager
from oi_agent.automation.sessions.models import (
    BrowserSessionResponse,
    CreateBrowserSessionRequest,
    RunnerHeartbeatRequest,
    RunnerRegisterRequest,
    UpdateBrowserSessionRequest,
)
from oi_agent.config import settings

runner_router = APIRouter()


def _assert_runner_secret(secret: str | None) -> None:
    configured = settings.runner_shared_secret.strip()
    if not configured:
        raise HTTPException(status_code=503, detail="Runner registration is not configured.")
    if (secret or "").strip() != configured:
        raise HTTPException(status_code=403, detail="Runner authentication failed.")


@runner_router.post("/browser/runners/register", response_model=BrowserSessionResponse)
async def register_runner_session(
    payload: RunnerRegisterRequest,
    x_oi_runner_secret: str | None = Header(default=None),
) -> BrowserSessionResponse:
    _assert_runner_secret(x_oi_runner_secret)
    session = await browser_session_manager.create_session(
        user_id=payload.user_id,
        request=CreateBrowserSessionRequest(
            origin=payload.origin,
            automation_engine=payload.automation_engine,
            browser_session_id=payload.browser_session_id,
            runner_id=payload.runner_id,
            runner_label=payload.runner_label,
            page_id=payload.page_id,
            browser_version=payload.browser_version,
            viewport=payload.viewport,
            metadata=dict(payload.metadata),
        ),
    )
    return BrowserSessionResponse(session=session)


@runner_router.post("/browser/runners/heartbeat", response_model=BrowserSessionResponse)
async def heartbeat_runner_session(
    payload: RunnerHeartbeatRequest,
    x_oi_runner_secret: str | None = Header(default=None),
) -> BrowserSessionResponse:
    _assert_runner_secret(x_oi_runner_secret)
    existing = await browser_session_manager.get_session(payload.session_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Browser session not found.")
    if existing.runner_id != payload.runner_id:
        raise HTTPException(status_code=409, detail="Runner does not own this browser session.")
    session = await browser_session_manager.update_session(
        session_id=payload.session_id,
        request=UpdateBrowserSessionRequest(
            status=payload.status,
            automation_engine=payload.automation_engine,
            browser_session_id=payload.browser_session_id,
            browser_version=payload.browser_version,
            page_id=payload.page_id,
            pages=payload.pages,
            viewport=payload.viewport,
            metadata=payload.metadata,
        ),
    )
    if session is None:
        raise HTTPException(status_code=404, detail="Browser session not found.")
    return BrowserSessionResponse(session=session)
