from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

from fastapi import HTTPException

from oi_agent.automation.conversation_resolver import resolve_turn
from oi_agent.automation.conversation_response import (
    build_chat_session_state,
    build_chat_turn_response,
    conversation_summary_from_sources,
    task_to_intent_draft,
)
from oi_agent.automation.conversation_store import (
    create_conversation_record,
    create_conversation_task,
    load_conversation,
    load_conversation_task,
    load_conversation_task_by_conversation_id,
    save_task,
)
from oi_agent.automation.conversation_task import ConversationTask
from oi_agent.automation.models import (
    ChatSessionStateResponse,
    ChatTurnRequest,
    ChatTurnResponse,
    ConfirmIntentResponse,
    ConversationListResponse,
    ConversationSummary,
    CreateConversationRequest,
    ResolveExecutionRequest,
)
from oi_agent.automation.run_service import (
    approve_sensitive_action,
    confirm_intent,
    mutate_run_state,
    resolve_execution,
)
from oi_agent.automation.sessions.manager import browser_session_manager
from oi_agent.automation.store import (
    find_latest_intent_for_session,
    get_run,
    list_conversations_for_user,
    list_session_turns,
    save_intent,
    save_session_turn,
    update_conversation,
)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _flatten_inputs(inputs: list[Any]) -> str:
    parts: list[str] = []
    for item in inputs:
        text = getattr(item, "text", None) if not isinstance(item, dict) else item.get("text")
        transcript = getattr(item, "transcript", None) if not isinstance(item, dict) else item.get("transcript")
        caption = getattr(item, "caption", None) if not isinstance(item, dict) else item.get("caption")
        ocr_text = getattr(item, "ocr_text", None) if not isinstance(item, dict) else item.get("ocr_text")
        summary = getattr(item, "summary", None) if not isinstance(item, dict) else item.get("summary")
        for value in (text, transcript, caption, ocr_text, summary):
            if isinstance(value, str) and value.strip():
                parts.append(value.strip())
    return " ".join(parts).strip()


def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


async def _save_turn(session_id: str, user_id: str, role: str, text: str) -> None:
    await save_session_turn(
        session_id,
        f"{role}:{uuid.uuid4()}",
        {
            "turn_id": str(uuid.uuid4()),
            "session_id": session_id,
            "user_id": user_id,
            "role": role,
            "text": text,
            "timestamp": _now_iso(),
        },
    )


async def _hydrate_task_from_legacy(user_id: str, session_id: str, timezone: str) -> ConversationTask | None:
    task = await load_conversation_task(user_id, session_id)
    if task is not None:
        return task
    legacy = await find_latest_intent_for_session(user_id, session_id)
    if not legacy:
        return None
    task = await create_conversation_task(
        user_id=user_id,
        conversation_id=session_id,
        session_id=session_id,
        goal=str(legacy.get("user_goal", "") or "Untitled request"),
        model_id=str(legacy.get("model_id", "") or "") or None,
        timezone=timezone,
    )
    task.legacy_intent_id = str(legacy.get("intent_id", "") or task.legacy_intent_id)
    task.goal_type = str(legacy.get("goal_type", "unknown") or "unknown")  # type: ignore[assignment]
    task.slots = dict(legacy.get("entities", {}) or {})
    task.execution.workflow_outline = list(legacy.get("workflow_outline", []) or [])
    task.execution.missing_fields = list(legacy.get("missing_fields", []) or [])
    task.execution.risk_flags = list(legacy.get("risk_flags", []) or [])
    task.confirmation.required = bool(legacy.get("requires_confirmation", False))
    timing_mode = str(legacy.get("timing_mode", "unknown") or "unknown")
    if timing_mode == "immediate":
        task.timing.mode = "immediate"
    elif timing_mode == "once":
        task.timing.mode = "once"
    elif timing_mode in {"interval", "multi_time"}:
        task.timing.mode = "recurring"
    decision = str(legacy.get("decision", "") or "")
    if decision == "ASK_CLARIFICATION":
        task.phase = "collecting_requirements"
    elif decision == "ASK_EXECUTION_MODE":
        task.phase = "awaiting_timing"
    elif decision == "REQUIRES_CONFIRMATION":
        task.phase = "awaiting_confirmation"
    await save_task(task)
    return task


