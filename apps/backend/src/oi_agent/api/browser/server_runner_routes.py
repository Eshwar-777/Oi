from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from oi_agent.api.browser.server_runner import server_browser_runner
from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.automation.sessions.models import BrowserSessionResponse

server_runner_router = APIRouter()


@server_runner_router.post("/browser/server-session/bootstrap", response_model=BrowserSessionResponse)
async def bootstrap_server_browser_session(
    user: dict[str, Any] = Depends(get_current_user),
) -> BrowserSessionResponse:
    session = await server_browser_runner.ensure_session(user_id=user["uid"])
    return BrowserSessionResponse(session=session)


@server_runner_router.post("/browser/server-session/{session_id}/stop")
async def stop_server_browser_session(
    session_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, bool]:
    await server_browser_runner.stop_session(user_id=user["uid"], session_id=session_id)
    return {"ok": True}
