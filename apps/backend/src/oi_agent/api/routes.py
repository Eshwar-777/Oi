from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from oi_agent.agents.orchestrator import AgentOrchestrator
from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.automation.runtime_client import fetch_runtime_readiness
from oi_agent.automation.sessions.manager import browser_session_manager
from oi_agent.config import settings

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
    device_id: str | None = None
    fcm_token: str | None = None


class DeviceUpdateRequest(BaseModel):
    device_name: str | None = Field(default=None, min_length=1)
    fcm_token: str | None = None
    is_online: bool | None = None


class MeshInviteRequest(BaseModel):
    email: str = Field(..., min_length=1)
    group_id: str = Field(..., min_length=1)


class DevicePairingSessionCreateRequest(BaseModel):
    expires_in_seconds: int = Field(default=300, ge=60, le=900)


class DevicePairingRedeemRequest(BaseModel):
    pairing_id: str = Field(..., min_length=1)
    code: str = Field(..., min_length=4)
    device_type: str = Field(..., min_length=1)
    device_name: str = Field(..., min_length=1)
    device_id: str | None = None
    fcm_token: str | None = None


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/ready")
async def readiness() -> dict[str, Any]:
    missing = settings.validate_startup()
    runtime_ready: dict[str, Any]
    try:
        runtime_ready = await fetch_runtime_readiness() if settings.automation_runtime_enabled else {"ready": False, "detail": "Runtime disabled"}
    except Exception as exc:
        runtime_ready = {"ready": False, "detail": str(exc)}
    session_probe = await browser_session_manager.list_sessions(user_id="dev-user") if settings.env == "dev" else []
    status = "ok" if not missing and runtime_ready.get("ready", False) else "degraded"
    return {
        "status": status,
        "service": settings.app_name,
        "environment": settings.env,
        "config_summary": settings.redacted_summary(),
        "checks": {
            "config": "ok" if not missing else "missing",
            "runtime": "ok" if runtime_ready.get("ready", False) else "degraded",
            "runner_sessions": "ok" if session_probe else "missing",
            "firestore_database": settings.firestore_database,
            "pubsub_topic_tasks": settings.pubsub_topic_tasks,
        },
        "runtime": runtime_ready,
        "missing": missing,
    }


@router.post("/internal/check-scheduled-tasks")
async def check_scheduled_tasks() -> dict[str, Any]:
    logger.info(
        "Scheduled task check invoked",
        extra={
            "environment": settings.env,
            "pubsub_topic_tasks": settings.pubsub_topic_tasks,
        },
    )
    return {
        "status": "ok",
        "checked": 0,
        "dispatched": 0,
        "mode": "noop",
        "detail": "Scheduled task trigger is wired. Pub/Sub-backed dispatch is not implemented yet.",
    }


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
    linked_id = await registry.link_device(
        user_id=user["uid"],
        device_id=payload.device_id or str(uuid.uuid4()),
        device_type=payload.device_type,
        device_name=payload.device_name,
        fcm_token=payload.fcm_token,
    )
    return {"device_id": linked_id}


@router.post("/devices/pairing/session")
async def create_device_pairing_session(
    payload: DevicePairingSessionCreateRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> dict[str, Any]:
    from oi_agent.mesh.device_registry import DeviceRegistry

    registry = DeviceRegistry()
    session = await registry.create_pairing_session(
        user_id=user["uid"],
        expires_in_seconds=payload.expires_in_seconds,
    )
    pairing_id = str(session["pairing_id"])
    code = str(session["code"])
    pairing_uri = f"oi://pair-device?pairing_id={pairing_id}&code={code}"
    return {
        **session,
        "pairing_uri": pairing_uri,
        "qr_payload": pairing_uri,
    }


@router.get("/devices/pairing/session/{pairing_id}")
async def get_device_pairing_session(
    pairing_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> dict[str, Any]:
    from oi_agent.mesh.device_registry import DeviceRegistry

    registry = DeviceRegistry()
    session = await registry.get_pairing_session(
        pairing_id=pairing_id,
        owner_user_id=user["uid"],
    )
    if not session:
        raise HTTPException(status_code=404, detail="Pairing session not found.")
    return {
        "pairing_id": session.get("pairing_id"),
        "status": session.get("status"),
        "created_at": session.get("created_at"),
        "expires_at": session.get("expires_at"),
        "linked_device_id": session.get("linked_device_id"),
        "linked_device_name": session.get("linked_device_name"),
        "linked_device_type": session.get("linked_device_type"),
    }


@router.post("/devices/pairing/redeem")
async def redeem_device_pairing(
    payload: DevicePairingRedeemRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> dict[str, Any]:
    from oi_agent.mesh.device_registry import DeviceRegistry

    registry = DeviceRegistry()
    try:
        result = await registry.redeem_pairing_session(
            pairing_id=payload.pairing_id,
            owner_user_id=user["uid"],
            code=payload.code,
            device_type=payload.device_type,
            device_name=payload.device_name,
            device_id=payload.device_id,
            fcm_token=payload.fcm_token,
        )
        return {"ok": True, **result}
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/devices")
async def list_devices(
    user: dict[str, str] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    from oi_agent.api.websocket import connection_manager
    from oi_agent.mesh.device_registry import DeviceRegistry

    registry = DeviceRegistry()
    devices = await registry.get_user_devices(user["uid"])
    connected_ids = set(connection_manager.get_connected_device_ids_for_user(user["uid"]))

    enriched: list[dict[str, Any]] = []
    for d in devices:
        row = registry.normalize_device_presence(
            dict(d),
            connected=str(d.get("device_id", "")) in connected_ids,
        )
        device_id = str(row.get("device_id", ""))
        row["connected"] = device_id in connected_ids
        enriched.append(row)
    return enriched


@router.patch("/devices/{device_id}")
async def update_device(
    device_id: str,
    payload: DeviceUpdateRequest,
    user: dict[str, str] = Depends(get_current_user),
) -> dict[str, str | bool]:
    from oi_agent.mesh.device_registry import DeviceRegistry

    if (
        payload.device_name is None
        and payload.fcm_token is None
        and payload.is_online is None
    ):
        raise HTTPException(status_code=400, detail="No device fields to update.")

    registry = DeviceRegistry()
    updated = await registry.update_device(
        user_id=user["uid"],
        device_id=device_id,
        device_name=payload.device_name,
        fcm_token=payload.fcm_token,
        is_online=payload.is_online,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Device not found.")
    return {"ok": True, "device_id": device_id}


@router.delete("/devices/{device_id}")
async def delete_device(
    device_id: str,
    user: dict[str, str] = Depends(get_current_user),
) -> dict[str, str | bool]:
    from oi_agent.mesh.device_registry import DeviceRegistry

    registry = DeviceRegistry()
    deleted = await registry.unregister_device(user["uid"], device_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Device not found.")
    return {"ok": True, "device_id": device_id}


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
