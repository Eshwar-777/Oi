"""Device management business logic — Firestore-backed.

Uses sequential reads + writes. For production, wrap critical sections
in Firestore transactions via the Admin SDK.
"""

from __future__ import annotations

import base64
import logging
from datetime import datetime, timezone
from typing import Any

from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

from oi_agent.devices.firestore_client import get_firestore

logger = logging.getLogger(__name__)


async def list_user_devices(uid: str) -> list[dict[str, Any]]:
    """List devices via the denormalized users/{uid}/devices collection."""
    db = get_firestore()
    docs = await db.collection("users").document(uid).collection("devices").get()
    return [{"id": doc.id, **doc.to_dict()} for doc in docs]


async def get_device(device_id: str) -> dict[str, Any] | None:
    db = get_firestore()
    snap = await db.collection("devices").document(device_id).get()
    if not snap.exists:
        return None
    return {"id": snap.id, **snap.to_dict()}


async def revoke_device(device_id: str, uid: str) -> dict[str, Any]:
    """Block a device and revoke all its links and credentials."""
    db = get_firestore()
    device_ref = db.collection("devices").document(device_id)

    snap = await device_ref.get()
    if not snap.exists:
        raise ValueError("Device not found")

    link_ref = device_ref.collection("links").document(uid)
    link_snap = await link_ref.get()
    if not link_snap.exists or link_snap.to_dict().get("status") != "active":
        raise PermissionError("Not linked to this device")

    now_iso = datetime.now(timezone.utc).isoformat()

    await device_ref.update({"status": "blocked"})
    await link_ref.update({"status": "revoked", "revokedAt": now_iso})

    cred_docs = await device_ref.collection("credentials").get()
    for cd in cred_docs:
        if cd.to_dict().get("revokedAt") is None:
            await cd.reference.update({"revokedAt": now_iso})

    denorm_ref = db.collection("users").document(uid).collection("devices").document(device_id)
    try:
        await denorm_ref.update({"status": "blocked", "is_online": False})
    except Exception:
        pass

    device_data = snap.to_dict()
    device_data["status"] = "blocked"
    logger.info("Device %s revoked by user %s", device_id, uid)
    return {"id": device_id, **device_data}


async def rotate_key(
    device_id: str,
    uid: str,
    new_pubkey_b64: str,
    authorization_signature_b64: str,
) -> dict[str, Any]:
    """Rotate the Ed25519 key. Old key signs: new_pubkey_bytes || device_id."""
    db = get_firestore()
    device_ref = db.collection("devices").document(device_id)

    cred_query = (
        device_ref.collection("credentials")
        .order_by("keyVersion", direction="DESCENDING")
        .limit(10)
    )
    cred_docs = await cred_query.get()

    current_cred = None
    current_cred_ref = None
    for cd in cred_docs:
        d = cd.to_dict()
        if d.get("revokedAt") is None:
            current_cred = d
            current_cred_ref = cd.reference
            break

    if current_cred is None:
        raise ValueError("No active credential for this device")

    old_pubkey_bytes = base64.b64decode(current_cred["pubkeyEd25519"])
    new_pubkey_bytes = base64.b64decode(new_pubkey_b64)
    auth_sig_bytes = base64.b64decode(authorization_signature_b64)

    message = new_pubkey_bytes + device_id.encode()

    try:
        verify_key = VerifyKey(old_pubkey_bytes)
        verify_key.verify(message, auth_sig_bytes)
    except (BadSignatureError, Exception) as exc:
        raise ValueError(f"Key rotation authorization failed: {exc}") from exc

    now_iso = datetime.now(timezone.utc).isoformat()
    new_version = current_cred["keyVersion"] + 1

    await current_cred_ref.update({"revokedAt": now_iso})

    new_cred_ref = device_ref.collection("credentials").document(str(new_version))
    await new_cred_ref.set({
        "keyVersion": new_version,
        "pubkeyEd25519": new_pubkey_b64,
        "createdAt": now_iso,
        "revokedAt": None,
    })

    logger.info("Key rotated for device %s → version %d", device_id, new_version)
    return {"key_version": new_version, "device_id": device_id}


async def update_device_metadata(
    device_id: str,
    uid: str,
    *,
    display_name: str | None = None,
    os_version: str | None = None,
    app_version: str | None = None,
) -> dict[str, Any]:
    db = get_firestore()
    device_ref = db.collection("devices").document(device_id)

    snap = await device_ref.get()
    if not snap.exists:
        raise ValueError("Device not found")

    link_snap = await device_ref.collection("links").document(uid).get()
    if not link_snap.exists or link_snap.to_dict().get("status") != "active":
        raise PermissionError("Not linked to this device")

    updates: dict[str, Any] = {}
    denorm_updates: dict[str, Any] = {}

    if display_name is not None:
        updates["displayName"] = display_name
        denorm_updates["displayName"] = display_name
    if os_version is not None:
        updates["osVersion"] = os_version
    if app_version is not None:
        updates["appVersion"] = app_version

    if updates:
        await device_ref.update(updates)

    if denorm_updates:
        denorm_ref = db.collection("users").document(uid).collection("devices").document(device_id)
        try:
            await denorm_ref.update(denorm_updates)
        except Exception:
            pass

    device_data = (await device_ref.get()).to_dict()
    return {"id": device_id, **device_data}
