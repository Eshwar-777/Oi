from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Any

from oi_agent.config import settings

logger = logging.getLogger(__name__)


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