async def _persist_legacy_intent(task: ConversationTask) -> None:
    intent = task_to_intent_draft(task)
    payload = intent.model_dump(mode="json")
    payload["user_id"] = task.user_id
    payload["_saved_at"] = _now_iso()
    await save_intent(task.legacy_intent_id, payload)


async def _ensure_conversation_record(
    *,
    user_id: str,
    conversation_id: str,
    session_id: str,
    title: str,
    model_id: str | None,
) -> None:
    existing = await load_conversation(user_id, conversation_id)
    if existing is not None:
        return
    await create_conversation_record(
        user_id=user_id,
        title=title,
        session_id=session_id,
        model_id=model_id,
        conversation_id=conversation_id,
    )


async def _sync_conversation_record(task: ConversationTask) -> None:
    raw_run = await get_run(task.active_run_id) if task.active_run_id else None
    active_run_state = str(raw_run.get("state", "") or "") or None if raw_run else None
    badges: list[str] = []
    if active_run_state in {"running", "starting", "resuming", "retrying"}:
        badges.append("Running")
    elif active_run_state in {"waiting_for_user_action", "waiting_for_human", "paused"}:
        badges.append("Needs attention")
    elif task.phase == "scheduled":
        badges.append("Scheduled")
    await update_conversation(
        task.conversation_id,
        {
            "title": (task.user_goal or "New conversation")[:80],
            "summary": str(task.resolved_goal or task.user_goal or "")[:160],
            "updated_at": task.updated_at,
            "selected_model": task.model_id or "auto",
            "last_assistant_text": task.last_assistant_message,
            "last_run_state": active_run_state,
            "has_unread_updates": bool(active_run_state in {"running", "starting", "resuming", "retrying"}),
            "has_errors": bool(active_run_state in {"failed", "waiting_for_user_action", "waiting_for_human"}),
            "badges": badges,
        },
    )


async def _select_browser_session(user_id: str) -> tuple[str | None, str]:
    sessions = await browser_session_manager.list_sessions(user_id=user_id)
    preferred: tuple[str | None, str] | None = None
    fallback: tuple[str | None, str] | None = None
    for session in sessions:
        metadata = dict(session.metadata or {})
        cdp_url = str(metadata.get("cdp_url", "") or "").strip()
        if not cdp_url:
            continue
        executor_mode = "local_runner" if session.origin == "local_runner" else "server_runner"
        candidate = (session.session_id, executor_mode)
        if session.status == "ready":
            return candidate
        if session.status == "busy" and preferred is None:
            preferred = candidate
        elif fallback is None:
            fallback = candidate
    return preferred or fallback or (None, "local_runner")


def _active_page_for_session(session: Any) -> dict[str, str]:
    pages = list(getattr(session, "pages", []) or [])
    active_page_id = str(getattr(session, "page_id", "") or "")
    for page in pages:
        if active_page_id and str(getattr(page, "page_id", "") or "") == active_page_id:
            return {
                "url": str(getattr(page, "url", "") or ""),
                "title": str(getattr(page, "title", "") or ""),
            }
    for page in pages:
        if bool(getattr(page, "is_active", False)):
            return {
                "url": str(getattr(page, "url", "") or ""),
                "title": str(getattr(page, "title", "") or ""),
            }
    if pages:
        page = pages[0]
        return {
            "url": str(getattr(page, "url", "") or ""),
            "title": str(getattr(page, "title", "") or ""),
        }
    return {
        "url": str(getattr(session, "metadata", {}).get("last_known_url", "") or ""),
        "title": "",
    }


