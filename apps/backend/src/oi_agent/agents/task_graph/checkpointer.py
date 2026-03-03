from __future__ import annotations

import json
import logging
from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver, Checkpoint, CheckpointMetadata

from oi_agent.config import settings

logger = logging.getLogger(__name__)


class FirestoreCheckpointer(BaseCheckpointSaver):
    """Persists LangGraph checkpoints to Firestore.

    Each task's graph state is stored as a document in the
    'graph_checkpoints' collection, keyed by thread_id (which maps to task_id).
    This allows the graph to pause (e.g. waiting for a scheduled trigger
    or human action) and resume hours or days later.
    """

    COLLECTION = "graph_checkpoints"

    def __init__(self) -> None:
        super().__init__()
        self._client: Any = None

    def _get_client(self) -> Any:
        if self._client is not None:
            return self._client
        try:
            from google.cloud import firestore

            self._client = firestore.Client(
                project=settings.gcp_project,
                database=settings.firestore_database,
            )
        except Exception as exc:
            raise RuntimeError(f"Firestore client init failed: {exc}") from exc
        return self._client

    def get(self, config: dict[str, Any]) -> Checkpoint | None:
        """Load a checkpoint from Firestore."""
        thread_id = config.get("configurable", {}).get("thread_id", "")
        if not thread_id:
            return None

        client = self._get_client()
        doc_ref = client.collection(self.COLLECTION).document(thread_id)
        doc = doc_ref.get()

        if not doc.exists:
            return None

        data = doc.to_dict()
        checkpoint_data = data.get("checkpoint")
        if checkpoint_data is None:
            return None

        if isinstance(checkpoint_data, str):
            return json.loads(checkpoint_data)
        return checkpoint_data

    def put(
        self,
        config: dict[str, Any],
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
    ) -> dict[str, Any]:
        """Save a checkpoint to Firestore."""
        thread_id = config.get("configurable", {}).get("thread_id", "")
        if not thread_id:
            return config

        client = self._get_client()
        doc_ref = client.collection(self.COLLECTION).document(thread_id)

        checkpoint_json = json.dumps(checkpoint, default=str)

        doc_ref.set({
            "thread_id": thread_id,
            "checkpoint": checkpoint_json,
            "metadata": json.dumps(metadata, default=str) if metadata else "{}",
        })

        logger.debug("Checkpoint saved for thread %s", thread_id)
        return config
