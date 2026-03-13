from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from oi_agent.automation.events import publish_event
from oi_agent.automation.models import AutomationSchedule, AutomationScheduleCreateRequest
from oi_agent.config import settings
from oi_agent.devices.firestore_client import get_firestore

logger = logging.getLogger(__name__)

_memory_schedules: dict[str, dict[str, Any]] = {}


def _now() -> datetime:
    return datetime.now(UTC)


def _now_iso() -> str:
    return _now().isoformat()


def _db() -> Any:
    if settings.env == "dev" and not settings.automation_store_use_firestore_in_dev:
        raise RuntimeError("Firestore disabled for automation schedules in dev")
    if not (settings.gcp_project or settings.firebase_project_id):
        raise RuntimeError("Firestore not configured for automation schedules")
    return get_firestore()


def _doc_ref(db: Any, schedule_id: str) -> Any:
    return db.collection("automation_schedules").document(schedule_id)


def _claim_ttl_seconds() -> int:
    return max(30, int(settings.automation_scheduler_claim_ttl_seconds or 900))


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


def _compute_next_run(
    *,
    execution_mode: str,
    run_at: list[str],
    interval_seconds: int | None,
    last_run_at: str | None = None,
    now: datetime | None = None,
) -> str | None:
    now_dt = now or _now()
    times = sorted([value for value in run_at if _parse_iso(value) is not None])
    if execution_mode == "once":
        for value in times:
            dt = _parse_iso(value)
            if dt and dt > now_dt:
                return dt.isoformat()
        return None
    if execution_mode == "multi_time":
        last_dt = _parse_iso(last_run_at)
        for value in times:
            dt = _parse_iso(value)
            if not dt:
                continue
            if last_dt and dt <= last_dt:
                continue
            if dt >= now_dt or not last_dt:
                return dt.isoformat()
        return None
    if execution_mode == "interval" and interval_seconds:
        baseline = _parse_iso(last_run_at) or now_dt
        next_run = baseline + timedelta(seconds=interval_seconds)
        if next_run <= now_dt:
            next_run = now_dt + timedelta(seconds=interval_seconds)
        return next_run.isoformat()
    return None


async def create_automation_schedule(
    *,
    user_id: str,
    payload: AutomationScheduleCreateRequest,
) -> AutomationSchedule:
    schedule_id = str(uuid.uuid4())
    next_run_at = _compute_next_run(
        execution_mode=payload.execution_mode,
        run_at=payload.schedule.run_at,
        interval_seconds=payload.schedule.interval_seconds,
    )
    schedule = AutomationSchedule(
        schedule_id=schedule_id,
        user_id=user_id,
        session_id=payload.session_id,
        prompt=payload.prompt.strip(),
        execution_mode=payload.execution_mode,
        executor_mode=payload.executor_mode,
        automation_engine=payload.automation_engine,
        browser_session_id=payload.browser_session_id,
        timezone=payload.schedule.timezone or "UTC",
        run_at=list(payload.schedule.run_at),
        interval_seconds=payload.schedule.interval_seconds,
        device_id=payload.device_id,
        tab_id=payload.tab_id,
        status="scheduled",
        enabled=True,
        next_run_at=next_run_at,
        created_at=_now_iso(),
        updated_at=_now_iso(),
    )
    doc = schedule.model_dump(mode="json")
    try:
        db = _db()
        await _doc_ref(db, schedule_id).set(doc, merge=True)
    except Exception as exc:
        logger.warning("Automation schedule create fallback: %s", exc)
        _memory_schedules[schedule_id] = doc
    await publish_event(
        user_id=user_id,
        session_id=payload.session_id,
        run_id=None,
        event_type="schedule.created",
        payload={"schedule_id": schedule_id, "run_times": schedule.run_at},
    )
    return schedule


async def list_automation_schedules(*, user_id: str, limit: int = 100) -> list[AutomationSchedule]:
    try:
        db = _db()
        query = (
            db.collection("automation_schedules")
            .where(filter=FieldFilter("user_id", "==", user_id))
            .order_by("created_at")
            .limit(limit)
        )
        docs = await query.get()
        return [AutomationSchedule.model_validate(doc.to_dict()) for doc in docs if isinstance(doc.to_dict(), dict)]
    except Exception as exc:
        logger.warning("Automation schedule list fallback: %s", exc)
        rows = [AutomationSchedule.model_validate(row) for row in _memory_schedules.values() if row.get("user_id") == user_id]
        rows.sort(key=lambda row: row.created_at)
        return rows[:limit]


async def delete_automation_schedule(*, user_id: str, schedule_id: str) -> bool:
    try:
        db = _db()
        ref = _doc_ref(db, schedule_id)
        snap = await ref.get()
        if not snap.exists:
            return False
        row = snap.to_dict() or {}
        if row.get("user_id") != user_id:
            return False
        await ref.delete()
        return True
    except Exception as exc:
        logger.warning("Automation schedule delete fallback: %s", exc)
        row = _memory_schedules.get(schedule_id)
        if not row or row.get("user_id") != user_id:
            return False
        _memory_schedules.pop(schedule_id, None)
        return True