def _infer_app_from_active_page(url: str, title: str) -> str | None:
    lowered_url = str(url or "").strip().lower()
    lowered_title = str(title or "").strip().lower()
    hostname = urlparse(lowered_url).hostname or ""
    known_hosts = {
        "mail.google.com": "Gmail",
        "calendar.google.com": "Google Calendar",
        "docs.google.com": "Google Docs",
        "drive.google.com": "Google Drive",
        "github.com": "GitHub",
        "web.whatsapp.com": "WhatsApp",
        "web.telegram.org": "Telegram",
        "notion.so": "Notion",
        "www.notion.so": "Notion",
    }
    if hostname in known_hosts:
        return known_hosts[hostname]
    if hostname.endswith(".slack.com"):
        return "Slack"
    if hostname.endswith(".atlassian.net"):
        if "jira" in lowered_title:
            return "Jira"
        return "Atlassian"
    if "calendar" in hostname and "google" in hostname:
        return "Google Calendar"
    if "mail" in hostname and "google" in hostname:
        return "Gmail"
    if "github" in hostname:
        return "GitHub"
    if "whatsapp" in hostname:
        return "WhatsApp"
    return None


async def _browser_context_slots(user_id: str) -> dict[str, str]:
    sessions = await browser_session_manager.list_sessions(user_id=user_id)
    for session in sessions:
        metadata = dict(session.metadata or {})
        cdp_url = str(metadata.get("cdp_url", "") or "").strip()
        if session.status not in {"ready", "busy"} or not cdp_url:
            continue
        page = _active_page_for_session(session)
        app = _infer_app_from_active_page(page["url"], page["title"])
        if not app:
            continue
        return {
            "app": app,
            "current_url": page["url"],
            "current_title": page["title"],
        }
    return {}


async def _resolve_execution_request_from_task(task: ConversationTask) -> ResolveExecutionRequest:
    execution_mode = "immediate"
    schedule: dict[str, Any] = {"timezone": task.timing.timezone}
    if task.timing.mode == "immediate":
        execution_mode = "immediate"
    elif task.timing.mode == "once":
        execution_mode = "once"
        schedule["run_at"] = list(task.timing.run_at)
    else:
        execution_mode = "interval"
        schedule["interval_seconds"] = int(task.timing.recurrence.get("interval_seconds") or 0) or None
    browser_session_id: str | None = None
    executor_mode = "local_runner"
    if execution_mode == "immediate":
        browser_session_id, executor_mode = await _select_browser_session(task.user_id)
    return ResolveExecutionRequest(
        session_id=task.session_id,
        intent_id=task.legacy_intent_id,
        execution_mode=execution_mode,  # type: ignore[arg-type]
        executor_mode=executor_mode,  # type: ignore[arg-type]
        automation_engine="agent_browser",
        browser_session_id=browser_session_id,
        schedule=schedule,  # type: ignore[arg-type]
    )


async def _sync_phase_from_run(task: ConversationTask) -> None:
    if not task.active_run_id:
        return
    raw_run = await get_run(task.active_run_id)
    if not raw_run:
        return
    state = str(raw_run.get("state", "") or "")
    execution_progress = raw_run.get("execution_progress", {}) if isinstance(raw_run.get("execution_progress", {}), dict) else {}
    interruption = execution_progress.get("interruption", {}) if isinstance(execution_progress.get("interruption", {}), dict) else {}
    if interruption:
        reason = str(interruption.get("reason", "") or "")
        reason_code = str(interruption.get("reason_code", "") or reason)
        task.execution.active_run_action_needed = reason_code or reason or state
        task.last_assistant_message = str(interruption.get("message", "") or task.last_assistant_message or "")
        if bool(interruption.get("requires_confirmation", False)):
            task.phase = "awaiting_confirmation"
            task.status = "active"
            return
        if bool(interruption.get("requires_user_reply", False)):
            task.phase = "awaiting_user_action"
            task.status = "active"
            return
        task.phase = "failed"
        task.status = "failed"
        return
    if state in {"queued", "starting", "running", "resuming", "retrying", "reconciling"}:
        task.phase = "executing"
        task.status = "executing"
    elif state in {"waiting_for_user_action", "waiting_for_human", "paused", "failed"}:
        task.phase = "awaiting_user_action" if state != "failed" else "failed"
        task.status = "failed" if state == "failed" else "active"
        task.execution.active_run_action_needed = state
    elif state in {"completed", "succeeded"}:
        task.phase = "completed"
        task.status = "completed"
    elif state in {"cancelled", "canceled"}:
        task.phase = "cancelled"
        task.status = "cancelled"
    elif state == "awaiting_confirmation":
        task.phase = "awaiting_confirmation"
        task.status = "active"


