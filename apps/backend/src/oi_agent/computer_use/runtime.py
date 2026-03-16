from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

import httpx

from oi_agent.api.browser.server_runner import server_browser_runner
from oi_agent.automation.assistant_updates import publish_assistant_run_update
from oi_agent.automation.events import publish_event
from oi_agent.automation.conversation_store import load_conversation_task, save_task
from oi_agent.automation.sessions.manager import browser_session_manager
from oi_agent.automation.sessions.models import BrowserPageRecord, UpdateBrowserSessionRequest
from oi_agent.automation.run_service import record_run_transition
from oi_agent.automation.store import get_browser_session, get_plan, get_run, update_run
from oi_agent.computer_use.engine import run_computer_use

logger = logging.getLogger(__name__)

_task_lock = asyncio.Lock()
_tasks: dict[str, asyncio.Task[None]] = {}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _normalize_error(message: str) -> tuple[str, str]:
    lowered = str(message or "").strip().lower()
    if "rate limit" in lowered or "resource_exhausted" in lowered or "429" in lowered:
        return "MODEL_RATE_LIMIT", "The model is temporarily rate-limited. Please retry the run."
    if "temporarily overloaded" in lowered or "temporarily unavailable" in lowered:
        return "MODEL_OVERLOADED", "The model is temporarily overloaded. Please retry the run."
    if "page.goto:" in lowered or "net::err_" in lowered or "protocol_error" in lowered:
        return "BROWSER_NAVIGATION_FAILED", "The browser could not finish loading that page cleanly. Please retry the run."
    if "step_limit_reached" in lowered:
        return "STEP_LIMIT_REACHED", "The browser needed more steps than the current limit allows."
    return "COMPUTER_USE_FAILED", str(message or "Computer use failed.")


async def _publish_run_activity(
    *,
    user_id: str,
    session_id: str,
    run_id: str,
    summary: str,
    tone: str = "neutral",
) -> None:
    cleaned = str(summary or "").strip()
    if not cleaned:
        return
    await publish_event(
        user_id=user_id,
        session_id=session_id,
        run_id=run_id,
        event_type="run.activity",
        payload={"run_id": run_id, "summary": cleaned, "tone": tone},
    )


async def _browser_cdp_url(browser_session_id: str | None) -> str:
    if not browser_session_id:
        raise RuntimeError("Computer use run is missing a browser session.")
    metadata = await get_browser_session(browser_session_id)
    cdp_url = str((metadata or {}).get("cdp_url", "") or "").strip()
    if not cdp_url:
        raise RuntimeError("Computer use could not find a live browser connection.")
    return cdp_url


async def _ensure_live_browser_connection(
    *,
    run_id: str,
    user_id: str,
    browser_session_id: str | None,
) -> tuple[str | None, str]:
    try:
        cdp_url = await _browser_cdp_url(browser_session_id)
        return browser_session_id, cdp_url
    except Exception:
        if not user_id:
            raise
    session = await server_browser_runner.ensure_session(user_id=user_id, prefer_visible=True)
    await update_run(
        run_id,
        {
            "browser_session_id": session.session_id,
            "updated_at": _now_iso(),
        },
    )
    cdp_url = str((session.metadata or {}).get("cdp_url", "") or "").strip()
    if not cdp_url:
        cdp_url = await _browser_cdp_url(session.session_id)
    logger.info(
        "computer_use_runtime_browser_rehydrated",
        extra={
            "run_id": run_id,
            "previous_browser_session_id": browser_session_id,
            "browser_session_id": session.session_id,
        },
    )
    return session.session_id, cdp_url


