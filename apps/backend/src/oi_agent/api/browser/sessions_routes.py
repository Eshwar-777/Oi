from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.api.browser.authz import browser_session_visible_to_user, list_browser_sessions_for_user
from oi_agent.automation.sessions.manager import browser_session_manager
from oi_agent.automation.sessions.models import (
    BrowserSessionListResponse,
    BrowserSessionResponse,
    CreateBrowserSessionRequest,
    UpdateBrowserSessionRequest,
)

sessions_router = APIRouter()


@sessions_router.get("/browser/sessions", response_model=BrowserSessionListResponse)
async def list_browser_sessions(
    user: dict[str, Any] = Depends(get_current_user),
) -> BrowserSessionListResponse:
    items = await list_browser_sessions_for_user(str(user["uid"]))
    return BrowserSessionListResponse(items=items)


@sessions_router.post("/browser/sessions", response_model=BrowserSessionResponse)
async def create_browser_session(
    payload: CreateBrowserSessionRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> BrowserSessionResponse:
    session = await browser_session_manager.create_session(user_id=user["uid"], request=payload)
    return BrowserSessionResponse(session=session)


@sessions_router.get("/browser/sessions/{session_id}", response_model=BrowserSessionResponse)
async def get_browser_session(
    session_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> BrowserSessionResponse:
    session = await browser_session_manager.get_session(session_id)
    if not browser_session_visible_to_user(session, str(user["uid"])):
        raise HTTPException(status_code=404, detail="Browser session not found.")
    return BrowserSessionResponse(session=session)


@sessions_router.post("/browser/sessions/{session_id}", response_model=BrowserSessionResponse)
async def update_browser_session(
    session_id: str,
    payload: UpdateBrowserSessionRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> BrowserSessionResponse:
    existing = await browser_session_manager.get_session(session_id)
    if not browser_session_visible_to_user(existing, str(user["uid"])):
        raise HTTPException(status_code=404, detail="Browser session not found.")
    session = await browser_session_manager.update_session(session_id=session_id, request=payload)
    if session is None:
        raise HTTPException(status_code=404, detail="Browser session not found.")
    return BrowserSessionResponse(session=session)
