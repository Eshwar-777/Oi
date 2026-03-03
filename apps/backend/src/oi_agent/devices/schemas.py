"""Pydantic request / response schemas for the device management API.

All enums are plain string enums (no SQLAlchemy dependency).
Auth is handled by Firebase — no local register/login schemas needed.
"""

from __future__ import annotations

import enum
from datetime import datetime

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class Platform(str, enum.Enum):
    ios = "ios"
    android = "android"
    windows = "windows"
    macos = "macos"
    linux = "linux"
    server = "server"


class DeviceClass(str, enum.Enum):
    mobile = "mobile"
    pc = "pc"
    server = "server"


class DeviceStatus(str, enum.Enum):
    pending = "pending"
    active = "active"
    blocked = "blocked"
    retired = "retired"


class TrustLevel(str, enum.Enum):
    untrusted = "untrusted"
    verified = "verified"
    managed = "managed"


class LinkRole(str, enum.Enum):
    owner = "owner"
    admin = "admin"
    user = "user"
    service = "service"


class LinkStatus(str, enum.Enum):
    active = "active"
    revoked = "revoked"


class EnrollmentFlow(str, enum.Enum):
    login = "login"
    pairing_code = "pairing_code"
    admin_approved = "admin_approved"


# ---------------------------------------------------------------------------
# Enrollment
# ---------------------------------------------------------------------------

class EnrollmentStartRequest(BaseModel):
    platform: Platform
    device_class: DeviceClass
    display_name: str = Field(..., min_length=1, max_length=255)
    manufacturer: str | None = None
    model: str | None = None
    os_version: str | None = None
    app_version: str | None = None
    flow: EnrollmentFlow = EnrollmentFlow.login


class EnrollmentStartResponse(BaseModel):
    enrollment_id: str
    challenge: str  # base64
    expires_at: datetime


class EnrollmentCompleteRequest(BaseModel):
    pubkey_ed25519: str  # base64
    signature: str  # base64


class EnrollmentCompleteResponse(BaseModel):
    device_id: str
    status: str = "active"


# ---------------------------------------------------------------------------
# Device responses
# ---------------------------------------------------------------------------

class DeviceResponse(BaseModel):
    id: str
    platform: str
    device_class: str
    display_name: str
    manufacturer: str | None = None
    model: str | None = None
    os_version: str | None = None
    app_version: str | None = None
    status: str
    trust_level: str
    created_at: datetime
    last_seen_at: datetime


class DeviceListResponse(BaseModel):
    devices: list[DeviceResponse]


# ---------------------------------------------------------------------------
# Device management
# ---------------------------------------------------------------------------

class DeviceUpdateRequest(BaseModel):
    display_name: str | None = None
    os_version: str | None = None
    app_version: str | None = None


class KeyRotationRequest(BaseModel):
    new_pubkey_ed25519: str  # base64 — the replacement public key
    authorization_signature: str  # base64 — old key signs: new_pubkey || device_id


class KeyRotationResponse(BaseModel):
    key_version: int
    device_id: str


# ---------------------------------------------------------------------------
# Secure route sample
# ---------------------------------------------------------------------------

class SecureProfileResponse(BaseModel):
    user_id: str
    email: str
    device_id: str
    device_name: str
    message: str = "Device PoP verified"
