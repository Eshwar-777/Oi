from __future__ import annotations

import asyncio
import copy
import json
import logging
import tempfile
from pathlib import Path
from typing import Any

from google.cloud.firestore_v1.base_query import FieldFilter

from oi_agent.config import settings
from oi_agent.devices.firestore_client import get_firestore

logger = logging.getLogger(__name__)

_FIRESTORE_TIMEOUT_SECONDS = max(1, min(settings.request_timeout_seconds, 5))

_lock = asyncio.Lock()
_intents: dict[str, dict[str, Any]] = {}
_plans: dict[str, dict[str, Any]] = {}
_runs: dict[str, dict[str, Any]] = {}
_run_artifacts: dict[str, list[dict[str, Any]]] = {}
_events: list[dict[str, Any]] = []
_session_turns: dict[str, list[dict[str, Any]]] = {}
_prepared_turns: dict[str, dict[str, Any]] = {}
_browser_sessions: dict[str, dict[str, Any]] = {}
_run_transitions: dict[str, list[dict[str, Any]]] = {}
_session_control_audit: dict[str, list[dict[str, Any]]] = {}
_notification_preferences: dict[str, dict[str, Any]] = {}
_conversation_tasks: dict[str, dict[str, Any]] = {}
_conversations: dict[str, dict[str, Any]] = {}

_COLLECTIONS = {
    "intents": "automation_intents",
    "plans": "automation_plans",
    "runs": "automation_runs",
    "artifacts": "automation_artifacts",
    "events": "automation_events",
    "session_turns": "automation_session_turns",
    "prepared_turns": "automation_prepared_turns",
    "browser_sessions": "automation_browser_sessions",
    "run_transitions": "automation_run_transitions",
    "session_control_audit": "automation_session_control_audit",
    "notification_preferences": "automation_notification_preferences",
    "conversation_tasks": "automation_conversation_tasks",
    "conversations": "automation_conversations",
}

_LOCAL_STORE_PATH = (
    Path(tempfile.gettempdir()) / f"{settings.app_name}-automation-store-{settings.env}.json"
)
_local_documents: dict[str, dict[str, dict[str, Any]]] = {
    kind: {} for kind in _COLLECTIONS
}
_local_documents_loaded = False
_local_store_dirty = False
_local_persist_task: asyncio.Task[None] | None = None


def _use_firestore() -> bool:
    if settings.env == "dev" and not settings.automation_store_use_firestore_in_dev:
        return False
    return bool(settings.gcp_project or settings.firebase_project_id)


def _db() -> Any:
    if not _use_firestore():
        raise RuntimeError("Firestore not configured for automation store")
    return get_firestore()


def _use_local_store() -> bool:
    return not _use_firestore()


def _local_store_payload() -> dict[str, dict[str, dict[str, Any]]]:
    return {
        kind: {doc_id: copy.deepcopy(doc) for doc_id, doc in docs.items()}
        for kind, docs in _local_documents.items()
    }


def _persist_local_store_unlocked() -> None:
    _LOCAL_STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _LOCAL_STORE_PATH.write_text(
        json.dumps(_local_store_payload(), separators=(",", ":")),
        encoding="utf-8",
    )


async def _flush_local_store_after_delay(delay_seconds: float = 0.25) -> None:
    global _local_store_dirty, _local_persist_task
    try:
        await asyncio.sleep(delay_seconds)
        async with _lock:
            if not _local_store_dirty:
                return
            _persist_local_store_unlocked()
            _local_store_dirty = False
    finally:
        _local_persist_task = None


def _schedule_local_store_persist_unlocked() -> None:
    global _local_store_dirty, _local_persist_task
    _local_store_dirty = True
    if _local_persist_task is None or _local_persist_task.done():
        _local_persist_task = asyncio.create_task(_flush_local_store_after_delay())


