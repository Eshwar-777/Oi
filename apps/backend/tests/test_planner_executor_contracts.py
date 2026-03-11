from __future__ import annotations

import pytest

from oi_agent.automation.conversation_service import _sync_phase_from_run
from oi_agent.automation.conversation_task import ConversationTask
from oi_agent.automation.planner_service import build_plan_from_prompt
from oi_agent.automation.store import save_run
from oi_agent.services.tools import step_planner as step_planner_module


@pytest.mark.asyncio
async def test_build_plan_from_prompt_includes_execution_contract_and_predicted_plan() -> None:
    plan = await build_plan_from_prompt(
        user_id="dev-user",
        prompt="Send an email to yandrapueeshwar2000@gmail.com with a short hello",
        execution_mode="immediate",
        app_name="Gmail",
        intent_id="intent-contract-1",
    )

    assert plan.execution_contract is not None
    assert plan.execution_contract.resolved_goal == "Send an email to yandrapueeshwar2000@gmail.com with a short hello"
    assert plan.execution_contract.target_app == "Gmail"
    assert plan.predicted_plan is not None
    assert plan.predicted_plan.advisory is True
    assert len(plan.predicted_plan.phases) >= 3
    if plan.execution_brief is not None:
        assert plan.execution_brief.workflow_phases == [phase.label for phase in plan.predicted_plan.phases]


@pytest.mark.asyncio
async def test_plan_runtime_action_maps_planner_output(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_plan_browser_steps(**kwargs):
        _ = kwargs
        return {
            "status": "OK",
            "summary": "Click the compose button.",
            "steps": [
                {
                    "type": "browser",
                    "id": "s1",
                    "command": "click",
                    "description": "Click Compose",
                    "target": {"ref": "e11"},
                }
            ],
        }

    monkeypatch.setattr(step_planner_module, "plan_browser_steps", fake_plan_browser_steps)

    result = await step_planner_module.plan_runtime_action(
        execution_contract={"resolved_goal": "Compose a new email"},
        current_url="https://mail.google.com",
        current_page_title="Inbox",
    )

    assert result.status == "action"
    assert result.step is not None
    assert result.step.command == "click"
    assert result.summary == "Click the compose button."


@pytest.mark.asyncio
async def test_plan_runtime_action_maps_next_action_observation_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_plan_browser_steps(**kwargs):
        _ = kwargs
        return {
            "status": "OK",
            "summary": "Need a fresh snapshot before interacting.",
            "steps": [
                {
                    "type": "browser",
                    "command": "snapshot",
                    "description": "Need a fresh snapshot before interacting.",
                    "target": {"snapshotFormat": "ai", "targetId": "tab:1"},
                    "page_ref": "tab:1",
                }
            ],
        }

    monkeypatch.setattr(step_planner_module, "plan_browser_steps", fake_plan_browser_steps)

    result = await step_planner_module.plan_runtime_action(
        execution_contract={"resolved_goal": "Open the compose dialog"},
        current_url="https://mail.google.com",
        current_page_title="Inbox",
    )

    assert result.status == "action"
    assert result.step is not None
    assert result.step.command == "snapshot"
    assert result.step.page_ref == "tab:1"


@pytest.mark.asyncio
async def test_plan_runtime_action_maps_confirmation_block(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_plan_browser_steps(**kwargs):
        _ = kwargs
        return {
            "status": "NEEDS_CONFIRMATION",
            "summary": "This action requires confirmation.",
            "steps": [],
        }

    monkeypatch.setattr(step_planner_module, "plan_browser_steps", fake_plan_browser_steps)

    result = await step_planner_module.plan_runtime_action(
        execution_contract={"resolved_goal": "Send the email"},
        current_url="https://mail.google.com",
        current_page_title="Inbox",
    )

    assert result.status == "blocked"
    assert result.block is not None
    assert result.block.reason == "confirmation_required"
    assert result.block.reason_code == "planner_requires_confirmation"
    assert result.block.requires_confirmation is True


@pytest.mark.asyncio
async def test_sync_phase_from_run_uses_execution_progress_interruption() -> None:
    task = ConversationTask(
        task_id="task-1",
        legacy_intent_id="intent-1",
        session_id="sess-1",
        user_id="dev-user",
        user_goal="Send an email",
        resolved_goal="Send an email",
        created_at="2026-03-10T00:00:00+00:00",
        updated_at="2026-03-10T00:00:00+00:00",
    )
    task.active_run_id = "run-1"

    await save_run(
        "run-1",
        {
            "run_id": "run-1",
            "plan_id": "plan-1",
            "session_id": "sess-1",
            "user_id": "dev-user",
            "state": "waiting_for_user_action",
            "execution_mode": "immediate",
            "executor_mode": "local_runner",
            "automation_engine": "agent_browser",
            "created_at": "2026-03-10T00:00:00+00:00",
            "updated_at": "2026-03-10T00:00:00+00:00",
            "execution_progress": {
                "interruption": {
                    "reason": "needs_input",
                    "reason_code": "planner_requires_user_reply",
                    "message": "Please pick the correct search result, then reply done.",
                    "requires_user_reply": True,
                    "requires_confirmation": False,
                    "retriable": True,
                }
            },
        },
    )

    await _sync_phase_from_run(task)

    assert task.phase == "awaiting_user_action"
    assert task.status == "active"
    assert task.execution.active_run_action_needed == "planner_requires_user_reply"
    assert task.last_assistant_message == "Please pick the correct search result, then reply done."
