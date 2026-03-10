from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Iterable

from oi_agent.automation.sessions.models import (
    BrowserSessionRecord,
    ControllerLockRecord,
    CreateBrowserSessionRequest,
    UpdateBrowserSessionRequest,
)
from oi_agent.automation.store import (
    get_browser_session,
    list_browser_sessions,
    save_browser_session,
    update_browser_session,
)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _parse_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed


def _session_identity(session: BrowserSessionRecord) -> str:
    if session.runner_id:
        return f"runner:{session.user_id}:{session.origin}:{session.runner_id}"
    if session.browser_session_id:
        return f"browser:{session.user_id}:{session.origin}:{session.browser_session_id}"
    return f"session:{session.session_id}"


def _dedupe_sessions(sessions: Iterable[BrowserSessionRecord]) -> list[BrowserSessionRecord]:
    ordered = sorted(
        list(sessions),
        key=lambda session: str(session.updated_at or session.created_at or ""),
        reverse=True,
    )
    deduped: dict[str, BrowserSessionRecord] = {}
    for session in ordered:
        identity = _session_identity(session)
        existing = deduped.get(identity)
        if existing is None:
            deduped[identity] = session
            continue
        if existing.status != "ready" and session.status == "ready":
            deduped[identity] = session
    return sorted(
        deduped.values(),
        key=lambda session: str(session.updated_at or session.created_at or ""),
        reverse=True,
    )


