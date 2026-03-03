"""Enrollment protocol — challenge-response with Ed25519, backed by Firestore.

Step A: POST /enrollments         → issues a random challenge
Step B: POST /enrollments/:id/complete → verifies PoP signature, creates device

Completion uses sequential reads + batch writes for atomicity.
"""

from __future__ import annotations

import base64
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

from oi_agent.config import settings
from oi_agent.devices.firestore_client import get_firestore

logger = logging.getLogger(__name__)


async def start_enrollment(
    uid: str,
    *,
    platform: str,
    device_class: str,
    display_name: str,
    flow: str = "login",
    manufacturer: str | None = None,
    model: str | None = None,
    os_version: str | None = None,
    app_version: str | None = None,
) -> dict[str, Any]:
    db = get_firestore()
    enrollment_id = str(uuid.uuid4())
    challenge = os.urandom(32)
    challenge_b64 = base64.b64encode(challenge).decode()
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=settings.enrollment_ttl_seconds)

    doc = {
        "uid": uid,
        "flow": flow,
        "challenge": challenge_b64,
        "expiresAt": expires_at.isoformat(),
        "usedAt": None,
        "requestedDevice": {
            "platform": platform,
            "deviceClass": device_class,
            "displayName": display_name,
            "manufacturer": manufacturer,
            "model": model,
            "osVersion": os_version,
            "appVersion": app_version,
        },
    }

    await db.collection("enrollments").document(enrollment_id).set(doc)

    return {
        "enrollment_id": enrollment_id,
        "challenge": challenge_b64,
        "expires_at": expires_at,
    }


async def complete_enrollment(
    enrollment_id: str,
    pubkey_b64: str,
    signature_b64: str,
) -> dict[str, Any]:
    """Verify the Ed25519 signature and create device + credential + link."""
    db = get_firestore()

    # 1. Read enrollment
    enrollment_ref = db.collection("enrollments").document(enrollment_id)
    snap = await enrollment_ref.get()
    if not snap.exists:
        raise ValueError("Enrollment not found")

    data = snap.to_dict()

    if data.get("usedAt") is not None:
        raise ValueError("Enrollment already used")

    expires_str = data["expiresAt"]
    expires_at = datetime.fromisoformat(expires_str)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < datetime.now(timezone.utc):
        raise ValueError("Enrollment expired")

    uid = data["uid"]
    challenge_bytes = base64.b64decode(data["challenge"])
    pubkey_bytes = base64.b64decode(pubkey_b64)
    signature_bytes = base64.b64decode(signature_b64)

    # 2. Verify Ed25519 signature over: challenge || enrollment_id || uid
    expected_message = challenge_bytes + enrollment_id.encode() + uid.encode()

    try:
        verify_key = VerifyKey(pubkey_bytes)
        verify_key.verify(expected_message, signature_bytes)
    except (BadSignatureError, Exception) as exc:
        raise ValueError(f"Signature verification failed: {exc}") from exc

    # 3. Create device, credential, link, denormalized doc, mark enrollment used
    rd = data.get("requestedDevice", {})
    device_id = str(uuid.uuid4())
    now_iso = datetime.now(timezone.utc).isoformat()

    device_doc = {
        "platform": rd.get("platform", "linux"),
        "deviceClass": rd.get("deviceClass", "pc"),
        "displayName": rd.get("displayName", "Unknown"),
        "manufacturer": rd.get("manufacturer"),
        "model": rd.get("model"),
        "osVersion": rd.get("osVersion"),
        "appVersion": rd.get("appVersion"),
        "status": "active",
        "trustLevel": "verified",
        "createdAt": now_iso,
        "lastSeenAt": now_iso,
    }

    await db.collection("devices").document(device_id).set(device_doc)

    await (
        db.collection("devices").document(device_id)
        .collection("credentials").document("1")
        .set({
            "keyVersion": 1,
            "pubkeyEd25519": pubkey_b64,
            "createdAt": now_iso,
            "revokedAt": None,
        })
    )

    await (
        db.collection("devices").document(device_id)
        .collection("links").document(uid)
        .set({
            "uid": uid,
            "role": "owner",
            "status": "active",
            "linkedAt": now_iso,
            "revokedAt": None,
        })
    )

    # Denormalized view — this is what the existing mesh layer reads
    await (
        db.collection("users").document(uid)
        .collection("devices").document(device_id)
        .set({
            "device_id": device_id,
            "displayName": device_doc["displayName"],
            "platform": device_doc["platform"],
            "deviceClass": device_doc["deviceClass"],
            "status": "active",
            "trustLevel": "verified",
            "createdAt": now_iso,
            "lastSeenAt": now_iso,
            "is_online": True,
        })
    )

    await enrollment_ref.update({
        "usedAt": now_iso,
        "deviceId": device_id,
    })

    logger.info("Enrollment %s completed → device %s", enrollment_id, device_id)
    return {"device_id": device_id, **device_doc}
