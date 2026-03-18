from __future__ import annotations

from typing import Any

from oi_agent.automation.sessions.manager import browser_session_manager
from oi_agent.automation.sessions.models import BrowserSessionRecord
from oi_agent.config import settings


def browser_session_visible_to_user(session: BrowserSessionRecord | None, user_id: str) -> bool:
    if session is None:
        return False
    if session.user_id == user_id:
        return True
    return settings.env == "dev" and session.user_id == "dev-user"


async def list_browser_sessions_for_user(user_id: str) -> list[BrowserSessionRecord]:
    sessions = await browser_session_manager.list_sessions(user_id=user_id)
    if settings.env != "dev" or user_id == "dev-user":
        return sessions

    dev_sessions = await browser_session_manager.list_sessions(user_id="dev-user")
    merged: dict[str, BrowserSessionRecord] = {}
    for session in [*sessions, *dev_sessions]:
        merged[session.session_id] = session
    return sorted(
        merged.values(),
        key=lambda session: str(session.updated_at or session.created_at or ""),
        reverse=True,
    )


def browser_session_claims_owner(claims: dict[str, Any]) -> str:
    return str(claims.get("uid", "") or "")
