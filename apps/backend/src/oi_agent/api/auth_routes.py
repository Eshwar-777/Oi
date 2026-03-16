from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from oi_agent.auth.csrf import clear_csrf_cookie, issue_csrf_cookie
from oi_agent.auth.firebase_auth import create_custom_token, create_session_cookie, get_current_user
from oi_agent.auth.handoff import create_auth_handoff, redeem_auth_handoff
from oi_agent.config import settings
from oi_agent.devices.firestore_client import get_firestore

auth_router = APIRouter(prefix="/api/auth", tags=["auth"])


class AuthHandoffCreateRequest(BaseModel):
    expires_in_seconds: int = Field(default=300, ge=60, le=900)


class AuthHandoffRedeemRequest(BaseModel):
    handoff_id: str = Field(..., min_length=1)
    code: str = Field(..., min_length=4)


@auth_router.post("/session")
async def create_or_refresh_session(
    request: Request,
    response: Response,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    uid = str(user.get("uid", "") or "")
    email = str(user.get("email", "") or "")
    now = datetime.now(UTC).isoformat()
    authorization = request.headers.get("Authorization", "")
    id_token = authorization[7:] if authorization.startswith("Bearer ") else ""

    if not id_token and settings.env != "dev":
        raise HTTPException(status_code=401, detail="Missing authorization token")

    if uid and (settings.gcp_project or settings.firebase_project_id):
        db = get_firestore()
        user_ref = db.collection("users").document(uid)
        existing = await user_ref.get()
        payload = {
            "uid": uid,
            "email": email,
            "lastLoginAt": now,
        }
        if not getattr(existing, "exists", False):
            payload["createdAt"] = now
        await user_ref.set(payload, merge=True)

    if settings.env == "dev" and not id_token:
        response.set_cookie(
            key=settings.auth_session_cookie_name,
            value="dev-session",
            httponly=True,
            secure=False,
            samesite=settings.auth_cookie_samesite,
            max_age=settings.auth_session_cookie_ttl_seconds,
            path="/",
        )
    elif id_token:
        response.set_cookie(
            key=settings.auth_session_cookie_name,
            value=create_session_cookie(id_token),
            httponly=True,
            secure=settings.is_production,
            samesite=settings.auth_cookie_samesite,
            max_age=settings.auth_session_cookie_ttl_seconds,
            path="/",
        )
    csrf_token = issue_csrf_cookie(response)

    return {
        "uid": uid,
        "email": email,
        "session_started_at": now,
        "csrf_token": csrf_token,
    }


@auth_router.get("/csrf")
async def issue_csrf(response: Response) -> dict[str, str]:
    token = issue_csrf_cookie(response)
    return {
        "csrf_token": token,
    }


@auth_router.delete("/session")
async def clear_session(
    response: Response,
) -> dict[str, Any]:
    response.delete_cookie(
        key=settings.auth_session_cookie_name,
        path="/",
        samesite=settings.auth_cookie_samesite,
    )
    clear_csrf_cookie(response)
    return {
        "cleared": True,
    }


@auth_router.post("/qr-handoff")
async def create_qr_handoff(
    payload: AuthHandoffCreateRequest,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    email = str(user.get("email", "") or "")
    handoff = await create_auth_handoff(
        user_id=str(user["uid"]),
        email=email,
        expires_in_seconds=payload.expires_in_seconds,
    )
    qr_payload = f"oi://auth?handoff_id={handoff['handoff_id']}&code={handoff['code']}"
    return {
        **handoff,
        "qr_payload": qr_payload,
    }


@auth_router.post("/qr-handoff/redeem")
async def redeem_qr_handoff(payload: AuthHandoffRedeemRequest) -> dict[str, str]:
    handoff = await redeem_auth_handoff(handoff_id=payload.handoff_id, code=payload.code)
    return {
        "uid": handoff["uid"],
        "email": handoff["email"],
        "custom_token": create_custom_token(handoff["uid"]),
    }