async def _ensure_local_store_loaded() -> None:
    global _local_documents_loaded
    if not _use_local_store() or _local_documents_loaded:
        return
    async with _lock:
        if _local_documents_loaded:
            return
        for kind in _COLLECTIONS:
            _local_documents[kind] = {}
        if _LOCAL_STORE_PATH.exists():
            try:
                payload = json.loads(_LOCAL_STORE_PATH.read_text(encoding="utf-8"))
            except Exception:
                logger.warning(
                    "automation_store_local_load_failed",
                    extra={"path": str(_LOCAL_STORE_PATH)},
                )
            else:
                if isinstance(payload, dict):
                    for kind in _COLLECTIONS:
                        docs = payload.get(kind, {})
                        if isinstance(docs, dict):
                            _local_documents[kind] = {
                                str(doc_id): copy.deepcopy(doc)
                                for doc_id, doc in docs.items()
                                if isinstance(doc, dict)
                            }
        _local_documents_loaded = True


def _doc_ref(db: Any, kind: str, doc_id: str) -> Any:
    return db.collection(_COLLECTIONS[kind]).document(doc_id)


async def _firestore_wait(kind: str, operation: str, awaitable: Any) -> Any:
    try:
        return await asyncio.wait_for(awaitable, timeout=_FIRESTORE_TIMEOUT_SECONDS)
    except TimeoutError:
        logger.warning(
            "Automation store %s timeout kind=%s after %ss",
            operation,
            kind,
            _FIRESTORE_TIMEOUT_SECONDS,
        )
        raise


async def _save_document(kind: str, doc_id: str, payload: dict[str, Any]) -> bool:
    if _use_local_store():
        await _ensure_local_store_loaded()
        async with _lock:
            _local_documents[kind][doc_id] = copy.deepcopy(payload)
            _schedule_local_store_persist_unlocked()
        return True
    try:
        db = _db()
        await _firestore_wait(
            kind,
            "save",
            _doc_ref(db, kind, doc_id).set(dict(payload), merge=True),
        )
        return True
    except Exception as exc:
        logger.warning("Automation store save fallback kind=%s: %s", kind, exc)
        return False


async def _get_document(kind: str, doc_id: str) -> dict[str, Any] | None:
    if _use_local_store():
        await _ensure_local_store_loaded()
        async with _lock:
            row = _local_documents[kind].get(doc_id)
            return copy.deepcopy(row) if row is not None else None
    try:
        db = _db()
        snap = await _firestore_wait(kind, "get", _doc_ref(db, kind, doc_id).get())
        if snap.exists:
            row = snap.to_dict()
            return row if isinstance(row, dict) else None
    except Exception as exc:
        logger.warning("Automation store get fallback kind=%s: %s", kind, exc)
        pass
    return None


async def _delete_document(kind: str, doc_id: str) -> None:
    if _use_local_store():
        await _ensure_local_store_loaded()
        async with _lock:
            _local_documents[kind].pop(doc_id, None)
            _schedule_local_store_persist_unlocked()
        return
    try:
        db = _db()
        await _firestore_wait(kind, "delete", _doc_ref(db, kind, doc_id).delete())
    except Exception as exc:
        logger.warning("Automation store delete fallback kind=%s: %s", kind, exc)
        pass


async def _query_documents(kind: str, filters: dict[str, Any], order_field: str = "", limit: int = 100) -> list[dict[str, Any]]:
    if _use_local_store():
        await _ensure_local_store_loaded()
        async with _lock:
            rows = [copy.deepcopy(row) for row in _local_documents[kind].values()]
        filtered: list[dict[str, Any]] = []
        for row in rows:
            if all(row.get(key) == value for key, value in filters.items()):
                filtered.append(row)
        if order_field:
            filtered.sort(key=lambda row: str(row.get(order_field, "")))
        return filtered[:limit]
    try:
        db = _db()
        query = db.collection(_COLLECTIONS[kind])
        for key, value in filters.items():
            query = query.where(filter=FieldFilter(key, "==", value))
        if order_field:
            query = query.order_by(order_field)
        query = query.limit(limit)
        docs = await _firestore_wait(kind, "query", query.get())
        rows = [doc.to_dict() for doc in docs]
        return [row for row in rows if isinstance(row, dict)]
    except Exception as exc:
        logger.warning("Automation store query fallback kind=%s: %s", kind, exc)
        return []


async def save_intent(intent_id: str, payload: dict[str, Any]) -> None:
    if await _save_document("intents", intent_id, payload):
        return
    async with _lock:
        _intents[intent_id] = dict(payload)


async def get_intent(intent_id: str) -> dict[str, Any] | None:
    row = await _get_document("intents", intent_id)
    if row:
        return row
    async with _lock:
        cached = _intents.get(intent_id)
        return dict(cached) if cached else None


