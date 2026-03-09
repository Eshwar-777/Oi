from __future__ import annotations

import asyncio
import hashlib
import hmac
import secrets
import string
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import HTTPException

from oi_agent.config import settings
from oi_agent.devices.firestore_client import get_firestore

_memory_handoffs: dict[str, dict[str, Any]] = {}
_memory_lock = asyncio.Lock()


def _now() -> datetime:
    return datetime.now(UTC)


def _now_iso() -> str:
    return _now().isoformat()


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.strip().upper().encode("utf-8")).hexdigest()


def _doc_ref(handoff_id: str) -> Any:
    db = get_firestore()
    return db.collection("auth_handoffs").document(handoff_id)


async def create_auth_handoff(*, user_id: str, email: str, expires_in_seconds: int = 300) -> dict[str, Any]:
    handoff_id = str(uuid.uuid4())
    code = "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(8))
    expires_at = _now() + timedelta(seconds=max(60, min(expires_in_seconds, 900)))
    record = {
        "handoff_id": handoff_id,
        "owner_user_id": user_id,
        "owner_email": email,
        "code_hash": _hash_code(code),
        "status": "pending",
        "created_at": _now_iso(),
        "expires_at": expires_at.isoformat(),
        "consumed_at": None,
    }

    try:
        if settings.gcp_project or settings.firebase_project_id:
            await _doc_ref(handoff_id).set(record, merge=True)
        else:
            raise RuntimeError("Firestore not configured")
    except Exception:
        async with _memory_lock:
            _memory_handoffs[handoff_id] = dict(record)

    return {
        "handoff_id": handoff_id,
        "code": code,
        "created_at": record["created_at"],
        "expires_at": record["expires_at"],
        "status": "pending",
    }


async def redeem_auth_handoff(*, handoff_id: str, code: str) -> dict[str, str]:
    record: dict[str, Any] | None = None
    ref = None
    try:
        if settings.gcp_project or settings.firebase_project_id:
            ref = _doc_ref(handoff_id)
            snap = await ref.get()
            if snap.exists:
                payload = snap.to_dict()
                if isinstance(payload, dict):
                    record = payload
    except Exception:
        record = None

    if record is None:
        async with _memory_lock:
            cached = _memory_handoffs.get(handoff_id)
            record = dict(cached) if cached else None

    if not record:
        raise HTTPException(status_code=404, detail="Auth handoff not found.")

    if str(record.get("status", "")).lower() != "pending":
        raise HTTPException(status_code=400, detail="Auth handoff is no longer pending.")

    expires_at_raw = str(record.get("expires_at", "") or "")
    expires_at = datetime.fromisoformat(expires_at_raw) if expires_at_raw else _now()
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    if _now() > expires_at:
        raise HTTPException(status_code=400, detail="Auth handoff expired.")

    provided_hash = _hash_code(code)
    stored_hash = str(record.get("code_hash", "") or "")
    if not stored_hash or not hmac.compare_digest(provided_hash, stored_hash):
        raise HTTPException(status_code=400, detail="Invalid auth handoff code.")

    patch = {"status": "consumed", "consumed_at": _now_iso(), "code_hash": None}
    try:
        if ref is not None:
            await ref.set(patch, merge=True)
        else:
            raise RuntimeError("No firestore ref")
    except Exception:
        async with _memory_lock:
            current = _memory_handoffs.get(handoff_id)
            if current:
                current.update(patch)
                _memory_handoffs[handoff_id] = current

    return {
        "uid": str(record.get("owner_user_id", "") or ""),
        "email": str(record.get("owner_email", "") or ""),
    }