async def _handle_action(task: ConversationTask, action_request: str, next_phase: str, user_id: str) -> str | None:
    if action_request not in {"execute", "schedule", "confirm", "run_control"}:
        return None

    if action_request in {"execute", "schedule"}:
        request = await _resolve_execution_request_from_task(task)
        if request.execution_mode == "immediate" and not request.browser_session_id:
            task.phase = "awaiting_user_action"
            task.status = "active"
            task.execution.active_run_action_needed = "browser_session_required"
            task.last_assistant_message = (
                "I’m ready to run this, but I need an active browser runner session first. "
                "Open or reconnect a local or server browser session, then reply here."
            )
            return task.last_assistant_message
        if next_phase == "awaiting_confirmation" and action_request == "schedule":
            return None
        execution_response = await resolve_execution(request, user_id)
        if execution_response.run is not None:
            task.active_run_id = execution_response.run.run_id
            await _sync_phase_from_run(task)
        if execution_response.status == "scheduled":
            task.phase = "scheduled"
            task.status = "scheduled"
        task.last_assistant_message = execution_response.assistant_message.text
        if execution_response.status == "awaiting_confirmation":
            return None
        return execution_response.assistant_message.text

    if action_request == "confirm":
        if task.confirmation.confirmed is False:
            if task.active_run_id:
                cancellation_response: ConfirmIntentResponse = await confirm_intent(
                    user_id, task.session_id, task.legacy_intent_id, False
                )
                task.last_assistant_message = cancellation_response.assistant_message.text
            task.phase = "cancelled"
            task.status = "cancelled"
            return task.last_assistant_message or "Understood. I won’t continue with that automation."

        if task.active_run_id:
            confirmation_response: ConfirmIntentResponse = await confirm_intent(
                user_id, task.session_id, task.legacy_intent_id, True
            )
            task.last_assistant_message = confirmation_response.assistant_message.text
            await _sync_phase_from_run(task)
            return confirmation_response.assistant_message.text

        request = await _resolve_execution_request_from_task(task)
        if request.execution_mode == "immediate" and not request.browser_session_id:
            task.phase = "awaiting_user_action"
            task.status = "active"
            task.execution.active_run_action_needed = "browser_session_required"
            task.last_assistant_message = (
                "I have your confirmation, but I still need an active browser runner session before I can continue. "
                "Open or reconnect one, then reply here."
            )
            return task.last_assistant_message
        response = await resolve_execution(request, user_id)
        if response.run is not None:
            task.active_run_id = response.run.run_id
            if response.status == "awaiting_confirmation":
                confirmed_response = await confirm_intent(user_id, task.session_id, task.legacy_intent_id, True)
                task.last_assistant_message = confirmed_response.assistant_message.text
                await _sync_phase_from_run(task)
                return confirmed_response.assistant_message.text
        task.last_assistant_message = response.assistant_message.text
        if response.status == "scheduled":
            task.phase = "scheduled"
            task.status = "scheduled"
        return task.last_assistant_message

    if action_request == "run_control":
        if not task.active_run_id:
            raise HTTPException(status_code=409, detail="No active run found.")
        action = str(task.execution.active_run_action_needed or "")
        _ = action
        return None

    return None


async def _handle_run_control(task: ConversationTask, action: str, user_id: str) -> str:
    if not task.active_run_id:
        raise HTTPException(status_code=409, detail="No active run found.")
    if action == "approve":
        response = await approve_sensitive_action(user_id, task.active_run_id)
    else:
        normalized = "resume" if action == "resume" else action
        response = await mutate_run_state(user_id, task.active_run_id, normalized)
    task.last_assistant_message = response.assistant_message.text
    await _sync_phase_from_run(task)
    return response.assistant_message.text


