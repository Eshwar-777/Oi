from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from oi_agent.auth.firebase_auth import get_current_user

tabs_router = APIRouter()


@tabs_router.get("/browser/tabs")
async def list_browser_tabs(
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    from oi_agent.api.websocket import connection_manager
    from oi_agent.mesh.device_registry import DeviceRegistry

    registry = DeviceRegistry()
    linked_devices = await registry.get_user_devices(user["uid"])
    allowed_device_ids = {
        str(row.get("device_id", "") or "")
        for row in linked_devices
        if str(row.get("device_id", "") or "")
    }
    return {
        "items": [
            row
            for row in connection_manager.list_attached_targets()
            if str(row.get("device_id", "") or "") in allowed_device_ids
        ]
    }
