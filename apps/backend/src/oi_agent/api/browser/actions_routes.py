from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends

from oi_agent.api.browser.common import resolve_device_and_tab
from oi_agent.api.browser.models import (
    BrowserActionRequest,
    BrowserNavigateRequest,
    BrowserSnapshotRequest,
)
from oi_agent.auth.firebase_auth import get_current_user

actions_router = APIRouter()


@actions_router.post("/browser/act")
async def browser_act(
    payload: BrowserActionRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    _ = user["uid"]
    from oi_agent.api.websocket import connection_manager

    device_id, tab_id = resolve_device_and_tab(payload.device_id, payload.tab_id)

    cmd_id = str(uuid.uuid4())[:8]
    command: dict[str, Any] = {
        "type": "extension_command",
        "payload": {
            "cmd_id": cmd_id,
            "run_id": payload.run_id or "browser-api",
            "action": payload.action,
            "target": payload.target,
            "value": payload.value,
        },
    }
    if tab_id is not None:
        command["payload"]["tab_id"] = tab_id

    timeout = payload.timeout_seconds or (20.0 if payload.action == "navigate" else 30.0)
    result = await connection_manager.send_command_and_wait(device_id, command, timeout=timeout)
    return {
        "device_id": device_id,
        "attached_target": connection_manager.get_attached_target(device_id, tab_id),
        "result": result,
    }


@actions_router.post("/browser/navigate")
async def browser_navigate(
    payload: BrowserNavigateRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    return await browser_act(
        BrowserActionRequest(
            action="navigate",
            target=payload.url,
            device_id=payload.device_id,
            tab_id=payload.tab_id,
            run_id=payload.run_id,
            timeout_seconds=20.0,
        ),
        user,
    )


@actions_router.post("/browser/snapshot")
async def browser_snapshot(
    payload: BrowserSnapshotRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    return await browser_act(
        BrowserActionRequest(
            action="read_dom",
            target="",
            device_id=payload.device_id,
            tab_id=payload.tab_id,
            run_id=payload.run_id,
            timeout_seconds=25.0,
        ),
        user,
    )
