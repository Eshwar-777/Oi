from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import string
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from oi_agent.config import settings

logger = logging.getLogger(__name__)


def _parse_iso(value: str | None) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _get_firestore_client() -> Any:
    from google.cloud import firestore

    return firestore.AsyncClient(
        project=settings.gcp_project,
        database=settings.firestore_database,
    )


class DeviceRegistry:
    """Manages device registration and FCM tokens in Firestore."""

    async def register_device(
        self,
        user_id: str,
        device_type: str,
        device_name: str,
        fcm_token: str | None = None,
    ) -> str:
        """Register a new device for a user. Returns the device_id."""
        device_id = str(uuid.uuid4())
        client = _get_firestore_client()

        device_doc = {
            "device_id": device_id,
            "user_id": user_id,
            "device_type": device_type,
            "device_name": device_name,
            "fcm_token": fcm_token,
            "is_online": True,
            "last_seen": datetime.utcnow().isoformat(),
        }

        doc_ref = (
            client.collection("users")
            .document(user_id)
            .collection("devices")
            .document(device_id)
        )
        await doc_ref.set(device_doc)

        logger.info("Device registered: %s (%s) for user %s", device_id, device_type, user_id)
        return device_id

    async def link_device(
        self,
        *,
        user_id: str,
        device_id: str,
        device_type: str,
        device_name: str,
        fcm_token: str | None = None,
    ) -> str:
        """Link an authenticated app/device to a user across both device stores."""
        client = _get_firestore_client()
        now_iso = datetime.utcnow().isoformat()

        user_device_doc = {
            "device_id": device_id,
            "user_id": user_id,
            "device_type": device_type,
            "device_name": device_name,
            "fcm_token": fcm_token,
            "is_online": True,
            "last_seen": now_iso,
            "status": "active",
        }
        await (
            client.collection("users")
            .document(user_id)
            .collection("devices")
            .document(device_id)
            .set(user_device_doc, merge=True)
        )

        # Keep compatibility with websocket_auth linkage checks.
        await client.collection("devices").document(device_id).set(
            {
                "device_id": device_id,
                "user_id": user_id,
                "device_type": device_type,
                "device_name": device_name,
                "status": "active",
                "last_seen": now_iso,
            },
            merge=True,
        )
        await (
            client.collection("devices")
            .document(device_id)
            .collection("links")
            .document(user_id)
            .set(
                {
                    "status": "active",
                    "linked_at": now_iso,
                },
                merge=True,
            )
        )
        return device_id

    async def create_pairing_session(
        self,
        *,
        user_id: str,
        expires_in_seconds: int = 300,
    ) -> dict[str, Any]:
        client = _get_firestore_client()
        pairing_id = str(uuid.uuid4())
        code = "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(8))
        now = datetime.utcnow()
        expires_at = now + timedelta(seconds=max(60, min(expires_in_seconds, 900)))
        now_iso = now.isoformat()
        expires_iso = expires_at.isoformat()
        code_hash = hashlib.sha256(code.strip().upper().encode("utf-8")).hexdigest()

        await client.collection("device_pairing_sessions").document(pairing_id).set(
            {
                "pairing_id": pairing_id,
                "owner_user_id": user_id,
                "code_hash": code_hash,
                "status": "pending",
                "attempt_count": 0,
                "max_attempts": 6,
                "created_at": now_iso,
                "expires_at": expires_iso,
                "linked_device_id": None,
                "linked_device_name": None,
                "linked_device_type": None,
            }
        )

        return {
            "pairing_id": pairing_id,
            "code": code,
            "status": "pending",
            "created_at": now_iso,
            "expires_at": expires_iso,
        }

    async def get_pairing_session(
        self,
        *,
        pairing_id: str,
        owner_user_id: str,
    ) -> dict[str, Any] | None:
        client = _get_firestore_client()
        snap = await client.collection("device_pairing_sessions").document(pairing_id).get()
        if not snap.exists:
            return None
        data = snap.to_dict() or {}
        if data.get("owner_user_id") != owner_user_id:
            return None
        return data

    async def redeem_pairing_session(
        self,
        *,
        pairing_id: str,
        owner_user_id: str,
        code: str,
        device_type: str,
        device_name: str,
        device_id: str | None = None,
        fcm_token: str | None = None,
    ) -> dict[str, Any]:
        client = _get_firestore_client()
        doc_ref = client.collection("device_pairing_sessions").document(pairing_id)
        snap = await doc_ref.get()
        if not snap.exists:
            raise ValueError("Pairing session not found.")

        data = snap.to_dict() or {}
        if data.get("owner_user_id") != owner_user_id:
            raise PermissionError("Pairing session does not belong to this user.")

        if str(data.get("status", "")).lower() != "pending":
            raise ValueError("Pairing session is no longer pending.")

        now = datetime.utcnow()
        expires_at_raw = str(data.get("expires_at", "") or "")
        expires_at = datetime.fromisoformat(expires_at_raw) if expires_at_raw else now
        if now > expires_at:
            await doc_ref.update({"status": "expired"})
            raise ValueError("Pairing session expired.")

        attempts = int(data.get("attempt_count", 0) or 0)
        max_attempts = int(data.get("max_attempts", 6) or 6)
        if attempts >= max_attempts:
            await doc_ref.update({"status": "locked"})
            raise ValueError("Pairing session locked due to too many attempts.")

        provided_hash = hashlib.sha256(code.strip().upper().encode("utf-8")).hexdigest()
        stored_hash = str(data.get("code_hash", "") or "").strip().lower()
        if not stored_hash or not hmac.compare_digest(provided_hash.lower(), stored_hash):
            await doc_ref.update({"attempt_count": attempts + 1})
            raise ValueError("Invalid pairing code.")

        resolved_device_id = (device_id or "").strip() or str(uuid.uuid4())
        await self.link_device(
            user_id=owner_user_id,
            device_id=resolved_device_id,
            device_type=device_type,
            device_name=device_name,
            fcm_token=fcm_token,
        )

        now_iso = now.isoformat()
        await doc_ref.update(
            {
                "status": "linked",
                "linked_device_id": resolved_device_id,
                "linked_device_name": device_name,
                "linked_device_type": device_type,
                "linked_at": now_iso,
                "attempt_count": attempts + 1,
                "code_hash": None,
            }
        )

        return {
            "pairing_id": pairing_id,
            "status": "linked",
            "device_id": resolved_device_id,
            "device_name": device_name,
            "device_type": device_type,
            "linked_at": now_iso,
        }

    async def update_fcm_token(
        self, user_id: str, device_id: str, fcm_token: str
    ) -> None:
        """Update the FCM token for a device."""
        client = _get_firestore_client()
        doc_ref = (
            client.collection("users")
            .document(user_id)
            .collection("devices")
            .document(device_id)
        )
        await doc_ref.update({"fcm_token": fcm_token})

    async def update_device(
        self,
        user_id: str,
        device_id: str,
        *,
        device_name: str | None = None,
        fcm_token: str | None = None,
        is_online: bool | None = None,
    ) -> bool:
        """Update mutable device fields. Returns True if document exists and was updated."""
        client = _get_firestore_client()
        doc_ref = (
            client.collection("users")
            .document(user_id)
            .collection("devices")
            .document(device_id)
        )
        snap = await doc_ref.get()
        if not snap.exists:
            return False

        patch: dict[str, Any] = {}
        if device_name is not None:
            patch["device_name"] = device_name
        if fcm_token is not None:
            patch["fcm_token"] = fcm_token
        if is_online is not None:
            patch["is_online"] = is_online
        if patch:
            patch["last_seen"] = datetime.utcnow().isoformat()
            await doc_ref.update(patch)
        return True

    async def unregister_device(self, user_id: str, device_id: str) -> bool:
        """Delete a registered device. Returns True if it existed."""
        client = _get_firestore_client()
        doc_ref = (
            client.collection("users")
            .document(user_id)
            .collection("devices")
            .document(device_id)
        )
        snap = await doc_ref.get()
        if not snap.exists:
            return False
        await doc_ref.delete()
        return True

    async def mark_online(self, user_id: str, device_id: str) -> None:
        """Mark a device as online."""
        client = _get_firestore_client()
        doc_ref = (
            client.collection("users")
            .document(user_id)
            .collection("devices")
            .document(device_id)
        )
        await doc_ref.update({
            "is_online": True,
            "last_seen": datetime.utcnow().isoformat(),
        })

    async def mark_offline(self, user_id: str, device_id: str) -> None:
        """Mark a device as offline."""
        client = _get_firestore_client()
        doc_ref = (
            client.collection("users")
            .document(user_id)
            .collection("devices")
            .document(device_id)
        )
        await doc_ref.update({"is_online": False})

    async def get_user_devices(self, user_id: str) -> list[dict[str, Any]]:
        """Get all devices for a user."""
        client = _get_firestore_client()
        devices_ref = (
            client.collection("users")
            .document(user_id)
            .collection("devices")
        )
        docs = await devices_ref.get()
        return [doc.to_dict() for doc in docs]

    def is_device_stale(self, device: dict[str, Any]) -> bool:
        if not bool(device.get("is_online")):
            return True
        last_seen = _parse_iso(str(device.get("last_seen", "") or ""))
        if last_seen is None:
            return True
        age_seconds = (datetime.now(UTC) - last_seen).total_seconds()
        return age_seconds > settings.device_presence_stale_seconds

    def normalize_device_presence(
        self,
        device: dict[str, Any],
        *,
        connected: bool = False,
    ) -> dict[str, Any]:
        row = dict(device)
        row["connected"] = connected
        if connected:
            row["is_online"] = True
            return row
        row["is_online"] = not self.is_device_stale(row)
        return row

    async def get_mesh_group_devices(self, group_id: str) -> list[dict[str, Any]]:
        """Get all devices across all members of a mesh group."""
        client = _get_firestore_client()
        group_doc = await client.collection("mesh_groups").document(group_id).get()

        if not group_doc.exists:
            return []

        group_data = group_doc.to_dict()
        members = group_data.get("members", [])

        all_devices: list[dict[str, Any]] = []
        for member in members:
            member_user_id = member.get("user_id")
            if member_user_id:
                devices = await self.get_user_devices(member_user_id)
                all_devices.extend(devices)

        return all_devices
