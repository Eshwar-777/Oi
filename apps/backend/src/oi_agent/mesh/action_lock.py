from __future__ import annotations

import logging
from typing import Any

from oi_agent.config import settings

logger = logging.getLogger(__name__)


class AlreadyHandledError(Exception):
    """Raised when another device has already responded to a blocked task."""

    pass


async def submit_human_action(
    task_id: str,
    action: str,
    device_id: str,
    user_id: str,
) -> None:
    """Submit a human action for a blocked task using a Firestore transaction.

    Only the first response wins. If another device already responded,
    raises AlreadyHandledError.
    """
    from google.cloud import firestore

    client = firestore.AsyncClient(
        project=settings.gcp_project,
        database=settings.firestore_database,
    )

    task_ref = client.collection("tasks").document(task_id)
    transaction = client.transaction()

    @firestore.async_transactional
    async def _transactional_update(
        transaction: Any,
        task_ref: Any,
    ) -> None:
        snapshot = await task_ref.get(transaction=transaction)

        if not snapshot.exists:
            raise ValueError(f"Task {task_id} not found")

        task_data = snapshot.to_dict()

        if task_data.get("status") != "blocked":
            raise AlreadyHandledError(
                f"Task {task_id} is no longer blocked (status: {task_data.get('status')})"
            )

        transaction.update(task_ref, {
            "status": "running",
            "human_action_response": action,
            "human_action_device_id": device_id,
            "human_action_user_id": user_id,
        })

    await _transactional_update(transaction, task_ref)

    logger.info(
        "Human action submitted: task=%s device=%s user=%s",
        task_id,
        device_id,
        user_id,
    )
