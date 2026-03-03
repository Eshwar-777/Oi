"""Device Proof-of-Possession (PoP) authentication — Firestore + Firebase Auth.

Protected routes require BOTH a Firebase ID token and device PoP headers:
  Authorization: Bearer <Firebase ID token>
  X-Device-Id: <uuid>
  X-Device-Nonce: <random_base64>
  X-Device-Timestamp: <ISO-8601>
  X-Device-Signature: <base64>

Updated signature payload (uid-bound):
  sig = Sign( nonce || timestamp || method || path || body_sha256 || device_id || uid )
"""

from __future__ import annotations

import base64
import hashlib
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import Depends, HTTPException, Request

from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.config import settings
from oi_agent.devices.firestore_client import get_firestore

logger = logging.getLogger(__name__)

TIMESTAMP_SKEW = timedelta(minutes=5)


async def get_current_device_user(
    request: Request,
    user: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """FastAPI dependency: validates Firebase Auth + device PoP headers.

    Returns dict with uid, device_id, device (Firestore document dict).
    """
    uid = user["uid"]

    device_id = request.headers.get("X-Device-Id")
    nonce_b64 = request.headers.get("X-Device-Nonce")
    timestamp_str = request.headers.get("X-Device-Timestamp")
    signature_b64 = request.headers.get("X-Device-Signature")

    if not all([device_id, nonce_b64, timestamp_str, signature_b64]):
        raise HTTPException(status_code=401, detail="Missing device PoP headers (X-Device-Id, X-Device-Nonce, X-Device-Timestamp, X-Device-Signature)")

    # Timestamp skew check
    try:
        ts = datetime.fromisoformat(timestamp_str)  # type: ignore[arg-type]
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        if abs(now - ts) > TIMESTAMP_SKEW:
            raise HTTPException(status_code=401, detail="Timestamp skew too large")
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=401, detail=f"Invalid timestamp: {exc}") from exc

    db = get_firestore()

    # 1. Verify device exists + active
    device_snap = await db.collection("devices").document(device_id).get()
    if not device_snap.exists:
        raise HTTPException(status_code=403, detail="Device not found")
    device_data = device_snap.to_dict()
    if device_data.get("status") != "active":
        raise HTTPException(status_code=403, detail="Device not active")

    # 2. Verify device linked to this user
    link_snap = await (
        db.collection("devices").document(device_id)
        .collection("links").document(uid).get()
    )
    if not link_snap.exists or link_snap.to_dict().get("status") != "active":
        raise HTTPException(status_code=403, detail="Device not linked to user")

    # 3. Get latest non-revoked credential
    creds_query = (
        db.collection("devices").document(device_id)
        .collection("credentials")
        .order_by("keyVersion", direction="DESCENDING")
        .limit(10)
    )
    cred_docs = await creds_query.get()

    pubkey_b64_found: str | None = None
    for cred_doc in cred_docs:
        cd = cred_doc.to_dict()
        if cd.get("revokedAt") is None:
            pubkey_b64_found = cd.get("pubkeyEd25519")
            break

    if pubkey_b64_found is None:
        raise HTTPException(status_code=403, detail="No active device credential")

    # 4. Check nonce replay
    nonce_hash = hashlib.sha256(base64.b64decode(nonce_b64)).hexdigest()
    nonce_ref = db.collection("device_nonces").document(nonce_hash)
    nonce_snap = await nonce_ref.get()
    if nonce_snap.exists:
        raise HTTPException(status_code=401, detail="Nonce already used")

    # 5. Verify signature: nonce || timestamp || method || path || body_sha256 || device_id || uid
    body_bytes = await request.body()
    body_sha256 = hashlib.sha256(body_bytes).digest()

    message = (
        base64.b64decode(nonce_b64)
        + timestamp_str.encode()  # type: ignore[union-attr]
        + request.method.encode()
        + str(request.url.path).encode()
        + body_sha256
        + device_id.encode()  # type: ignore[union-attr]
        + uid.encode()
    )

    try:
        from nacl.signing import VerifyKey

        pubkey_bytes = base64.b64decode(pubkey_b64_found)
        verify_key = VerifyKey(pubkey_bytes)
        verify_key.verify(message, base64.b64decode(signature_b64))
    except Exception as exc:
        raise HTTPException(status_code=401, detail=f"PoP signature invalid: {exc}") from exc

    # 6. Store nonce
    nonce_expires = datetime.now(timezone.utc) + timedelta(seconds=settings.nonce_ttl_seconds)
    await nonce_ref.set({
        "deviceId": device_id,
        "uid": uid,
        "expiresAt": nonce_expires.isoformat(),
    })

    # 7. Touch lastSeenAt
    await db.collection("devices").document(device_id).update({"lastSeenAt": datetime.now(timezone.utc).isoformat()})

    return {"uid": uid, "device_id": device_id, "device": device_data}
