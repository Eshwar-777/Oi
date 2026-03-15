from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException

from oi_agent.automation.conversation_response import build_chat_turn_response, conversation_summary_from_sources
from oi_agent.automation.conversation_store import (
    create_conversation_record,
    create_conversation_task,
    load_conversation,
    load_conversation_task,
    save_task,
)
from oi_agent.automation.models import AutomationPlan, AutomationRun, AutomationStep, AutomationTarget, ChatTurnRequest, ChatTurnResponse
from oi_agent.automation.run_service import create_run_for_plan
from oi_agent.automation.store import get_run, list_session_turns, save_plan, save_session_turn
from oi_agent.automation.executor import start_execution
from oi_agent.automation.conversation_service import _select_browser_session
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


async def handle_computer_use_turn(payload: ChatTurnRequest, user_id: str) -> ChatTurnResponse:
    if not settings.enable_computer_use:
        raise HTTPException(status_code=403, detail="Computer use is disabled.")
    session_id = payload.session_id
    conversation_id = payload.conversation_id or session_id
    text = " ".join(str(item.text or "").strip() for item in payload.inputs if item.type == "text").strip()
    model_id = payload.client_context.model
    if not text:
        raise HTTPException(status_code=400, detail="Computer use requires a text command.")

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

    browser_session_id, executor_mode = await _select_browser_session(user_id)
    if not browser_session_id:
        assistant_text = "Attach a browser session to use Gemini computer use."
        task.last_assistant_message = assistant_text
        await save_task(task)
        await _save_turn(session_id, user_id, "assistant", assistant_text)
        turns = await list_session_turns(user_id, session_id, limit=100)
        return build_chat_turn_response(
            task,
            assistant_text,
            conversation_meta=conversation_summary_from_sources(task=task, turns=turns, active_run=None),
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
    assistant_text = "Gemini computer use is taking over the browser now."
    task.last_assistant_message = assistant_text
    await save_task(task)
    await _save_turn(session_id, user_id, "assistant", assistant_text)
    await start_execution(run.run_id)

    turns = await list_session_turns(user_id, session_id, limit=100)
    active_run: AutomationRun | None = None
    raw_run = await get_run(run.run_id)
    if raw_run:
        active_run = AutomationRun.model_validate(raw_run)
    return build_chat_turn_response(
        task,
        assistant_text,
        conversation_meta=conversation_summary_from_sources(task=task, turns=turns, active_run=active_run),
    )
