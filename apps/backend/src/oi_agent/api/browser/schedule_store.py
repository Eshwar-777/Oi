from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from oi_agent.config import settings
from oi_agent.devices.firestore_client import get_firestore

logger = logging.getLogger(__name__)

ScheduleType = Literal["once", "interval", "cron"]

_memory_schedules: dict[str, dict[str, Any]] = {}
_memory_lock = asyncio.Lock()


def _now_utc() -> datetime:
    return datetime.now(UTC)


def _now_iso() -> str:
    return _now_utc().isoformat()


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt.astimezone(UTC)
    except Exception:
        return None


def _serialize_dt(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.astimezone(UTC).isoformat()


def _cron_matches(expr: str, dt: datetime) -> bool:
    parts = expr.strip().split()
    if len(parts) != 5:
        return False
    minute, hour, dom, month, dow = parts

    def match(part: str, value: int) -> bool:
        part = part.strip()
        if part == "*":
            return True
        if part.startswith("*/"):
            try:
                step = int(part[2:])
                return step > 0 and (value % step == 0)
            except Exception:
                return False
        if "," in part:
            return any(match(p.strip(), value) for p in part.split(","))
        try:
            return int(part) == value
        except Exception:
            return False

    # Python weekday: Mon=0..Sun=6 ; cron usually Sun=0/7
    cron_dow = (dt.weekday() + 1) % 7
    return (
        match(minute, dt.minute)
        and match(hour, dt.hour)
        and match(dom, dt.day)
        and match(month, dt.month)
        and match(dow, cron_dow)
    )


def compute_next_run_at(schedule: dict[str, Any], now: datetime | None = None) -> datetime | None:
    now_dt = now or _now_utc()
    schedule_type = str(schedule.get("schedule_type", "once")).strip().lower()

    if schedule_type == "once":
        run_at = _parse_iso(str(schedule.get("run_at", "") or ""))
        if run_at and run_at > now_dt:
            return run_at
        return None

    if schedule_type == "interval":
        interval_seconds = int(schedule.get("interval_seconds", 0) or 0)
        if interval_seconds <= 0:
            return None
        baseline = _parse_iso(str(schedule.get("last_run_at", "") or "")) or now_dt
        next_run = baseline + timedelta(seconds=interval_seconds)
        if next_run <= now_dt:
            next_run = now_dt + timedelta(seconds=interval_seconds)
        return next_run

    if schedule_type == "cron":
        expr = str(schedule.get("cron", "") or "").strip()
        if not expr:
            return None
        # minute-resolution scanner up to 31 days
        probe = (now_dt + timedelta(minutes=1)).replace(second=0, microsecond=0)
        for _ in range(31 * 24 * 60):
            if _cron_matches(expr, probe):
                return probe
            probe += timedelta(minutes=1)
        return None

    return None


def _doc_ref(db: Any, schedule_id: str) -> Any:
    return db.collection("navigator_schedules").document(schedule_id)


def _db() -> Any:
    if not (settings.gcp_project or settings.firebase_project_id):
        raise RuntimeError("Firestore not configured for navigator schedules")
    return get_firestore()


async def create_schedule(
    *,
    user_id: str,
    prompt: str,
    device_id: str | None,
    tab_id: int | None,
    schedule_type: ScheduleType,
    run_at: str | None,
    interval_seconds: int | None,
    cron: str | None,
    enabled: bool = True,
) -> dict[str, Any]:
    schedule_id = str(uuid.uuid4())
    now = _now_utc()
    doc: dict[str, Any] = {
        "schedule_id": schedule_id,
        "user_id": user_id,
        "prompt": prompt,
        "device_id": device_id,
        "tab_id": tab_id,
        "schedule_type": schedule_type,
        "run_at": run_at,
        "interval_seconds": interval_seconds,
        "cron": cron,
        "enabled": bool(enabled),
        "status": "scheduled" if enabled else "disabled",
        "last_run_at": None,
        "last_error": "",
        "created_at": _serialize_dt(now),
        "updated_at": _serialize_dt(now),
        "next_run_at": None,
    }
    doc["next_run_at"] = _serialize_dt(compute_next_run_at(doc, now))

    try:
        db = _db()
        await _doc_ref(db, schedule_id).set(doc, merge=True)
        return doc
    except Exception as exc:
        logger.warning("Navigator schedule create fallback to memory: %s", exc)

    async with _memory_lock:
        _memory_schedules[schedule_id] = dict(doc)
    return doc


async def list_schedules(*, user_id: str, limit: int = 100) -> list[dict[str, Any]]:
    max_items = max(1, min(limit, 200))
    try:
        db = _db()
        query = (
            db.collection("navigator_schedules")
            .where("user_id", "==", user_id)
            .order_by("created_at", direction="DESCENDING")
            .limit(max_items)
        )
        docs = await query.get()
        return [d.to_dict() for d in docs if isinstance(d.to_dict(), dict)]
    except Exception as exc:
        logger.warning("Navigator schedule list fallback to memory: %s", exc)

    async with _memory_lock:
        rows = [v for v in _memory_schedules.values() if str(v.get("user_id", "")) == user_id]
    rows.sort(key=lambda r: str(r.get("created_at", "")), reverse=True)
    return rows[:max_items]


async def delete_schedule(*, user_id: str, schedule_id: str) -> bool:
    try:
        db = _db()
        ref = _doc_ref(db, schedule_id)
        snap = await ref.get()
        if not snap.exists:
            return False
        row = snap.to_dict() or {}
        if str(row.get("user_id", "")) != user_id:
            return False
        await ref.delete()
        return True
    except Exception as exc:
        logger.warning("Navigator schedule delete fallback to memory: %s", exc)

    async with _memory_lock:
        row = _memory_schedules.get(schedule_id)
        if not row or str(row.get("user_id", "")) != user_id:
            return False
        _memory_schedules.pop(schedule_id, None)
        return True


async def list_due_schedules(*, now: datetime | None = None, limit: int = 20) -> list[dict[str, Any]]:
    now_dt = now or _now_utc()
    now_iso = _serialize_dt(now_dt)
    try:
        db = _db()
        query = (
            db.collection("navigator_schedules")
            .where("enabled", "==", True)
            .where("next_run_at", "<=", now_iso)
            .limit(max(1, min(limit, 100)))
        )
        docs = await query.get()
        rows = [d.to_dict() for d in docs if isinstance(d.to_dict(), dict)]
        rows.sort(key=lambda r: str(r.get("next_run_at", "")))
        return rows[:limit]
    except Exception as exc:
        logger.warning("Navigator schedule due-list fallback to memory: %s", exc)

    async with _memory_lock:
        rows = []
        for row in _memory_schedules.values():
            if not bool(row.get("enabled", False)):
                continue
            next_run = _parse_iso(str(row.get("next_run_at", "") or ""))
            if next_run and next_run <= now_dt:
                rows.append(dict(row))
    rows.sort(key=lambda r: str(r.get("next_run_at", "")))
    return rows[:limit]


async def mark_schedule_after_run(
    *,
    schedule_id: str,
    success: bool,
    error_message: str = "",
) -> None:
    now = _now_utc()
    patch: dict[str, Any] = {
        "last_run_at": _serialize_dt(now),
        "last_error": "" if success else error_message,
        "updated_at": _serialize_dt(now),
    }

    # Need schedule snapshot for next_run computation
    current: dict[str, Any] | None = None
    try:
        db = _db()
        ref = _doc_ref(db, schedule_id)
        snap = await ref.get()
        if snap.exists:
            current = snap.to_dict() or {}
            if current:
                next_run = compute_next_run_at(current, now)
                enabled = bool(current.get("enabled", False))
                schedule_type = str(current.get("schedule_type", "once")).strip().lower()
                if schedule_type == "once":
                    enabled = False
                    patch["status"] = "completed" if success else "failed"
                patch["enabled"] = enabled and (next_run is not None)
                patch["next_run_at"] = _serialize_dt(next_run)
                if not patch["enabled"] and schedule_type != "once":
                    patch["status"] = "stopped"
                await ref.set(patch, merge=True)
                return
    except Exception as exc:
        logger.warning("Navigator schedule update fallback to memory: %s", exc)

    async with _memory_lock:
        current = _memory_schedules.get(schedule_id)
        if not current:
            return
        next_run = compute_next_run_at(current, now)
        enabled = bool(current.get("enabled", False))
        schedule_type = str(current.get("schedule_type", "once")).strip().lower()
        if schedule_type == "once":
            enabled = False
            patch["status"] = "completed" if success else "failed"
        patch["enabled"] = enabled and (next_run is not None)
        patch["next_run_at"] = _serialize_dt(next_run)
        if not patch["enabled"] and schedule_type != "once":
            patch["status"] = "stopped"
        current.update(patch)
        _memory_schedules[schedule_id] = current