async def handle_chat_turn(payload: ChatTurnRequest, user_id: str) -> ChatTurnResponse:
    session_id = payload.session_id
    conversation_id = payload.conversation_id or session_id
    timezone = payload.client_context.timezone or "UTC"
    text = _flatten_inputs(payload.inputs)
    model_id = payload.client_context.model

    task = await _hydrate_task_from_legacy(user_id, session_id, timezone)
    if task is None:
        await _ensure_conversation_record(
            user_id=user_id,
            conversation_id=conversation_id,
            session_id=session_id,
            title=text or "New conversation",
            model_id=model_id,
        )
        task = await create_conversation_task(
            user_id=user_id,
            conversation_id=conversation_id,
            session_id=session_id,
            goal=text or "Untitled request",
            model_id=model_id,
            timezone=timezone,
        )
    browser_slots = await _browser_context_slots(user_id)
    if browser_slots:
        slots = dict(task.slots)
        for key, value in browser_slots.items():
            if value and not str(slots.get(key, "") or "").strip():
                slots[key] = value
        task.slots = slots

    await _save_turn(session_id, user_id, "user", text)
    resolution = await resolve_turn(task, text, timezone, model_id)

    task_payload = task.model_dump(mode="json")
    merged_payload = _deep_merge(task_payload, resolution.task_patch)
    task = ConversationTask.model_validate(merged_payload)
    task.phase = resolution.next_phase
    task.last_assistant_message = resolution.assistant_reply.text
    if model_id:
        task.model_id = model_id
    if resolution.action_request == "confirm":
        confirmed = resolution.action_payload.get("confirmed")
        if isinstance(confirmed, bool):
            task.confirmation.confirmed = confirmed
    await _persist_legacy_intent(task)

    action_text: str | None = None
    if resolution.action_request in {"execute", "schedule"}:
        action_text = await _handle_action(task, resolution.action_request, resolution.next_phase, user_id)
    elif resolution.action_request == "confirm":
        action_text = await _handle_action(task, "confirm", resolution.next_phase, user_id)
    elif resolution.action_request == "run_control":
        action_text = await _handle_run_control(task, str(resolution.action_payload.get("action", "") or ""), user_id)

    assistant_text = action_text or resolution.assistant_reply.text
    task.last_assistant_message = assistant_text
    await save_task(task)
    await _sync_conversation_record(task)
    await _persist_legacy_intent(task)
    await _save_turn(session_id, user_id, "assistant", assistant_text)
    turns = await list_session_turns(user_id, session_id, limit=100)
    raw_run = await get_run(task.active_run_id) if task.active_run_id else None
    active_run = None
    if raw_run:
        active_run = (await get_conversation_state(user_id, task.conversation_id)).active_run
    return build_chat_turn_response(
        task,
        assistant_text,
        conversation_meta=conversation_summary_from_sources(task=task, turns=turns, active_run=active_run),
    )


async def get_conversation_session_state(user_id: str, session_id: str) -> ChatSessionStateResponse:
    task = await _hydrate_task_from_legacy(user_id, session_id, "UTC")
    if task and task.active_run_id:
        await _sync_phase_from_run(task)
        await save_task(task)
    return await build_chat_session_state(user_id, session_id, task)


async def create_conversation(user_id: str, payload: CreateConversationRequest) -> ConversationSummary:
    session_id = str(uuid.uuid4())
    title = str(payload.title or "New conversation").strip() or "New conversation"
    record = await create_conversation_record(
        user_id=user_id,
        title=title,
        session_id=session_id,
        model_id=payload.model_id,
    )
    task = await create_conversation_task(
        user_id=user_id,
        conversation_id=str(record["conversation_id"]),
        session_id=session_id,
        goal=title,
        model_id=payload.model_id,
        timezone="UTC",
    )
    await _sync_conversation_record(task)
    return ConversationSummary.model_validate(record)


async def list_conversations(user_id: str) -> ConversationListResponse:
    rows = await list_conversations_for_user(user_id)
    return ConversationListResponse(items=[ConversationSummary.model_validate(row) for row in rows])


async def get_conversation_state(user_id: str, conversation_id: str) -> ChatSessionStateResponse:
    task = await load_conversation_task_by_conversation_id(user_id, conversation_id)
    if task is None:
        record = await load_conversation(user_id, conversation_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Conversation not found.")
        task = await _hydrate_task_from_legacy(user_id, str(record["session_id"]), "UTC")
    if task and task.active_run_id:
        await _sync_phase_from_run(task)
        await save_task(task)
        await _sync_conversation_record(task)
    if task is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")
    return await build_chat_session_state(user_id, task.session_id, task)
