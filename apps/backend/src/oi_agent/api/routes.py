from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from oi_agent.agents.orchestrator import AgentOrchestrator
from oi_agent.auth.firebase_auth import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()
orchestrator = AgentOrchestrator()


class ChatRequest(BaseModel):
    user_id: str = Field(..., min_length=1)
    session_id: str = Field(..., min_length=1)
    message: str = Field(..., min_length=1)
    device_id: str | None = None


class DeviceRegisterRequest(BaseModel):
    device_type: str = Field(..., min_length=1)
    device_name: str = Field(..., min_length=1)
    fcm_token: str | None = None


class MeshInviteRequest(BaseModel):
    email: str = Field(..., min_length=1)
    group_id: str = Field(..., min_length=1)


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/chat")
async def chat(
    payload: ChatRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> dict[str, str]:
    try:
        response = await orchestrator.handle(
            user_id=user["uid"],
            session_id=payload.session_id,
            message=payload.message,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Chat failed: {exc}") from exc

    return {"response": response}


@router.post("/interact")
async def interact(
    payload: ChatRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> dict[str, str]:
    return await chat(payload, user)


@router.post("/devices/register")
async def register_device(
    payload: DeviceRegisterRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> dict[str, str]:
    from oi_agent.mesh.device_registry import DeviceRegistry

    registry = DeviceRegistry()
    device_id = await registry.register_device(
        user_id=user["uid"],
        device_type=payload.device_type,
        device_name=payload.device_name,
        fcm_token=payload.fcm_token,
    )
    return {"device_id": device_id}


@router.get("/devices")
async def list_devices(
    user: dict[str, str] = Depends(get_current_user),
) -> list[dict[str, str]]:
    from oi_agent.mesh.device_registry import DeviceRegistry

    registry = DeviceRegistry()
    return await registry.get_user_devices(user["uid"])


@router.post("/mesh/invite")
async def invite_mesh_member(
    payload: MeshInviteRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> dict[str, str]:
    from oi_agent.mesh.group_manager import MeshGroupManager

    manager = MeshGroupManager()
    try:
        await manager.invite_member(
            group_id=payload.group_id,
            inviter_user_id=user["uid"],
            invitee_user_id=payload.email,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    return {"status": "invited"}


@router.get("/mesh/groups")
async def list_mesh_groups(
    user: dict[str, str] = Depends(get_current_user),
) -> list[dict[str, str]]:
    from oi_agent.mesh.group_manager import MeshGroupManager

    manager = MeshGroupManager()
    return await manager.get_user_groups(user["uid"])


@router.get("/devices/connected")
async def list_connected_devices(
    user: dict[str, str] = Depends(get_current_user),
) -> list[dict[str, str]]:
    _ = user["uid"]
    from oi_agent.api.websocket import connection_manager

    devices = connection_manager.get_extension_device_ids()
    return [{"device_id": d, "status": "connected"} for d in devices]