async def list_due_automation_schedules(*, limit: int = 20) -> list[AutomationSchedule]:
    now_dt = _now()
    now_iso = now_dt.isoformat()
    try:
        db = _db()
        query = (
            db.collection("automation_schedules")
            .where(filter=FieldFilter("next_run_at", "<=", now_iso))
            .limit(limit * 5)
        )
        docs = await query.get()
        rows = [
            AutomationSchedule.model_validate(doc.to_dict())
            for doc in docs
            if isinstance(doc.to_dict(), dict)
        ]
        rows = [
            row
            for row in rows
            if row.enabled
            and row.next_run_at
            and row.next_run_at <= now_iso
            and (
                row.status == "scheduled"
                or (row.status == "claimed" and (_parse_iso(row.claim_expires_at) or now_dt) <= now_dt)
            )
        ]
        rows.sort(key=lambda item: item.next_run_at or "")
        return rows[:limit]
    except Exception:
        # logger.warning("Automation schedule due-list fallback: %s", exc)
        fallback_rows: list[AutomationSchedule] = []
        for row in _memory_schedules.values():
            if not row.get("enabled", False):
                continue
            status = str(row.get("status", "") or "")
            claim_expires_at = _parse_iso(str(row.get("claim_expires_at", "") or ""))
            if status not in {"scheduled", "claimed"}:
                continue
            if status == "claimed" and claim_expires_at and claim_expires_at > now_dt:
                continue
            next_run = _parse_iso(str(row.get("next_run_at", "") or ""))
            if next_run and next_run <= now_dt:
                fallback_rows.append(AutomationSchedule.model_validate(row))
        fallback_rows.sort(key=lambda item: item.next_run_at or "")
        return fallback_rows[:limit]


async def claim_automation_schedule(*, schedule_id: str, worker_id: str) -> AutomationSchedule | None:
    now_iso = _now_iso()
    claim_expires_at = (_now() + timedelta(seconds=_claim_ttl_seconds())).isoformat()
    try:
        db = _db()
        ref = _doc_ref(db, schedule_id)
        transaction = db.transaction()

        @firestore.async_transactional
        async def _claim(transaction: Any) -> dict[str, Any] | None:
            snap = await ref.get(transaction=transaction)
            if not snap.exists:
                return None
            row = snap.to_dict() or {}
            if not row.get("enabled", False):
                return None
            next_run_at = _parse_iso(str(row.get("next_run_at", "") or ""))
            if next_run_at is None or next_run_at > _now():
                return None
            status = str(row.get("status", "") or "scheduled")
            claim_expiry = _parse_iso(str(row.get("claim_expires_at", "") or ""))
            if status == "claimed" and claim_expiry and claim_expiry > _now() and str(row.get("claimed_by", "") or "") != worker_id:
                return None
            patch = {
                "status": "claimed",
                "claimed_at": now_iso,
                "claim_expires_at": claim_expires_at,
                "claimed_by": worker_id,
                "updated_at": now_iso,
            }
            transaction.set(ref, patch, merge=True)
            claimed_row = dict(row)
            claimed_row.update(patch)
            return claimed_row

        claimed = await _claim(transaction)
        return AutomationSchedule.model_validate(claimed) if claimed else None
    except Exception as exc:
        logger.warning("Automation schedule claim fallback: %s", exc)
        row = _memory_schedules.get(schedule_id)
        if not row or not row.get("enabled", False):
            return None
        next_run_at = _parse_iso(str(row.get("next_run_at", "") or ""))
        if next_run_at is None or next_run_at > _now():
            return None
        status = str(row.get("status", "") or "scheduled")
        claim_expiry = _parse_iso(str(row.get("claim_expires_at", "") or ""))
        if status == "claimed" and claim_expiry and claim_expiry > _now() and str(row.get("claimed_by", "") or "") != worker_id:
            return None
        row.update(
            {
                "status": "claimed",
                "claimed_at": now_iso,
                "claim_expires_at": claim_expires_at,
                "claimed_by": worker_id,
                "updated_at": now_iso,
            }
        )
        _memory_schedules[schedule_id] = row
        return AutomationSchedule.model_validate(row)


async def mark_automation_schedule_after_run(
    *,
    schedule_id: str,
    success: bool,
    error_message: str = "",
) -> None:
    current = None
    try:
        db = _db()
        ref = _doc_ref(db, schedule_id)
        snap = await ref.get()
        if snap.exists:
            current = snap.to_dict() or {}
            if current:
                last_run_at = _now_iso()
                next_run_at = _compute_next_run(
                    execution_mode=str(current.get("execution_mode", "once") or "once"),
                    run_at=list(current.get("run_at", []) or []),
                    interval_seconds=current.get("interval_seconds") if isinstance(current.get("interval_seconds"), int) else None,
                    last_run_at=last_run_at,
                )
                enabled = bool(current.get("enabled", False)) and next_run_at is not None
                status = "scheduled" if enabled else ("completed" if success else "failed")
                await ref.set(
                    {
                        "last_run_at": last_run_at,
                        "last_error": "" if success else error_message,
                        "next_run_at": next_run_at,
                        "enabled": enabled,
                        "status": status,
                        "claimed_at": None,
                        "claim_expires_at": None,
                        "claimed_by": None,
                        "updated_at": _now_iso(),
                    },
                    merge=True,
                )
                return
    except Exception as exc:
        logger.warning("Automation schedule update fallback: %s", exc)
    row = _memory_schedules.get(schedule_id)
    if not row:
        return
    last_run_at = _now_iso()
    next_run_at = _compute_next_run(
        execution_mode=str(row.get("execution_mode", "once") or "once"),
        run_at=list(row.get("run_at", []) or []),
        interval_seconds=row.get("interval_seconds") if isinstance(row.get("interval_seconds"), int) else None,
        last_run_at=last_run_at,
    )
    enabled = bool(row.get("enabled", False)) and next_run_at is not None
    row.update(
        {
            "last_run_at": last_run_at,
            "last_error": "" if success else error_message,
            "next_run_at": next_run_at,
            "enabled": enabled,
            "status": "scheduled" if enabled else ("completed" if success else "failed"),
            "claimed_at": None,
            "claim_expires_at": None,
            "claimed_by": None,
            "updated_at": _now_iso(),
        }
    )
    _memory_schedules[schedule_id] = row


async def reset_automation_schedules() -> None:
    _memory_schedules.clear()
