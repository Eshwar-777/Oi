from __future__ import annotations

import asyncio
import logging
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
}


def _use_firestore() -> bool:
    if settings.env == "dev" and not settings.automation_store_use_firestore_in_dev:
        return False
    return bool(settings.gcp_project or settings.firebase_project_id)


def _db() -> Any:
    if not _use_firestore():
        raise RuntimeError("Firestore not configured for automation store")
    return get_firestore()


def _doc_ref(db: Any, kind: str, doc_id: str) -> Any:
    return db.collection(_COLLECTIONS[kind]).document(doc_id)


async def _firestore_wait(kind: str, operation: str, awaitable: Any) -> Any:
    try:
        return await asyncio.wait_for(awaitable, timeout=_FIRESTORE_TIMEOUT_SECONDS)
    except TimeoutError:
        # logger.warning(
        #     "Automation store %s timeout kind=%s after %ss",
        #     operation,
        #     kind,
        #     _FIRESTORE_TIMEOUT_SECONDS,
        # )
        raise


async def _save_document(kind: str, doc_id: str, payload: dict[str, Any]) -> bool:
    try:
        db = _db()
        await _firestore_wait(
            kind,
            "save",
            _doc_ref(db, kind, doc_id).set(dict(payload), merge=True),
        )
        return True
    except Exception as exc:
        # logger.warning("Automation store save fallback kind=%s: %s", kind, exc)
        return False


async def _get_document(kind: str, doc_id: str) -> dict[str, Any] | None:
    try:
        db = _db()
        snap = await _firestore_wait(kind, "get", _doc_ref(db, kind, doc_id).get())
        if snap.exists:
            row = snap.to_dict()
            return row if isinstance(row, dict) else None
    except Exception as exc:
        # logger.warning("Automation store get fallback kind=%s: %s", kind, exc)
        pass
    return None


async def _delete_document(kind: str, doc_id: str) -> None:
    try:
        db = _db()
        await _firestore_wait(kind, "delete", _doc_ref(db, kind, doc_id).delete())
    except Exception as exc:
        # logger.warning("Automation store delete fallback kind=%s: %s", kind, exc)
        pass


async def _query_documents(kind: str, filters: dict[str, Any], order_field: str = "", limit: int = 100) -> list[dict[str, Any]]:
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
        # logger.warning("Automation store query fallback kind=%s: %s", kind, exc)
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


async def update_run(run_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
    existing = await get_run(run_id)
    if existing is None:
        return None
    existing.update(patch)
    await save_run(run_id, existing)
    return existing


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
        # logger.warning("Automation store query-since fallback kind=events: %s", exc)
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