async def _sync_browser_session_snapshot(
    *,
    browser_session_id: str | None,
    cdp_url: str,
) -> None:
    if not browser_session_id:
        return
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0, read=3.0)) as client:
            response = await client.get(f"{cdp_url}/json/list")
            response.raise_for_status()
            payload = response.json()
        pages_raw = payload if isinstance(payload, list) else []
        pages = [
            BrowserPageRecord(
                page_id=str(page.get("id", "") or ""),
                url=str(page.get("url", "") or ""),
                title=str(page.get("title", "") or ""),
                is_active=index == 0,
            )
            for index, page in enumerate(pages_raw)
            if str(page.get("type", "") or "") == "page"
        ]
        await browser_session_manager.update_session(
            session_id=browser_session_id,
            request=UpdateBrowserSessionRequest(
                status="ready",
                page_id=pages[0].page_id if pages else None,
                pages=pages,
            ),
        )
    except Exception:
        logger.debug("computer_use_runtime_session_sync_failed", exc_info=True)


def _recent_action_log_append(current_progress: dict[str, Any], entry: dict[str, Any]) -> list[dict[str, Any]]:
    recent = list(current_progress.get("recent_action_log", []) or [])
    recent.append(entry)
    return recent[-8:]


async def _set_run_state(
    *,
    run_id: str,
    user_id: str,
    session_id: str,
    from_state: str | None,
    to_state: str,
    event_type: str,
    payload: dict[str, Any],
    reason_code: str,
    reason_text: str,
    patch: dict[str, Any] | None = None,
) -> None:
    base_patch = {"state": to_state, "updated_at": _now_iso()}
    if patch:
        base_patch.update(patch)
    await update_run(run_id, base_patch)
    await record_run_transition(
        run_id=run_id,
        from_state=from_state,
        to_state=to_state,
        reason_code=reason_code,
        reason_text=reason_text,
    )
    await publish_event(
        user_id=user_id,
        session_id=session_id,
        run_id=run_id,
        event_type=event_type,
        payload={"run_id": run_id, **payload},
    )


async def _persist_assistant_outcome(
    *,
    user_id: str,
    session_id: str,
    run_id: str,
    text: str,
    run_state: str,
) -> None:
    cleaned = str(text or "").strip()
    if not cleaned:
        return
    task = await load_conversation_task(user_id, session_id)
    if task is not None:
        task.last_assistant_message = cleaned
        if run_state == "completed":
            task.phase = "completed"
            task.status = "completed"
        elif run_state == "failed":
            task.phase = "needs_attention"
            task.status = "failed"
        await save_task(task)
    await publish_assistant_run_update(
        user_id=user_id,
        session_id=session_id,
        run_id=run_id,
        text=cleaned,
        run_state=run_state,
    )


