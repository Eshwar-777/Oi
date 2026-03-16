from __future__ import annotations

import asyncio

import pytest

from oi_agent.automation.conversation_service import _session_turn_lock, handle_chat_turn
from oi_agent.automation.conversation_task import (
    AssistantReplyPayload,
    ConversationResolution,
    ConversationTask,
)
from oi_agent.automation.models import (
    AutomationRun,
    BrowserStateSnapshot,
    ChatTurnRequest,
    ClientContext,
    ExecutionProgress,
    InputPart,
    RunProgressTracker,
)


async def _acquire_and_record(session_id: str, order: list[str], name: str, delay: float = 0.0) -> None:
    await asyncio.sleep(delay)
    async with _session_turn_lock(session_id):
        order.append(f"{name}:enter")
        await asyncio.sleep(0.01)
        order.append(f"{name}:exit")


def test_session_turn_lock_serializes_same_session_requests() -> None:
    order: list[str] = []

    async def run() -> None:
        await asyncio.gather(
            _acquire_and_record("session-1", order, "first"),
            _acquire_and_record("session-1", order, "second", delay=0.001),
        )

    asyncio.run(run())

    assert order == ["first:enter", "first:exit", "second:enter", "second:exit"]


def test_session_turn_lock_allows_independent_sessions() -> None:
    first = _session_turn_lock("session-a")
    second = _session_turn_lock("session-b")

    assert first is not second


@pytest.mark.asyncio
async def test_handle_chat_turn_returns_active_run_without_followup_session_refresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task = ConversationTask(
        task_id="task-1",
        conversation_id="session-1",
        legacy_intent_id="intent-1",
        session_id="session-1",
        user_id="dev-user",
        user_goal="Buy a shirt",
        resolved_goal="Buy a shirt",
        goal_type="ui_automation",
        created_at="2026-03-14T00:00:00+00:00",
        updated_at="2026-03-14T00:00:00+00:00",
    )
    run = AutomationRun(
        run_id="run-1",
        user_id="dev-user",
        intent_id="intent-1",
        session_id="session-1",
        plan_id="plan-1",
        state="queued",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-session-1",
        phase_states=[],
        progress_tracker=RunProgressTracker(),
        execution_progress=ExecutionProgress(),
        browser_snapshot=BrowserStateSnapshot(captured_at="2026-03-14T00:00:00+00:00"),
        created_at="2026-03-14T00:00:00+00:00",
        updated_at="2026-03-14T00:00:00+00:00",
    )

    async def fake_hydrate(*args, **kwargs):
        _ = args, kwargs
        return None

    async def fake_ensure_conversation_record(**kwargs):
        _ = kwargs
        return None

    async def fake_create_conversation_task(**kwargs):
        _ = kwargs
        return task

    async def fake_save_turn(*args, **kwargs):
        _ = args, kwargs
        return None

    async def fake_resolve_turn(*args, **kwargs):
        _ = args, kwargs
        return ConversationResolution(
            assistant_reply=AssistantReplyPayload(text="Queued"),
            task_patch={},
            next_phase="executing",
            action_request="execute",
        )

    async def fake_handle_action(current_task, action_request, next_phase, user_id):
        _ = action_request, next_phase, user_id
        current_task.active_run_id = run.run_id
        current_task.phase = "executing"
        current_task.status = "executing"
        return "Queued"

    async def fake_sync_phase_from_run(current_task):
        current_task.phase = "executing"
        current_task.status = "executing"

    async def fake_save_task(*args, **kwargs):
        _ = args, kwargs
        return None

    async def fake_sync_conversation_record(*args, **kwargs):
        _ = args, kwargs
        return None

    async def fake_persist_legacy_intent(*args, **kwargs):
        _ = args, kwargs
        return None

    async def fake_list_session_turns(*args, **kwargs):
        _ = args, kwargs
        return []

    class _RunResponse:
        def __init__(self, current_run: AutomationRun) -> None:
            self.run = current_run

    async def fake_get_run_response(*args, **kwargs):
        _ = args, kwargs
        return _RunResponse(run)

    monkeypatch.setattr("oi_agent.automation.conversation_service._hydrate_task_from_legacy", fake_hydrate)
    monkeypatch.setattr("oi_agent.automation.conversation_service._ensure_conversation_record", fake_ensure_conversation_record)
    monkeypatch.setattr("oi_agent.automation.conversation_service.create_conversation_task", fake_create_conversation_task)
    monkeypatch.setattr("oi_agent.automation.conversation_service._save_turn", fake_save_turn)
    monkeypatch.setattr("oi_agent.automation.conversation_service.resolve_turn", fake_resolve_turn)
    monkeypatch.setattr("oi_agent.automation.conversation_service._handle_action", fake_handle_action)
    monkeypatch.setattr("oi_agent.automation.conversation_service._sync_phase_from_run", fake_sync_phase_from_run)
    monkeypatch.setattr("oi_agent.automation.conversation_service.save_task", fake_save_task)
    monkeypatch.setattr("oi_agent.automation.conversation_service._sync_conversation_record", fake_sync_conversation_record)
    monkeypatch.setattr("oi_agent.automation.conversation_service._persist_legacy_intent", fake_persist_legacy_intent)
    monkeypatch.setattr("oi_agent.automation.conversation_service.list_session_turns", fake_list_session_turns)
    monkeypatch.setattr("oi_agent.automation.conversation_service.get_run_response", fake_get_run_response)

    response = await handle_chat_turn(
        ChatTurnRequest(
            session_id="session-1",
            inputs=[InputPart(type="text", text="Buy a shirt")],
            client_context=ClientContext(timezone="UTC"),
        ),
        user_id="dev-user",
    )

    assert response.conversation.phase == "executing"
    assert response.active_run is not None
    assert response.active_run.run_id == "run-1"