async def find_latest_intent_for_session(user_id: str, session_id: str) -> dict[str, Any] | None:
    rows = await _query_documents("intents", {"user_id": user_id, "session_id": session_id}, order_field="_saved_at", limit=50)
    if rows:
        rows.sort(key=lambda row: str(row.get("_saved_at", "")), reverse=True)
        return rows[0]
    async with _lock:
        matching = [
            dict(row)
            for row in _intents.values()
            if row.get("user_id") == user_id and row.get("session_id") == session_id
        ]
    matching.sort(key=lambda row: str(row.get("_saved_at", "")), reverse=True)
    return matching[0] if matching else None


async def save_session_turn(session_id: str, turn_id: str, payload: dict[str, Any]) -> None:
    if await _save_document("session_turns", turn_id, payload):
        return
    async with _lock:
        rows = _session_turns.setdefault(session_id, [])
        rows.append(dict(payload))


async def list_session_turns(user_id: str, session_id: str, limit: int = 12) -> list[dict[str, Any]]:
    rows = await _query_documents("session_turns", {"user_id": user_id, "session_id": session_id}, order_field="timestamp", limit=limit)
    if rows:
        return rows[-limit:]
    async with _lock:
        data = [
            dict(item)
            for item in _session_turns.get(session_id, [])
            if item.get("user_id") == user_id
        ]
    data.sort(key=lambda row: str(row.get("timestamp", "")))
    return data[-limit:]


async def save_prepared_turn(token: str, payload: dict[str, Any]) -> None:
    if await _save_document("prepared_turns", token, payload):
        return
    async with _lock:
        _prepared_turns[token] = dict(payload)


async def get_prepared_turn(token: str) -> dict[str, Any] | None:
    row = await _get_document("prepared_turns", token)
    if row:
        return row
    async with _lock:
        cached = _prepared_turns.get(token)
        return dict(cached) if cached else None


async def save_conversation_task(task_id: str, payload: dict[str, Any]) -> None:
    if await _save_document("conversation_tasks", task_id, payload):
        return
    async with _lock:
        _conversation_tasks[task_id] = dict(payload)


async def get_conversation_task(task_id: str) -> dict[str, Any] | None:
    row = await _get_document("conversation_tasks", task_id)
    if row:
        return row
    async with _lock:
        cached = _conversation_tasks.get(task_id)
        return dict(cached) if cached else None


async def find_conversation_task_for_session(user_id: str, session_id: str) -> dict[str, Any] | None:
    rows = await _query_documents(
        "conversation_tasks",
        {"user_id": user_id, "session_id": session_id},
        order_field="updated_at",
        limit=20,
    )
    if rows:
        rows.sort(key=lambda row: str(row.get("updated_at", "")), reverse=True)
        return rows[0]
    async with _lock:
        matching = [
            dict(row)
            for row in _conversation_tasks.values()
            if row.get("user_id") == user_id and row.get("session_id") == session_id
        ]
    matching.sort(key=lambda row: str(row.get("updated_at", "")), reverse=True)
    return matching[0] if matching else None


async def find_conversation_task_for_conversation(user_id: str, conversation_id: str) -> dict[str, Any] | None:
    rows = await _query_documents(
        "conversation_tasks",
        {"user_id": user_id, "conversation_id": conversation_id},
        order_field="updated_at",
        limit=20,
    )
    if rows:
        rows.sort(key=lambda row: str(row.get("updated_at", "")), reverse=True)
        return rows[0]
    async with _lock:
        matching = [
            dict(row)
            for row in _conversation_tasks.values()
            if row.get("user_id") == user_id and row.get("conversation_id") == conversation_id
        ]
    matching.sort(key=lambda row: str(row.get("updated_at", "")), reverse=True)
    return matching[0] if matching else None


async def save_conversation(conversation_id: str, payload: dict[str, Any]) -> None:
    if await _save_document("conversations", conversation_id, payload):
        return
    async with _lock:
        _conversations[conversation_id] = dict(payload)


async def get_conversation(conversation_id: str) -> dict[str, Any] | None:
    row = await _get_document("conversations", conversation_id)
    if row:
        return row
    async with _lock:
        cached = _conversations.get(conversation_id)
        return dict(cached) if cached else None


