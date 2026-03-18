from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException

from oi_agent.api.browser.server_runner import server_browser_runner
from oi_agent.automation.conversation_store import (
    create_conversation_record,
    create_conversation_task,
    load_conversation,
    load_conversation_task,
    load_conversation_task_by_conversation_id,
    save_task,
)
from oi_agent.automation.models import AutomationPlan, AutomationStep, AutomationTarget
from oi_agent.automation.models import AutomationScheduleCreateRequest, ResolveExecutionSchedule
from oi_agent.automation.run_service import create_run_for_plan
from oi_agent.automation.sessions.manager import browser_session_manager
from oi_agent.automation.store import get_browser_session, save_plan, save_session_turn
from oi_agent.automation.executor import start_execution
from oi_agent.automation.schedule_service import create_automation_schedule
from oi_agent.automation.conversation_service import _select_browser_session
from oi_agent.computer_use.intake import resolve_computer_use_intake
from oi_agent.computer_use.models import ComputerUseExecuteRequest, ComputerUseExecuteResponse
from oi_agent.config import settings


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


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
            "inputs": [{"type": "text", "text": text}],
            "timestamp": _now_iso(),
        },
    )


def _build_computer_use_plan(*, intent_id: str, prompt: str, model_id: str | None) -> AutomationPlan:
    return AutomationPlan(
        plan_id=str(uuid.uuid4()),
        intent_id=intent_id,
        execution_mode="immediate",
        summary=prompt,
        source_prompt=prompt,
        model_id=model_id,
        targets=[AutomationTarget(target_type="browser_session")],
        steps=[
            AutomationStep(
                step_id="computer-use",
                kind="unknown",
                label="Gemini computer use execution",
                description="Gemini computer use will observe the browser and take the next action directly.",
                status="pending",
            )
        ],
        requires_confirmation=False,
    )


async def _has_live_browser(user_id: str, browser_session_id: str | None) -> bool:
    if not browser_session_id:
        return False
    sessions = await browser_session_manager.list_sessions(user_id=user_id)
    for session in sessions:
        if str(getattr(session, "session_id", "") or "") != str(browser_session_id):
            continue
        metadata = dict(getattr(session, "metadata", {}) or {})
        cdp_url = str(metadata.get("cdp_url", "") or "").strip()
        if cdp_url:
            return True
    metadata = await get_browser_session(browser_session_id)
    cdp_url = str((metadata or {}).get("cdp_url", "") or "").strip()
    return bool(cdp_url)


async def _live_browser_origin(user_id: str, browser_session_id: str | None) -> str | None:
    if not browser_session_id:
        return None
    sessions = await browser_session_manager.list_sessions(user_id=user_id)
    for session in sessions:
        if str(getattr(session, "session_id", "") or "") != str(browser_session_id):
            continue
        metadata = dict(getattr(session, "metadata", {}) or {})
        cdp_url = str(metadata.get("cdp_url", "") or "").strip()
        if cdp_url:
            return str(getattr(session, "origin", "") or "") or None
    return None


async def _ensure_browser_session(
    user_id: str,
    browser_target: str,
    *,
    conversation_browser_session_id: str | None = None,
) -> tuple[str | None, str]:
    normalized_target = str(browser_target or "auto").strip() or "auto"
    existing_conversation_browser = str(conversation_browser_session_id or "").strip() or None
    existing_origin = await _live_browser_origin(user_id, existing_conversation_browser)
    if existing_origin and await _has_live_browser(user_id, existing_conversation_browser):
        if normalized_target == "my_browser" and existing_origin == "local_runner":
            return existing_conversation_browser, "local_runner"
        if normalized_target == "managed_browser" and existing_origin == "server_runner":
            return existing_conversation_browser, "server_runner"
        if normalized_target == "auto":
            return existing_conversation_browser, ("local_runner" if existing_origin == "local_runner" else "server_runner")

    browser_session_id, executor_mode = await _select_browser_session(user_id, browser_target)
    if normalized_target == "my_browser":
        if browser_session_id and await _has_live_browser(user_id, browser_session_id):
            return browser_session_id, executor_mode
        return None, "local_runner"

    if normalized_target == "managed_browser":
        if browser_session_id and executor_mode == "server_runner" and await _has_live_browser(user_id, browser_session_id):
            return browser_session_id, executor_mode
        session = await server_browser_runner.ensure_session(
            user_id=user_id,
            prefer_visible=True,
            force_new=False,
        )
        return session.session_id, "server_runner"

    if browser_session_id and executor_mode == "local_runner" and await _has_live_browser(user_id, browser_session_id):
        return browser_session_id, executor_mode

    if browser_target == "my_browser":
        return None, "local_runner"

    session = await server_browser_runner.ensure_session(
        user_id=user_id,
        prefer_visible=True,
        force_new=False,
    )
    return session.session_id, "server_runner"


def _browser_target_failure_copy(browser_target: str) -> str:
    if browser_target == "my_browser":
        return "I couldn't find your browser. Open or attach your browser first, or switch the browser target to Managed browser."
    if browser_target == "managed_browser":
        return "I couldn't prepare a managed browser right now. Please retry in a moment."
    return "I couldn't prepare a browser session right now. Please retry in a moment."