class BrowserSessionManager:
    async def _normalize_lock(self, session: BrowserSessionRecord) -> BrowserSessionRecord:
        current = session.controller_lock
        if current is None:
            return session
        if _parse_iso(current.expires_at) > datetime.now(UTC):
            return session
        row = await update_browser_session(
            session.session_id,
            {"controller_lock": None, "updated_at": _now_iso()},
        )
        return BrowserSessionRecord.model_validate(row) if row else session

    async def create_session(
        self,
        *,
        user_id: str,
        request: CreateBrowserSessionRequest,
    ) -> BrowserSessionRecord:
        now = _now_iso()
        existing = None
        sessions = await self.list_sessions(user_id=user_id)
        for candidate in sessions:
            if request.runner_id and candidate.runner_id == request.runner_id and candidate.origin == request.origin:
                existing = candidate
                break
            if (
                existing is None
                and request.browser_session_id
                and candidate.browser_session_id == request.browser_session_id
                and candidate.origin == request.origin
            ):
                existing = candidate
        if existing is not None:
            session = await self.update_session(
                session_id=existing.session_id,
                request=UpdateBrowserSessionRequest(
                    status="starting",
                    automation_engine=request.automation_engine,
                    browser_session_id=request.browser_session_id,
                    browser_version=request.browser_version,
                    page_id=request.page_id,
                    viewport=request.viewport,
                    metadata=dict(request.metadata),
                ),
            )
            if session is not None:
                patch: dict[str, object] = {"updated_at": now}
                if request.runner_id is not None:
                    patch["runner_id"] = request.runner_id
                if request.runner_label is not None:
                    patch["runner_label"] = request.runner_label
                row = await update_browser_session(existing.session_id, patch)
                if row:
                    return BrowserSessionRecord.model_validate(row)
        record = BrowserSessionRecord(
            session_id=str(uuid.uuid4()),
            user_id=user_id,
            origin=request.origin,
            automation_engine=request.automation_engine,
            browser_session_id=request.browser_session_id,
            browser_version=request.browser_version,
            runner_id=request.runner_id,
            runner_label=request.runner_label,
            page_id=request.page_id,
            viewport=request.viewport,
            metadata=dict(request.metadata),
            created_at=now,
            updated_at=now,
        )
        await save_browser_session(record.session_id, record.model_dump(mode="json"))
        return record

    async def get_session(self, session_id: str) -> BrowserSessionRecord | None:
        row = await get_browser_session(session_id)
        if not row:
            return None
        return await self._normalize_lock(BrowserSessionRecord.model_validate(row))

    async def list_sessions(self, *, user_id: str) -> list[BrowserSessionRecord]:
        rows = await list_browser_sessions(user_id=user_id, limit=100)
        sessions = [BrowserSessionRecord.model_validate(row) for row in rows]
        normalized = [await self._normalize_lock(session) for session in sessions]
        return _dedupe_sessions(normalized)

    async def update_session(
        self,
        *,
        session_id: str,
        request: UpdateBrowserSessionRequest,
    ) -> BrowserSessionRecord | None:
        patch: dict[str, object] = {"updated_at": _now_iso()}
        if request.status is not None:
            patch["status"] = request.status
        if request.automation_engine is not None:
            patch["automation_engine"] = request.automation_engine
        if request.browser_session_id is not None:
            patch["browser_session_id"] = request.browser_session_id
        if request.browser_version is not None:
            patch["browser_version"] = request.browser_version
        if request.page_id is not None:
            patch["page_id"] = request.page_id
        if request.pages is not None:
            patch["pages"] = [page.model_dump(mode="json") for page in request.pages]
        if request.viewport is not None:
            patch["viewport"] = request.viewport.model_dump(mode="json")
        if request.controller_lock is not None:
            patch["controller_lock"] = request.controller_lock.model_dump(mode="json")
        if request.metadata is not None:
            patch["metadata"] = dict(request.metadata)
        row = await update_browser_session(session_id, patch)
        return BrowserSessionRecord.model_validate(row) if row else None

    async def acquire_control(
        self,
        *,
        session_id: str,
        actor_id: str,
        actor_type: str,
        priority: int,
        ttl_seconds: int,
    ) -> BrowserSessionRecord | None:
        session = await self.get_session(session_id)
        if session is None:
            return None
        now = datetime.now(UTC)
        current = session.controller_lock
        if current is not None:
            current_expires = _parse_iso(current.expires_at)
            if current_expires > now and current.actor_id == actor_id:
                lock = ControllerLockRecord(
                    actor_id=actor_id,
                    actor_type=actor_type,  # type: ignore[arg-type]
                    acquired_at=current.acquired_at,
                    expires_at=(now + timedelta(seconds=ttl_seconds)).isoformat(),
                    priority=max(priority, current.priority),
                )
                return await self.update_session(
                    session_id=session_id,
                    request=UpdateBrowserSessionRequest(controller_lock=lock),
                )
            if current_expires > now and current.actor_id != actor_id and current.priority >= priority:
                return session
        lock = ControllerLockRecord(
            actor_id=actor_id,
            actor_type=actor_type,  # type: ignore[arg-type]
            acquired_at=now.isoformat(),
            expires_at=(now + timedelta(seconds=ttl_seconds)).isoformat(),
            priority=priority,
        )
        return await self.update_session(
            session_id=session_id,
            request=UpdateBrowserSessionRequest(controller_lock=lock),
        )

    async def release_control(self, *, session_id: str, actor_id: str) -> BrowserSessionRecord | None:
        session = await self.get_session(session_id)
        if session is None:
            return None
        current = session.controller_lock
        if current is None or current.actor_id != actor_id:
            return session
        row = await update_browser_session(
            session_id,
            {"controller_lock": None, "updated_at": _now_iso()},
        )
        return BrowserSessionRecord.model_validate(row) if row else None

    async def touch_control(
        self,
        *,
        session_id: str,
        actor_id: str,
        ttl_seconds: int = 300,
    ) -> BrowserSessionRecord | None:
        session = await self.get_session(session_id)
        if session is None:
            return None
        current = session.controller_lock
        if current is None or current.actor_id != actor_id:
            return session
        now = datetime.now(UTC)
        lock = ControllerLockRecord(
            actor_id=current.actor_id,
            actor_type=current.actor_type,
            acquired_at=current.acquired_at,
            expires_at=(now + timedelta(seconds=ttl_seconds)).isoformat(),
            priority=current.priority,
        )
        return await self.update_session(
            session_id=session_id,
            request=UpdateBrowserSessionRequest(controller_lock=lock),
        )


browser_session_manager = BrowserSessionManager()