async def list_conversations_for_user(user_id: str, limit: int = 100) -> list[dict[str, Any]]:
    rows = await _query_documents("conversations", {"user_id": user_id}, order_field="updated_at", limit=limit)
    if rows:
        rows.sort(key=lambda row: str(row.get("updated_at", "")), reverse=True)
        return rows[:limit]
    async with _lock:
        data = [dict(item) for item in _conversations.values() if item.get("user_id") == user_id]
    data.sort(key=lambda row: str(row.get("updated_at", "")), reverse=True)
    return data[:limit]


async def update_conversation(conversation_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    existing = await get_conversation(conversation_id)
    if existing is None:
        return None
    existing.update(patch)
    await save_conversation(conversation_id, existing)
    return existing


async def save_plan(plan_id: str, payload: dict[str, Any]) -> None:
    if await _save_document("plans", plan_id, payload):
        return
    async with _lock:
        _plans[plan_id] = dict(payload)


async def get_plan(plan_id: str) -> dict[str, Any] | None:
    row = await _get_document("plans", plan_id)
    if row:
        return row
    async with _lock:
        cached = _plans.get(plan_id)
        return dict(cached) if cached else None


async def save_run(run_id: str, payload: dict[str, Any]) -> None:
    if await _save_document("runs", run_id, payload):
        return
    async with _lock:
        _runs[run_id] = dict(payload)


async def get_run(run_id: str) -> dict[str, Any] | None:
    row = await _get_document("runs", run_id)
    if row:
        return row
    async with _lock:
        cached = _runs.get(run_id)
        return dict(cached) if cached else None


async def find_run_by_intent(session_id: str, intent_id: str) -> dict[str, Any] | None:
    rows = await _query_documents("runs", {"session_id": session_id}, limit=200)
    if rows:
        for row in rows:
            plan_id = str(row.get("plan_id", "") or "")
            plan_row = await get_plan(plan_id)
            if plan_row and plan_row.get("intent_id") == intent_id:
                return row
    async with _lock:
        for row in _runs.values():
            if row.get("session_id") != session_id:
                continue
            plan_row = _plans.get(str(row.get("plan_id", "")), {})
            if plan_row.get("intent_id") == intent_id:
                return dict(row)
        return None


async def list_runs_for_session(user_id: str, session_id: str, limit: int = 50) -> list[dict[str, Any]]:
    rows = await _query_documents("runs", {"user_id": user_id, "session_id": session_id}, order_field="created_at", limit=limit)
    if rows:
        rows.sort(key=lambda row: str(row.get("created_at", "")), reverse=True)
        return rows[:limit]
    async with _lock:
        data = [
            dict(item)
            for item in _runs.values()
            if item.get("user_id") == user_id and item.get("session_id") == session_id
        ]
    data.sort(key=lambda row: str(row.get("created_at", "")), reverse=True)
    return data[:limit]


async def list_runs_for_user(user_id: str, limit: int = 50) -> list[dict[str, Any]]:
    rows = await _query_documents("runs", {"user_id": user_id}, order_field="created_at", limit=limit)
    if rows:
        rows.sort(key=lambda row: str(row.get("created_at", "")), reverse=True)
        return rows[:limit]
    async with _lock:
        data = [dict(item) for item in _runs.values() if item.get("user_id") == user_id]
    data.sort(key=lambda row: str(row.get("created_at", "")), reverse=True)
    return data[:limit]


async def update_run(run_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    existing = await get_run(run_id)
    if existing is None:
        return None
    existing.update(patch)
    await save_run(run_id, existing)
    return existing


async def delete_run_records(run_id: str) -> None:
    await _delete_document("runs", run_id)
    await _delete_document("artifacts", run_id)

    transition_rows = await _query_documents("run_transitions", {"run_id": run_id}, order_field="created_at", limit=500)
    for row in transition_rows:
        transition_id = str(row.get("transition_id", "") or "")
        if transition_id:
            await _delete_document("run_transitions", transition_id)

    event_rows = await _query_documents("events", {"run_id": run_id}, order_field="timestamp", limit=1000)
    for row in event_rows:
        event_id = str(row.get("event_id", "") or "")
        if event_id:
            await _delete_document("events", event_id)

    async with _lock:
        _runs.pop(run_id, None)
        _run_artifacts.pop(run_id, None)
        _run_transitions.pop(run_id, None)
        _events[:] = [row for row in _events if str(row.get("run_id", "") or "") != run_id]


async def list_runs_for_browser_session(browser_session_id: str, limit: int = 50) -> list[dict[str, Any]]:
    rows = await _query_documents("runs", {"browser_session_id": browser_session_id}, order_field="created_at", limit=limit)
    if rows:
        rows.sort(key=lambda row: str(row.get("created_at", "")), reverse=True)
        return rows[:limit]
    async with _lock:
        data = [
            dict(row)
            for row in _runs.values()
            if row.get("browser_session_id") == browser_session_id
        ]
    data.sort(key=lambda row: str(row.get("created_at", "")), reverse=True)
    return data[:limit]


async def list_runs(limit: int = 500) -> list[dict[str, Any]]:
    rows = await _query_documents("runs", {}, order_field="created_at", limit=limit)
    if rows:
        rows.sort(key=lambda row: str(row.get("created_at", "")), reverse=True)
        return rows[:limit]
    async with _lock:
        data = [dict(row) for row in _runs.values()]
    data.sort(key=lambda row: str(row.get("created_at", "")), reverse=True)
    return data[:limit]


async def save_session_control_audit(audit_id: str, payload: dict[str, Any]) -> None:
    if await _save_document("session_control_audit", audit_id, payload):
        return
    async with _lock:
        session_id = str(payload.get("session_id", "") or "")
        rows = _session_control_audit.setdefault(session_id, [])
        rows.append(dict(payload))


async def list_session_control_audit(session_id: str, limit: int = 200) -> list[dict[str, Any]]:
    rows = await _query_documents("session_control_audit", {"session_id": session_id}, order_field="created_at", limit=limit)
    if rows:
        rows.sort(key=lambda row: str(row.get("created_at", "")), reverse=True)
        return rows[:limit]
    async with _lock:
        data = [dict(item) for item in _session_control_audit.get(session_id, [])]
    data.sort(key=lambda row: str(row.get("created_at", "")), reverse=True)
    return data[:limit]


async def save_artifacts(run_id: str, payload: list[dict[str, Any]]) -> None:
    doc = {"run_id": run_id, "items": [dict(item) for item in payload]}
    if await _save_document("artifacts", run_id, doc):
        return
    async with _lock:
        _run_artifacts[run_id] = [dict(item) for item in payload]


async def get_artifacts(run_id: str) -> list[dict[str, Any]]:
    row = await _get_document("artifacts", run_id)
    if row:
        items = row.get("items", [])
        if isinstance(items, list):
            return [dict(item) for item in items if isinstance(item, dict)]
    async with _lock:
        return [dict(item) for item in _run_artifacts.get(run_id, [])]


async def save_event(event_id: str, payload: dict[str, Any]) -> None:
    if await _save_document("events", event_id, payload):
        return
    async with _lock:
        _events.append(dict(payload))


async def list_events(
    *,
    user_id: str,
    session_id: str | None = None,
    run_id: str | None = None,
    limit: int = 500,
) -> list[dict[str, Any]]:
    filters: dict[str, Any] = {"user_id": user_id}
    if session_id:
        filters["session_id"] = session_id
    if run_id:
        filters["run_id"] = run_id
    rows = await _query_documents("events", filters, order_field="timestamp", limit=limit)
    if rows:
        return rows
    async with _lock:
        data = list(_events)
    out: list[dict[str, Any]] = []
    for row in data:
        if session_id and row.get("session_id") != session_id:
            continue
        if run_id and row.get("run_id") != run_id:
            continue
        out.append(dict(row))
    out.sort(key=lambda row: str(row.get("timestamp", "")))
    return out[-limit:]


async def get_event(event_id: str) -> dict[str, Any] | None:
    row = await _get_document("events", event_id)
    if row:
        return row
    async with _lock:
        for event in _events:
            if str(event.get("event_id", "") or "") == event_id:
                return dict(event)
    return None


async def list_events_since(
    *,
    after_timestamp: str,
    session_id: str | None = None,
    run_id: str | None = None,
    limit: int = 500,
) -> list[dict[str, Any]]:
    filters: dict[str, Any] = {}
    if session_id:
        filters["session_id"] = session_id
    if run_id:
        filters["run_id"] = run_id
    try:
        db = _db()
        query = db.collection(_COLLECTIONS["events"]).where(
            filter=FieldFilter("timestamp", ">=", after_timestamp)
        )
        for key, value in filters.items():
            query = query.where(filter=FieldFilter(key, "==", value))
        query = query.order_by("timestamp").limit(limit)
        docs = await _firestore_wait("events", "query_since", query.get())
        rows = [doc.to_dict() for doc in docs]
        return [row for row in rows if isinstance(row, dict)]
    except Exception as exc:
        logger.warning("Automation store query-since fallback kind=events: %s", exc)
        pass
    async with _lock:
        data = list(_events)
    out: list[dict[str, Any]] = []
    for row in data:
        if str(row.get("timestamp", "")) < after_timestamp:
            continue
        if session_id and row.get("session_id") != session_id:
            continue
        if run_id and row.get("run_id") != run_id:
            continue
        out.append(dict(row))
    out.sort(key=lambda row: str(row.get("timestamp", "")))
    return out[:limit]


async def save_browser_session(session_id: str, payload: dict[str, Any]) -> None:
    if await _save_document("browser_sessions", session_id, payload):
        return
    async with _lock:
        _browser_sessions[session_id] = dict(payload)


async def get_browser_session(session_id: str) -> dict[str, Any] | None:
    row = await _get_document("browser_sessions", session_id)
    if row:
        return row
    async with _lock:
        cached = _browser_sessions.get(session_id)
        return dict(cached) if cached else None


async def update_browser_session(session_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    existing = await get_browser_session(session_id)
    if existing is None:
        return None
    existing.update(patch)
    await save_browser_session(session_id, existing)
    return existing


async def list_browser_sessions(*, user_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
    filters: dict[str, Any] = {}
    if user_id:
        filters["user_id"] = user_id
    rows = await _query_documents("browser_sessions", filters, order_field="created_at", limit=limit)
    if rows:
        return rows
    async with _lock:
        data = list(_browser_sessions.values())
    out: list[dict[str, Any]] = []
    for row in data:
        if user_id and row.get("user_id") != user_id:
            continue
        out.append(dict(row))
    out.sort(key=lambda row: str(row.get("created_at", "")), reverse=True)
    return out[:limit]


async def save_run_transition(transition_id: str, payload: dict[str, Any]) -> None:
    if await _save_document("run_transitions", transition_id, payload):
        return
    async with _lock:
        run_id = str(payload.get("run_id", "") or "")
        rows = _run_transitions.setdefault(run_id, [])
        rows.append(dict(payload))


async def list_run_transitions(run_id: str, limit: int = 200) -> list[dict[str, Any]]:
    rows = await _query_documents("run_transitions", {"run_id": run_id}, order_field="created_at", limit=limit)
    if rows:
        return rows
    async with _lock:
        data = [dict(item) for item in _run_transitions.get(run_id, [])]
    data.sort(key=lambda row: str(row.get("created_at", "")))
    return data[:limit]


async def save_notification_preferences(user_id: str, payload: dict[str, Any]) -> None:
    if await _save_document("notification_preferences", user_id, payload):
        return
    async with _lock:
        _notification_preferences[user_id] = dict(payload)


async def get_notification_preferences(user_id: str) -> dict[str, Any] | None:
    row = await _get_document("notification_preferences", user_id)
    if row:
        return row
    async with _lock:
        cached = _notification_preferences.get(user_id)
        return dict(cached) if cached else None


async def reset_store() -> None:
    global _local_documents_loaded
    async with _lock:
        _intents.clear()
        _plans.clear()
        _runs.clear()
        _run_artifacts.clear()
        _events.clear()
        _session_turns.clear()
        _prepared_turns.clear()
        _browser_sessions.clear()
        _run_transitions.clear()
        _session_control_audit.clear()
        _notification_preferences.clear()
        _conversation_tasks.clear()
        _conversations.clear()
        for kind in _COLLECTIONS:
            _local_documents[kind] = {}
        _local_documents_loaded = True
        if _LOCAL_STORE_PATH.exists():
            _LOCAL_STORE_PATH.unlink()