async def handle_computer_use_request(payload: ComputerUseExecuteRequest, user_id: str) -> ComputerUseExecuteResponse:
    if not settings.enable_computer_use:
        raise HTTPException(status_code=403, detail="Computer use is disabled.")
    session_id = payload.session_id
    conversation_id = payload.conversation_id or session_id
    text = payload.prompt.strip()
    model_id = payload.client_context.model
    browser_target = str(payload.client_context.browser_target or "auto").strip() or "auto"
    if not text:
        raise HTTPException(status_code=400, detail="Computer use requires a text command.")

    task = await load_conversation_task_by_conversation_id(user_id, conversation_id)
    if task is None and not payload.conversation_id:
        task = await load_conversation_task(user_id, session_id)
    if task is None:
        await create_conversation_record(
            user_id=user_id,
            title=text[:80] or "Computer use",
            session_id=session_id,
            model_id=model_id,
            automation_engine="computer_use",
            conversation_id=conversation_id,
        )
        task = await create_conversation_task(
            user_id=user_id,
            conversation_id=conversation_id,
            session_id=session_id,
            goal=text,
            model_id=model_id,
            automation_engine="computer_use",
            timezone=payload.client_context.timezone or "UTC",
        )
    else:
        if task.conversation_id != conversation_id:
            task.conversation_id = conversation_id
        if model_id:
            task.model_id = model_id
        task.automation_engine = "computer_use"

    existing_conversation = await load_conversation(user_id, conversation_id)
    if existing_conversation is None:
        await create_conversation_record(
            user_id=user_id,
            title=text[:80] or "Computer use",
            session_id=session_id,
            model_id=model_id or task.model_id,
            automation_engine="computer_use",
            conversation_id=conversation_id,
        )

    await _save_turn(session_id, user_id, "user", text)
    task.user_goal = text
    task.resolved_goal = text
    task.automation_engine = "computer_use"
    if model_id:
        task.model_id = model_id

    intake = await resolve_computer_use_intake(
        prompt=text,
        timezone=payload.client_context.timezone or "UTC",
    )

    if intake.needs_clarification:
        assistant_text = intake.assistant_reply or intake.clarification_question or "Tell me exactly when you want this to run."
        task.last_assistant_message = assistant_text
        task.phase = "collecting_requirements"
        task.status = "active"
        await save_task(task)
        await _save_turn(session_id, user_id, "assistant", assistant_text)
        return ComputerUseExecuteResponse(
            conversation_id=conversation_id,
            session_id=session_id,
            assistant_text=assistant_text,
            status="clarification",
            requires_clarification=True,
        )

    browser_session_id, executor_mode = await _ensure_browser_session(
        user_id,
        browser_target,
        conversation_browser_session_id=task.execution.browser_session_id,
    )
    if not browser_session_id:
        assistant_text = _browser_target_failure_copy(browser_target)
        task.last_assistant_message = assistant_text
        task.phase = "awaiting_user_action"
        task.status = "active"
        await save_task(task)
        await _save_turn(session_id, user_id, "assistant", assistant_text)
        return ComputerUseExecuteResponse(
            conversation_id=conversation_id,
            session_id=session_id,
            assistant_text=assistant_text,
        )

    if intake.execution_mode != "immediate":
        schedule = await create_automation_schedule(
            user_id=user_id,
            payload=AutomationScheduleCreateRequest(
                session_id=session_id,
                prompt=text,
                execution_mode=intake.execution_mode,
                executor_mode=executor_mode,  # type: ignore[arg-type]
                automation_engine="computer_use",
                browser_session_id=browser_session_id,
                schedule=ResolveExecutionSchedule(
                    run_at=list(intake.run_at),
                    interval_seconds=intake.interval_seconds,
                    timezone=payload.client_context.timezone or "UTC",
                ),
                device_id=payload.client_context.device_id,
                tab_id=payload.client_context.tab_id,
            ),
        )
        assistant_text = intake.assistant_reply or "I’ve scheduled that computer-use task."
        task.phase = "scheduled"
        task.status = "scheduled"
        task.active_run_id = None
        task.last_assistant_message = assistant_text
        await save_task(task)
        await _save_turn(session_id, user_id, "assistant", assistant_text)
        return ComputerUseExecuteResponse(
            conversation_id=conversation_id,
            session_id=session_id,
            assistant_text=assistant_text,
            status="scheduled",
            schedule_ids=[schedule.schedule_id],
        )

    plan = _build_computer_use_plan(intent_id=task.legacy_intent_id, prompt=text, model_id=model_id)
    plan_payload = plan.model_dump(mode="json")
    plan_payload["user_id"] = user_id
    plan_payload["_saved_at"] = _now_iso()
    await save_plan(plan.plan_id, plan_payload)
    run = await create_run_for_plan(
        user_id=user_id,
        session_id=session_id,
        plan=plan,
        execution_mode="immediate",
        initial_state="queued",
        executor_mode=executor_mode,
        automation_engine="computer_use",
        browser_session_id=browser_session_id,
    )
    task.active_run_id = run.run_id
    task.phase = "executing"
    task.status = "executing"
    task.execution.browser_session_id = browser_session_id
    assistant_text = intake.assistant_reply or "Gemini computer use is taking over the browser now."
    task.last_assistant_message = assistant_text
    await save_task(task)
    await _save_turn(session_id, user_id, "assistant", assistant_text)
    await start_execution(run.run_id)
    return ComputerUseExecuteResponse(
        conversation_id=conversation_id,
        session_id=session_id,
        assistant_text=assistant_text,
        status="running",
        run_id=run.run_id,
    )
