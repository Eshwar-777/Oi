"""Device management API routes — Firebase Auth + Firestore.

Endpoints:
  POST /enrollments              — start enrollment (challenge)
  POST /enrollments/:id/complete — prove key possession → create device
  GET  /me/devices               — list user's devices
  POST /devices/:id/revoke       — block device + revoke creds
  POST /devices/:id/rotate-key   — rotate Ed25519 key (requires PoP)
  PATCH /devices/:id             — update display_name / versions
  GET  /secure/profile           — sample PoP-protected route
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.devices import enrollment, service
from oi_agent.devices.pop_auth import get_current_device_user
from oi_agent.devices.schemas import (
    DeviceListResponse,
    DeviceResponse,
    DeviceUpdateRequest,
    EnrollmentCompleteRequest,
    EnrollmentCompleteResponse,
    EnrollmentStartRequest,
    EnrollmentStartResponse,
    KeyRotationRequest,
    KeyRotationResponse,
    SecureProfileResponse,
)

device_router = APIRouter(tags=["devices"])


def _doc_to_response(d: dict[str, Any]) -> DeviceResponse:
    return DeviceResponse(
        id=d.get("id", d.get("device_id", "")),
        platform=d.get("platform", ""),
        device_class=d.get("deviceClass", ""),
        display_name=d.get("displayName", ""),
        manufacturer=d.get("manufacturer"),
        model=d.get("model"),
        os_version=d.get("osVersion"),
        app_version=d.get("appVersion"),
        status=d.get("status", ""),
        trust_level=d.get("trustLevel", ""),
        created_at=d.get("createdAt", ""),
        last_seen_at=d.get("lastSeenAt", ""),
    )


# ---------------------------------------------------------------------------
# Enrollments
# ---------------------------------------------------------------------------

@device_router.post("/enrollments", response_model=EnrollmentStartResponse)
async def start_enrollment_route(
    body: EnrollmentStartRequest,
    user: dict[str, Any] = Depends(get_current_user),
):
    result = await enrollment.start_enrollment(
        uid=user["uid"],
        platform=body.platform.value,
        device_class=body.device_class.value,
        display_name=body.display_name,
        flow=body.flow.value,
        manufacturer=body.manufacturer,
        model=body.model,
        os_version=body.os_version,
        app_version=body.app_version,
    )
    return EnrollmentStartResponse(**result)


@device_router.post(
    "/enrollments/{enrollment_id}/complete",
    response_model=EnrollmentCompleteResponse,
)
async def complete_enrollment_route(
    enrollment_id: str,
    body: EnrollmentCompleteRequest,
):
    try:
        result = await enrollment.complete_enrollment(
            enrollment_id=enrollment_id,
            pubkey_b64=body.pubkey_ed25519,
            signature_b64=body.signature,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return EnrollmentCompleteResponse(device_id=result["device_id"])


# ---------------------------------------------------------------------------
# Device management (Firebase Auth required)
# ---------------------------------------------------------------------------

@device_router.get("/me/devices", response_model=DeviceListResponse)
async def list_my_devices(user: dict[str, Any] = Depends(get_current_user)):
    devices = await service.list_user_devices(user["uid"])
    return DeviceListResponse(devices=[_doc_to_response(d) for d in devices])


@device_router.post("/devices/{device_id}/revoke", response_model=DeviceResponse)
async def revoke_device_route(
    device_id: str,
    user: dict[str, Any] = Depends(get_current_user),
):
    try:
        result = await service.revoke_device(device_id, user["uid"])
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return _doc_to_response(result)


@device_router.post("/devices/{device_id}/rotate-key", response_model=KeyRotationResponse)
async def rotate_key_route(
    device_id: str,
    body: KeyRotationRequest,
    ctx: dict = Depends(get_current_device_user),
):
    if ctx["device_id"] != device_id:
        raise HTTPException(status_code=403, detail="PoP device does not match path")
    try:
        result = await service.rotate_key(
            device_id=device_id,
            uid=ctx["uid"],
            new_pubkey_b64=body.new_pubkey_ed25519,
            authorization_signature_b64=body.authorization_signature,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return KeyRotationResponse(**result)


@device_router.patch("/devices/{device_id}", response_model=DeviceResponse)
async def update_device_route(
    device_id: str,
    body: DeviceUpdateRequest,
    user: dict[str, Any] = Depends(get_current_user),
):
    try:
        result = await service.update_device_metadata(
            device_id=device_id,
            uid=user["uid"],
            display_name=body.display_name,
            os_version=body.os_version,
            app_version=body.app_version,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return _doc_to_response(result)


# ---------------------------------------------------------------------------
# Secure sample route (requires PoP)
# ---------------------------------------------------------------------------

@device_router.get("/secure/profile", response_model=SecureProfileResponse)
async def secure_profile(ctx: dict = Depends(get_current_device_user)):
    return SecureProfileResponse(
        user_id=ctx["uid"],
        email="",
        device_id=ctx["device_id"],
        device_name=ctx["device"].get("displayName", ""),
    )
