from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from oi_agent.auth.firebase_auth import get_current_user

tabs_router = APIRouter()


@tabs_router.get("/browser/tabs")
async def list_browser_tabs(
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user["uid"]
    from oi_agent.api.websocket import connection_manager

    return {"items": connection_manager.list_attached_targets()}
