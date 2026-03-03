from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from oi_agent.config import settings
from oi_agent.memory.models import ChatMessage, Conversation, TaskDocument, TaskEvent

logger = logging.getLogger(__name__)

_firestore_client: Any = None


def _get_firestore_client() -> Any:
    """Lazy-init the Firestore client."""
    global _firestore_client
    if _firestore_client is not None:
        return _firestore_client

    try:
        from google.cloud import firestore

        _firestore_client = firestore.AsyncClient(
            project=settings.gcp_project,
            database=settings.firestore_database,
        )
    except Exception as exc:
        logger.error("Failed to create Firestore client: %s", exc)
        raise RuntimeError("Firestore is not available") from exc

    return _firestore_client


class FirestoreSessionStore:
    """Conversation session persistence backed by Firestore."""

    COLLECTION = "conversations"

    async def get_or_create_conversation(
        self, user_id: str, session_id: str
    ) -> Conversation:
        client = _get_firestore_client()
        doc_ref = client.collection(self.COLLECTION).document(session_id)
        doc = await doc_ref.get()

        if doc.exists:
            data = doc.to_dict()
            return Conversation(**data)

        conversation = Conversation(session_id=session_id, user_id=user_id)
        await doc_ref.set(conversation.model_dump(mode="json"))
        return conversation

    async def append_message(
        self, session_id: str, role: str, content: str
    ) -> None:
        client = _get_firestore_client()
        doc_ref = client.collection(self.COLLECTION).document(session_id)

        message = ChatMessage(role=role, content=content)
        from google.cloud.firestore import async_transactional, ArrayUnion

        await doc_ref.update({
            "messages": ArrayUnion([message.model_dump(mode="json")]),
            "updated_at": datetime.utcnow().isoformat(),
        })

    async def get_messages(self, session_id: str) -> list[ChatMessage]:
        client = _get_firestore_client()
        doc_ref = client.collection(self.COLLECTION).document(session_id)
        doc = await doc_ref.get()

        if not doc.exists:
            return []

        data = doc.to_dict()
        return [ChatMessage(**m) for m in data.get("messages", [])]


class FirestoreTaskStore:
    """Task persistence backed by Firestore."""

    COLLECTION = "tasks"

    async def create_task(self, task: TaskDocument) -> str:
        client = _get_firestore_client()
        doc_ref = client.collection(self.COLLECTION).document(task.task_id)
        await doc_ref.set(task.model_dump(mode="json"))
        return task.task_id

    async def get_task(self, task_id: str) -> TaskDocument | None:
        client = _get_firestore_client()
        doc_ref = client.collection(self.COLLECTION).document(task_id)
        doc = await doc_ref.get()

        if not doc.exists:
            return None
        return TaskDocument(**doc.to_dict())

    async def update_task(self, task_id: str, updates: dict[str, Any]) -> None:
        client = _get_firestore_client()
        doc_ref = client.collection(self.COLLECTION).document(task_id)
        updates["updated_at"] = datetime.utcnow().isoformat()
        await doc_ref.update(updates)

    async def add_task_event(self, task_id: str, event: TaskEvent) -> None:
        client = _get_firestore_client()
        events_ref = (
            client.collection(self.COLLECTION)
            .document(task_id)
            .collection("events")
        )
        await events_ref.add(event.model_dump(mode="json"))

    async def list_user_tasks(self, user_id: str) -> list[TaskDocument]:
        client = _get_firestore_client()
        try:
            query = (
                client.collection(self.COLLECTION)
                .where("created_by_user_id", "==", user_id)
                .limit(50)
            )
            docs = await query.get()
            tasks = [TaskDocument(**doc.to_dict()) for doc in docs]
            tasks.sort(key=lambda t: t.created_at, reverse=True)
            return tasks
        except Exception as exc:
            logger.warning("Firestore list_user_tasks failed: %s", exc)
            return []
