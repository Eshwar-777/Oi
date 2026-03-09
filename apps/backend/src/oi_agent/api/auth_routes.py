from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from oi_agent.auth.firebase_auth import create_custom_token, get_current_user
from oi_agent.auth.handoff import create_auth_handoff, redeem_auth_handoff

auth_router = APIRouter(prefix="/api/auth", tags=["auth"])


class AuthHandoffCreateRequest(BaseModel):
    expires_in_seconds: int = Field(default=300, ge=60, le=900)


class AuthHandoffRedeemRequest(BaseModel):
    handoff_id: str = Field(..., min_length=1)
    code: str = Field(..., min_length=4)


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