async def _execute_computer_use_run(run_id: str) -> None:
    logger.info("computer_use_runtime_started", extra={"run_id": run_id})
    raw_run = await get_run(run_id)
    if not raw_run:
        logger.warning("computer_use_runtime_run_missing", extra={"run_id": run_id})
        return
    user_id = str(raw_run.get("user_id", "") or "")
    session_id = str(raw_run.get("session_id", "") or "")
    browser_session_id = str(raw_run.get("browser_session_id", "") or "") or None
    from_state = str(raw_run.get("state", "") or "queued")
    logger.info(
        "computer_use_runtime_run_loaded",
        extra={
            "run_id": run_id,
            "session_id": session_id,
            "browser_session_id": browser_session_id,
            "state": from_state,
            "plan_id": str(raw_run.get("plan_id", "") or ""),
        },
    )

    raw_plan = await get_plan(str(raw_run.get("plan_id", "") or ""))
    if not raw_plan:
        logger.warning(
            "computer_use_runtime_plan_missing",
            extra={"run_id": run_id, "plan_id": str(raw_run.get("plan_id", "") or "")},
        )
        code, message = _normalize_error("Computer use plan not found.")
        await _set_run_state(
            run_id=run_id,
            user_id=user_id,
            session_id=session_id,
            from_state=from_state,
            to_state="failed",
            event_type="run.failed",
            payload={"code": code, "message": message, "retryable": True},
            reason_code=code,
            reason_text=message,
            patch={"last_error": {"code": code, "message": message, "retryable": True}},
        )
        return

    prompt = str(raw_plan.get("source_prompt", "") or raw_plan.get("summary", "") or "").strip()
    browser_session_id, cdp_url = await _ensure_live_browser_connection(
        run_id=run_id,
        user_id=user_id,
        browser_session_id=browser_session_id,
    )
    logger.info(
        "computer_use_runtime_browser_ready",
        extra={
            "run_id": run_id,
            "browser_session_id": browser_session_id,
            "cdp_url_present": bool(cdp_url),
            "prompt_excerpt": prompt[:160],
        },
    )

    await _set_run_state(
        run_id=run_id,
        user_id=user_id,
        session_id=session_id,
        from_state=from_state,
        to_state="starting",
        event_type="run.started",
        payload={},
        reason_code="RUN_STARTED",
        reason_text="Computer use is starting.",
        patch={"last_error": None},
    )

    await _set_run_state(
        run_id=run_id,
        user_id=user_id,
        session_id=session_id,
        from_state="starting",
        to_state="running",
        event_type="run.resumed",
        payload={"reason": "Computer use is running."},
        reason_code="RUN_RUNNING",
        reason_text="Computer use is running.",
    )

    async def on_event(event: dict[str, Any]) -> None:
        current = await get_run(run_id)
        if not current:
            return
        current_progress = dict(current.get("execution_progress", {}) or {})
        event_type = str(event.get("type", "") or "")
        payload = dict(event.get("payload", {}) or {})
        if event_type == "observation":
            title = str(payload.get("title", "") or "").strip()
            url = str(payload.get("url", "") or "").strip()
            summary = f"Looking at {title or url or 'the page'}."
            current_progress["status_summary"] = summary
            await _sync_browser_session_snapshot(
                browser_session_id=browser_session_id,
                cdp_url=cdp_url,
            )
            await update_run(
                run_id,
                {
                    "updated_at": _now_iso(),
                    "execution_progress": current_progress,
                    "page_registry": {
                        "page_0": {
                            "url": url,
                            "title": title,
                            "last_seen_at": _now_iso(),
                        }
                    },
                    "active_page_ref": "page_0",
                },
            )
            await _publish_run_activity(user_id=user_id, session_id=session_id, run_id=run_id, summary=summary)
            await publish_event(
                user_id=user_id,
                session_id=session_id,
                run_id=run_id,
                event_type="run.browser.snapshot",
                payload={"run_id": run_id, "summary": summary, **payload},
            )
            return
        if event_type == "action":
            action_name = str(payload.get("action", "") or "act").replace("_", " ")
            summary = str(payload.get("reason", "") or f"Trying the next browser step: {action_name}.").strip()
            current_progress["current_runtime_action"] = {
                "command": action_name,
                "label": action_name.title(),
                "status": "running",
                "message": summary,
                "started_at": _now_iso(),
            }
            current_progress["status_summary"] = summary
            current_progress["recent_action_log"] = _recent_action_log_append(
                current_progress,
                {
                    "command": action_name,
                    "label": action_name.title(),
                    "message": summary,
                    "started_at": _now_iso(),
                },
            )
            await update_run(run_id, {"updated_at": _now_iso(), "execution_progress": current_progress})
            await _publish_run_activity(user_id=user_id, session_id=session_id, run_id=run_id, summary=summary)
            await publish_event(
                user_id=user_id,
                session_id=session_id,
                run_id=run_id,
                event_type="run.browser.action",
                payload={"run_id": run_id, "summary": summary, **payload},
            )
            return
        if event_type == "done":
            summary = str(payload.get("message", "") or "The task looks complete.").strip()
            current_progress["status_summary"] = summary
            current_progress["current_runtime_action"] = None
            await update_run(run_id, {"updated_at": _now_iso(), "execution_progress": current_progress})

    try:
        result = await run_computer_use(prompt=prompt, cdp_url=cdp_url, on_event=on_event)
    except asyncio.CancelledError:
        logger.info("computer_use_run_cancelled", extra={"run_id": run_id})
        raise
    except Exception as exc:
        logger.exception("computer_use_runtime_failed", extra={"run_id": run_id})
        code, message = _normalize_error(str(exc))
        await _set_run_state(
            run_id=run_id,
            user_id=user_id,
            session_id=session_id,
            from_state="running",
            to_state="failed",
            event_type="run.failed",
            payload={"code": code, "message": message, "retryable": True},
            reason_code=code,
            reason_text=message,
            patch={
                "last_error": {"code": code, "message": message, "retryable": True},
                "execution_progress": {
                    **dict((await get_run(run_id) or {}).get("execution_progress", {}) or {}),
                    "current_runtime_action": None,
                    "status_summary": message,
                },
            },
        )
        await _publish_run_activity(user_id=user_id, session_id=session_id, run_id=run_id, summary=message, tone="danger")
        return

    if result.success:
        final_message = str(result.final_message or "The task is complete.").strip()
        logger.info("computer_use_runtime_completed", extra={"run_id": run_id, "final_text": final_message})
        await _sync_browser_session_snapshot(
            browser_session_id=browser_session_id,
            cdp_url=cdp_url,
        )
        await _persist_assistant_outcome(
            user_id=user_id,
            session_id=session_id,
            run_id=run_id,
            text=final_message,
            run_state="completed",
        )
        await _set_run_state(
            run_id=run_id,
            user_id=user_id,
            session_id=session_id,
            from_state="running",
            to_state="completed",
            event_type="run.completed",
            payload={"message": final_message},
            reason_code="RUN_COMPLETED",
            reason_text=final_message,
            patch={
                "last_error": None,
                "execution_progress": {
                    **dict((await get_run(run_id) or {}).get("execution_progress", {}) or {}),
                    "current_runtime_action": None,
                    "status_summary": final_message,
                },
            },
        )
        await _publish_run_activity(user_id=user_id, session_id=session_id, run_id=run_id, summary=final_message, tone="success")
        return

    code, message = _normalize_error(result.error or result.final_message)
    logger.warning(
        "computer_use_runtime_unsuccessful",
        extra={"run_id": run_id, "code": code, "final_text": message},
    )
    await _persist_assistant_outcome(
        user_id=user_id,
        session_id=session_id,
        run_id=run_id,
        text=message,
        run_state="failed",
    )
    await _set_run_state(
        run_id=run_id,
        user_id=user_id,
        session_id=session_id,
        from_state="running",
        to_state="failed",
        event_type="run.failed",
        payload={"code": code, "message": message, "retryable": True},
        reason_code=code,
        reason_text=message,
        patch={
            "last_error": {"code": code, "message": message, "retryable": True},
            "execution_progress": {
                **dict((await get_run(run_id) or {}).get("execution_progress", {}) or {}),
                "current_runtime_action": None,
                "status_summary": message,
            },
        },
    )
    await _publish_run_activity(user_id=user_id, session_id=session_id, run_id=run_id, summary=message, tone="danger")


def _log_task_completion(run_id: str, task: asyncio.Task[None]) -> None:
    try:
        task.result()
    except asyncio.CancelledError:
        logger.info("computer_use_runtime_task_cancelled", extra={"run_id": run_id})
    except Exception:
        logger.exception("computer_use_runtime_task_crashed", extra={"run_id": run_id})
    finally:
        async def _cleanup() -> None:
            async with _task_lock:
                current = _tasks.get(run_id)
                if current is task:
                    _tasks.pop(run_id, None)
        asyncio.create_task(_cleanup())


async def start_computer_use_run(run_id: str) -> None:
    async with _task_lock:
        task = _tasks.get(run_id)
        if task and not task.done():
            return
        task = asyncio.create_task(_execute_computer_use_run(run_id))
        task.add_done_callback(lambda current_task: _log_task_completion(run_id, current_task))
        _tasks[run_id] = task


async def cancel_computer_use_run(run_id: str) -> None:
    async with _task_lock:
        task = _tasks.get(run_id)
        if task and not task.done():
            task.cancel()


async def has_live_computer_use_run(run_id: str) -> bool:
    async with _task_lock:
        task = _tasks.get(run_id)
        return bool(task and not task.done())
