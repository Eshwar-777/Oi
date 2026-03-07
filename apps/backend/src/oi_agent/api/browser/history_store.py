from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any

from oi_agent.devices.firestore_client import get_firestore

logger = logging.getLogger(__name__)

_memory_runs: dict[str, dict[str, Any]] = {}
_memory_lock = asyncio.Lock()


def _now_iso() -> str:
    return datetime.utcnow().isoformat()


def _run_key(user_id: str, run_id: str) -> str:
    return f"{user_id}:{run_id}"


def _run_doc_ref(db: Any, user_id: str, run_id: str) -> Any:
    return db.collection("users").document(user_id).collection("navigator_runs").document(run_id)


async def create_navigator_run(
    *,
    user_id: str,
    run_id: str,
    prompt: str,
    rewritten_prompt: str,
    device_id: str,
    tab_id: int | None,
    target_url: str,
    page_title: str,
) -> None:
    doc: dict[str, Any] = {
        "run_id": run_id,
        "user_id": user_id,
        "prompt": prompt,
        "rewritten_prompt": rewritten_prompt,
        "device_id": device_id,
        "tab_id": tab_id,
        "target_url": target_url,
        "page_title": page_title,
        "status": "planning",
        "message": "",
        "requires_user_action": False,
        "steps_executed": [],
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }
    try:
        db = get_firestore()
        await _run_doc_ref(db, user_id, run_id).set(doc, merge=True)
        return
    except Exception as exc:
        logger.warning("Navigator run create fallback to memory: %s", exc)

    async with _memory_lock:
        _memory_runs[_run_key(user_id, run_id)] = doc


async def finalize_navigator_run(
    *,
    user_id: str,
    run_id: str,
    status: str,
    message: str,
    requires_user_action: bool,
    steps_executed: list[dict[str, Any]],
) -> None:
    patch = {
        "status": status,
        "message": message,
        "requires_user_action": bool(requires_user_action),
        "steps_executed": steps_executed,
        "updated_at": _now_iso(),
    }
    try:
        db = get_firestore()
        await _run_doc_ref(db, user_id, run_id).set(patch, merge=True)
        return
    except Exception as exc:
        logger.warning("Navigator run finalize fallback to memory: %s", exc)

    async with _memory_lock:
        key = _run_key(user_id, run_id)
        existing = _memory_runs.get(key, {})
        existing.update(patch)
        if "created_at" not in existing:
            existing["created_at"] = _now_iso()
        _memory_runs[key] = existing


async def list_navigator_runs(
    *,
    user_id: str,
    limit: int = 30,
) -> list[dict[str, Any]]:
    max_items = max(1, min(limit, 100))
    try:
        db = get_firestore()
        query = (
            db.collection("users")
            .document(user_id)
            .collection("navigator_runs")
            .order_by("created_at", direction="DESCENDING")
            .limit(max_items)
        )
        docs = await query.get()
        rows = [d.to_dict() for d in docs]
        return [r for r in rows if isinstance(r, dict)]
    except Exception as exc:
        logger.warning("Navigator run list fallback to memory: %s", exc)

    async with _memory_lock:
        rows = [
            v
            for v in _memory_runs.values()
            if isinstance(v, dict) and str(v.get("user_id", "")) == user_id
        ]
    rows.sort(key=lambda r: str(r.get("created_at", "")), reverse=True)
    return rows[:max_items]


async def delete_navigator_run(
    *,
    user_id: str,
    run_id: str,
) -> bool:
    try:
        db = get_firestore()
        ref = _run_doc_ref(db, user_id, run_id)
        snap = await ref.get()
        if not snap.exists:
            return False
        await ref.delete()
        return True
    except Exception as exc:
        logger.warning("Navigator run delete fallback to memory: %s", exc)

    async with _memory_lock:
        return _memory_runs.pop(_run_key(user_id, run_id), None) is not None


async def delete_all_navigator_runs(
    *,
    user_id: str,
) -> int:
    try:
        db = get_firestore()
        docs = await (
            db.collection("users")
            .document(user_id)
            .collection("navigator_runs")
            .get()
        )
        count = 0
        for doc in docs:
            await doc.reference.delete()
            count += 1
        return count
    except Exception as exc:
        logger.warning("Navigator run bulk delete fallback to memory: %s", exc)

    async with _memory_lock:
        keys = [k for k in _memory_runs if k.startswith(f"{user_id}:")]
        for k in keys:
            _memory_runs.pop(k, None)
        return len(keys)
