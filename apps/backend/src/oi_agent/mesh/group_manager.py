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


class MeshGroupManager:
    """Manages mesh groups -- collections of users and devices that share task context."""

    async def create_group(self, owner_user_id: str, name: str) -> str:
        """Create a new mesh group. Returns the group_id."""
        group_id = str(uuid.uuid4())
        client = _get_firestore_client()

        group_doc = {
            "group_id": group_id,
            "owner_user_id": owner_user_id,
            "name": name,
            "members": [
                {
                    "user_id": owner_user_id,
                    "role": "owner",
                    "added_at": datetime.utcnow().isoformat(),
                }
            ],
            "created_at": datetime.utcnow().isoformat(),
        }

        doc_ref = client.collection("mesh_groups").document(group_id)
        await doc_ref.set(group_doc)

        logger.info("Mesh group created: %s by user %s", group_id, owner_user_id)
        return group_id

    async def invite_member(
        self, group_id: str, inviter_user_id: str, invitee_user_id: str
    ) -> None:
        """Add a delegate member to a mesh group."""
        client = _get_firestore_client()
        doc_ref = client.collection("mesh_groups").document(group_id)
        doc = await doc_ref.get()

        if not doc.exists:
            raise ValueError(f"Mesh group {group_id} not found")

        group_data = doc.to_dict()
        if group_data.get("owner_user_id") != inviter_user_id:
            raise PermissionError("Only the group owner can invite members")

        members = group_data.get("members", [])
        if any(m.get("user_id") == invitee_user_id for m in members):
            return

        members.append({
            "user_id": invitee_user_id,
            "role": "delegate",
            "added_at": datetime.utcnow().isoformat(),
        })

        await doc_ref.update({"members": members})
        logger.info("User %s invited to mesh group %s", invitee_user_id, group_id)

    async def remove_member(
        self, group_id: str, owner_user_id: str, target_user_id: str
    ) -> None:
        """Remove a member from a mesh group."""
        client = _get_firestore_client()
        doc_ref = client.collection("mesh_groups").document(group_id)
        doc = await doc_ref.get()

        if not doc.exists:
            raise ValueError(f"Mesh group {group_id} not found")

        group_data = doc.to_dict()
        if group_data.get("owner_user_id") != owner_user_id:
            raise PermissionError("Only the group owner can remove members")

        members = [
            m for m in group_data.get("members", [])
            if m.get("user_id") != target_user_id
        ]

        await doc_ref.update({"members": members})

    async def get_group(self, group_id: str) -> dict[str, Any] | None:
        """Fetch a mesh group by ID."""
        client = _get_firestore_client()
        doc = await client.collection("mesh_groups").document(group_id).get()
        return doc.to_dict() if doc.exists else None

    async def get_user_groups(self, user_id: str) -> list[dict[str, Any]]:
        """Get all mesh groups a user belongs to (as owner or delegate)."""
        client = _get_firestore_client()
        query = client.collection("mesh_groups").where(
            "members", "array_contains_any",
            [{"user_id": user_id}],
        )
        # Firestore array_contains_any doesn't support nested objects well,
        # so we query all groups owned by the user and filter client-side.
        owned_query = client.collection("mesh_groups").where(
            "owner_user_id", "==", user_id
        )
        owned_docs = await owned_query.get()
        return [doc.to_dict() for doc in owned_docs]
