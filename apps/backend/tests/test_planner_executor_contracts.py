from __future__ import annotations

import pytest

from oi_agent.automation.conversation_service import _sync_phase_from_run
from oi_agent.automation.conversation_task import ConversationTask
from oi_agent.automation.executor import (
    _compute_phase_states,
    _rebuild_page_registry_from_session,
    _register_soft_runtime_incident,
    _runtime_failure_resolved_by_live_verification,
    _runtime_browser_observation_from_payload,
    _resolve_runtime_target_page,
    _runtime_code_to_run_error,
    _runtime_tool_progress_entry,
    _terminal_runtime_incident_from_events,
)
from oi_agent.automation.models import (
    AutomationRun,
    AutomationPlan,
    BrowserStateSnapshot,
    ExecutionContract,
    PredictedExecutionPlan,
    PredictedPhase,
    RuntimeIncident,
)
from oi_agent.automation.planner_service import build_plan_from_prompt
from oi_agent.automation.planner_service import _completion_signals_for_phase
from oi_agent.automation.run_service import get_run_response
from oi_agent.automation.store import save_plan, save_run
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
    assert "drafted or submitted" not in " ".join(plan.execution_contract.completion_criteria).lower()


@pytest.mark.asyncio
async def test_build_plan_from_prompt_requires_post_action_verification_for_send_tasks() -> None:
    plan = await build_plan_from_prompt(
        user_id="dev-user",
        prompt="Send an email to yandrapueshwar2000@gmail.com subject hi body how are you",
        execution_mode="immediate",
        app_name="Gmail",
        intent_id="intent-contract-2",
    )

    assert plan.execution_contract is not None
    criteria_text = " ".join(plan.execution_contract.completion_criteria).lower()
    verification_text = " ".join(plan.execution_contract.verification_evidence.checks).lower()
    assert "visible post-action state change confirms the action completed" in criteria_text
    assert "no longer showing the unsent draft" in criteria_text
    assert "editor or compose surface is no longer active" in verification_text


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


def test_completion_signals_include_target_for_search_and_filter_phases() -> None:
    entities = {
        "target": "maroon men's shirt",
        "body": "under ₹1000 in size M",
    }

    search_signals = _completion_signals_for_phase(
        "Search for 'maroon men's shirt'",
        entities,
        "Myntra",
    )
    filter_signals = _completion_signals_for_phase(
        "Apply price filter 'under ₹1000'",
        entities,
        "Myntra",
    )

    assert "maroon men's shirt" in search_signals
    assert "under ₹1000 in size M" in filter_signals


def test_compute_phase_states_advances_from_search_results_to_filter_phase() -> None:
    predicted_plan = PredictedExecutionPlan(
        summary="Find a maroon men's shirt on Myntra, filter by price and size, then choose a product.",
        advisory=True,
        generated_at="2026-03-13T00:00:00+00:00",
        phases=[
            PredictedPhase(
                phase_id="phase_1",
                label="Go to Myntra.com",
                goal="Go to Myntra.com",
                completion_signals=["Myntra"],
                advisory=True,
            ),
            PredictedPhase(
                phase_id="phase_2",
                label="Search for 'maroon men's shirt'",
                goal="Search for 'maroon men's shirt'",
                completion_signals=["maroon men's shirt", "Myntra"],
                advisory=True,
            ),
            PredictedPhase(
                phase_id="phase_3",
                label="Apply price filter: under 1000 rupees",
                goal="Apply price filter: under 1000 rupees",
                completion_signals=["under ₹1000 in size M", "maroon men's shirt"],
                advisory=True,
            ),
        ],
    )
    plan = AutomationPlan(
        plan_id="plan-1",
        intent_id="intent-1",
        execution_mode="immediate",
        summary=predicted_plan.summary,
        predicted_plan=predicted_plan,
    )

    active_phase_index, phase_states, phase_fact_evidence = _compute_phase_states(
        plan,
        fallback_active_phase_index=0,
        current_snapshot={"snapshot": "Myntra results for maroon men's shirt are visible."},
        current_url="https://www.myntra.com/maroon%20men's%20shirt",
        current_title="Maroon Shirt Men - Buy Maroon Shirt Men online in India",
    )

    assert active_phase_index == 2
    assert phase_states[0].status == "completed"
    assert phase_states[1].status == "completed"
    assert phase_states[2].status == "active"
    assert phase_fact_evidence["0"]
    assert phase_fact_evidence["1"]


def test_compute_phase_states_reconciles_terminal_email_phases_from_execution_facts() -> None:
    predicted_plan = PredictedExecutionPlan(
        summary="Send an email in Gmail.",
        advisory=True,
        generated_at="2026-03-13T00:00:00+00:00",
        phases=[
            PredictedPhase(phase_id="p1", label="Go to Gmail", completion_signals=["gmail"], advisory=True),
            PredictedPhase(phase_id="p2", label="Compose a new email", completion_signals=["compose"], advisory=True),
            PredictedPhase(
                phase_id="p3",
                label="Enter recipient: yandrapueshwar2000@gmail.com",
                completion_signals=["yandrapueshwar2000@gmail.com"],
                advisory=True,
            ),
            PredictedPhase(phase_id="p4", label="Enter subject: hi", completion_signals=["hi"], advisory=True),
            PredictedPhase(phase_id="p5", label="Enter body: how are you", completion_signals=["how are you"], advisory=True),
            PredictedPhase(phase_id="p6", label="Send the email", completion_signals=["send"], advisory=True),
        ],
    )
    plan = AutomationPlan(
        plan_id="plan-gmail",
        intent_id="intent-gmail",
        execution_mode="immediate",
        summary=predicted_plan.summary,
        predicted_plan=predicted_plan,
    )

    active_phase_index, phase_states, phase_fact_evidence = _compute_phase_states(
        plan,
        fallback_active_phase_index=3,
        current_snapshot={"snapshot": "Inbox is visible after sending the message."},
        current_url="https://mail.google.com/mail/u/0/#inbox",
        current_title="Inbox - user@gmail.com - Gmail",
        recent_action_log=[
            {"label": "Type recipient", "message": 'I finished: Type "yandrapueshwar2000@gmail.com".', "status": "completed"},
            {"label": "Type subject", "message": 'I finished: Type "hi".', "status": "completed"},
            {"label": "Type body", "message": 'I finished: Type "how are you".', "status": "completed"},
            {"label": "Send email", "message": "I finished: Send the email.", "status": "completed"},
        ],
        status_summary="I finished: Send the email.",
        run_state="completed",
    )

    assert active_phase_index is None
    assert [phase.status for phase in phase_states] == [
        "completed",
        "completed",
        "completed",
        "completed",
        "completed",
        "completed",
    ]
    assert "action:hi" in phase_fact_evidence["3"]
    assert "action:how are you" in phase_fact_evidence["4"]


def test_compute_phase_states_does_not_mark_send_complete_from_unsent_compose_snapshot() -> None:
    predicted_plan = PredictedExecutionPlan(
        summary="Send an email in Gmail.",
        advisory=True,
        generated_at="2026-03-13T00:00:00+00:00",
        phases=[
            PredictedPhase(phase_id="p1", label="Go to Gmail", completion_signals=["gmail"], advisory=True),
            PredictedPhase(phase_id="p2", label="Compose a new email", completion_signals=["compose"], advisory=True),
            PredictedPhase(
                phase_id="p3",
                label="Set recipient to yandrapueshwar2000@gmail.com",
                completion_signals=["yandrapueshwar2000@gmail.com"],
                advisory=True,
            ),
            PredictedPhase(phase_id="p4", label="Set subject to hi", completion_signals=["hi"], advisory=True),
            PredictedPhase(phase_id="p5", label="Set body to how are you", completion_signals=["how are you"], advisory=True),
            PredictedPhase(phase_id="p6", label="Send the email", completion_signals=["send"], advisory=True),
        ],
    )
    plan = AutomationPlan(
        plan_id="plan-compose-draft",
        intent_id="intent-compose-draft",
        execution_mode="immediate",
        summary=predicted_plan.summary,
        predicted_plan=predicted_plan,
    )

    active_phase_index, phase_states, phase_fact_evidence = _compute_phase_states(
        plan,
        fallback_active_phase_index=1,
        current_snapshot={
            "snapshot": (
                "Compose:\nhi\nyandrapueshwar2000@gmail.com\nhow are you\n"
                "Interactive refs:\n[e10] textbox \"Message Body\"\n[e26] button \"Send\""
            )
        },
        current_url="https://mail.google.com/mail/u/0/#inbox?compose=abc123",
        current_title="Inbox - Gmail",
        run_state="running",
    )

    assert active_phase_index == 5
    assert [phase.status for phase in phase_states] == [
        "completed",
        "completed",
        "completed",
        "completed",
        "completed",
        "active",
    ]
    assert "5" not in phase_fact_evidence


def test_compute_phase_states_terminal_failure_uses_explicit_execution_facts_only() -> None:
    predicted_plan = PredictedExecutionPlan(
        summary="Send an email in Gmail.",
        advisory=True,
        generated_at="2026-03-13T00:00:00+00:00",
        phases=[
            PredictedPhase(phase_id="p1", label="Go to Gmail", completion_signals=["gmail"], advisory=True),
            PredictedPhase(phase_id="p2", label="Compose a new email", completion_signals=["compose"], advisory=True),
            PredictedPhase(
                phase_id="p3",
                label="Set recipient to yandrapueshwar2000@gmail.com",
                completion_signals=["yandrapueshwar2000@gmail.com"],
                advisory=True,
            ),
            PredictedPhase(phase_id="p4", label="Set subject to hi", completion_signals=["hi"], advisory=True),
            PredictedPhase(phase_id="p5", label="Set body to how are you", completion_signals=["how are you"], advisory=True),
            PredictedPhase(
                phase_id="p6",
                label="Send the email",
                completion_signals=["how are you", "yandrapueshwar2000@gmail.com"],
                advisory=True,
            ),
        ],
    )
    plan = AutomationPlan(
        plan_id="plan-failed-compose",
        intent_id="intent-failed-compose",
        execution_mode="immediate",
        summary=predicted_plan.summary,
        predicted_plan=predicted_plan,
    )

    active_phase_index, phase_states, phase_fact_evidence = _compute_phase_states(
        plan,
        fallback_active_phase_index=0,
        current_snapshot={
            "snapshot": (
                "Inbox - Gmail\n"
                "yandrapueshwar2000@gmail.com\n"
                "hi\n"
                "how are you\n"
                'textbox "Message Body"\n'
                'button "Send"'
            )
        },
        current_url="https://mail.google.com/mail/u/0/#inbox?compose=new",
        current_title="Inbox - Gmail",
        recent_action_log=[
            {"label": "Open Gmail", "message": "I opened https://mail.google.com/mail/u/0/#inbox.", "status": "completed", "command": "navigate"},
            {"label": 'Type "yandrapueshwar2000@gmail.com"', "message": 'I finished: Type "yandrapueshwar2000@gmail.com".', "status": "completed", "command": "type"},
            {"label": "Fill the current form", "message": "I finished: Fill the current form.", "status": "completed", "command": "fill"},
            {"label": "Click the current page control", "message": "I hit an issue while working on: Click the current page control.", "status": "failed", "command": "click"},
        ],
        status_summary="The run is still stuck on the same page after retrying once.",
        run_state="failed",
    )

    assert active_phase_index == 3
    assert [phase.status for phase in phase_states] == [
        "completed",
        "completed",
        "completed",
        "blocked",
        "pending",
        "pending",
    ]
    assert phase_fact_evidence["2"] == ["action:yandrapueshwar2000@gmail.com"]
    assert "0" not in phase_fact_evidence
    assert "1" not in phase_fact_evidence
    assert "3" not in phase_fact_evidence
    assert "5" not in phase_fact_evidence


def test_compute_phase_states_marks_all_phases_complete_after_verified_terminal_success() -> None:
    predicted_plan = PredictedExecutionPlan(
        summary="Send an email in Gmail.",
        advisory=True,
        generated_at="2026-03-13T00:00:00+00:00",
        phases=[
            PredictedPhase(phase_id="p1", label="Go to Gmail", completion_signals=["gmail"], advisory=True),
            PredictedPhase(phase_id="p2", label="Compose a new email", completion_signals=["compose"], advisory=True),
            PredictedPhase(phase_id="p3", label="Enter recipient", completion_signals=["yandrapueshwar2000@gmail.com"], advisory=True),
            PredictedPhase(phase_id="p4", label="Send the email", completion_signals=["sent"], advisory=True),
        ],
    )
    plan = AutomationPlan(
        plan_id="plan-terminal-success",
        intent_id="intent-terminal-success",
        execution_mode="immediate",
        summary=predicted_plan.summary,
        predicted_plan=predicted_plan,
    )

    active_phase_index, phase_states, _ = _compute_phase_states(
        plan,
        fallback_active_phase_index=1,
        current_snapshot={"snapshot": "Inbox is visible."},
        current_url="https://mail.google.com/mail/u/0/#inbox",
        current_title="Inbox - Gmail",
        run_state="completed",
    )

    assert active_phase_index is None
    assert [phase.status for phase in phase_states] == [
        "completed",
        "completed",
        "completed",
        "completed",
    ]


@pytest.mark.asyncio
async def test_runtime_failure_is_overridden_by_live_browser_success_even_with_generic_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = AutomationPlan(
        plan_id="plan-runtime-verify",
        intent_id="intent-runtime-verify",
        execution_mode="immediate",
        summary="Send an email immediately.",
        execution_contract=ExecutionContract(
            contract_id="contract-runtime-verify",
            resolved_goal="Send an email immediately.",
            completion_criteria=["A visible post-action state change confirms the action completed."],
        ),
    )

    async def fake_capture_agent_browser_visual_context(**kwargs):  # type: ignore[no-untyped-def]
        _ = kwargs
        return (
            BrowserStateSnapshot(
                captured_at="2026-03-13T00:00:00+00:00",
                url="https://mail.google.com/mail/u/0/#inbox",
                title="Inbox - Gmail",
            ),
            {
                "url": "https://mail.google.com/mail/u/0/#inbox",
                "title": "Inbox - Gmail",
                "bodyText": "Sent",
                "editableFields": [],
                "editableCount": 0,
                "dialogCount": 0,
                "buttons": [],
            },
        )

    monkeypatch.setattr(
        "oi_agent.automation.executor._capture_agent_browser_visual_context",
        fake_capture_agent_browser_visual_context,
    )

    resolved = await _runtime_failure_resolved_by_live_verification(
        run_id="run-runtime-verify",
        cdp_url="http://127.0.0.1:9222",
        plan=plan,
        page_registry={},
        active_page_ref=None,
        runtime_observation=None,
        runtime_text="",
        runtime_error="An unknown error occurred",
    )

    assert resolved is True


@pytest.mark.asyncio
async def test_get_run_response_backfills_reconciled_phases_for_stale_gmail_run() -> None:
    predicted_plan = PredictedExecutionPlan(
        summary="Send an email in Gmail.",
        advisory=True,
        generated_at="2026-03-13T00:00:00+00:00",
        phases=[
            PredictedPhase(phase_id="p1", label="Go to Gmail", completion_signals=["gmail"], advisory=True),
            PredictedPhase(phase_id="p2", label="Compose a new email", completion_signals=["compose"], advisory=True),
            PredictedPhase(
                phase_id="p3",
                label="Enter recipient yandrapueshwar2000@gmail.com",
                completion_signals=["yandrapueshwar2000@gmail.com"],
                advisory=True,
            ),
            PredictedPhase(phase_id="p4", label="Enter subject 'hi'", completion_signals=["hi"], advisory=True),
            PredictedPhase(phase_id="p5", label="Enter body 'how are you'", completion_signals=["how are you"], advisory=True),
            PredictedPhase(phase_id="p6", label="Send the email", completion_signals=["send"], advisory=True),
        ],
    )
    plan = AutomationPlan(
        plan_id="plan-stale-gmail",
        intent_id="intent-stale-gmail",
        execution_mode="immediate",
        summary=predicted_plan.summary,
        predicted_plan=predicted_plan,
    )
    raw_plan = plan.model_dump(mode="json")
    raw_plan["user_id"] = "dev-user"
    await save_plan(plan.plan_id, raw_plan)

    stale_run = AutomationRun(
        run_id="run-stale-gmail",
        plan_id=plan.plan_id,
        session_id="session-stale-gmail",
        user_id="dev-user",
        state="failed",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        current_step_index=None,
        total_steps=0,
        created_at="2026-03-13T18:30:41.000000+00:00",
        updated_at="2026-03-13T18:30:41.000000+00:00",
        active_phase_index=3,
        phase_states=[
            {"phase_index": 0, "label": "Go to Gmail", "status": "completed"},
            {"phase_index": 1, "label": "Compose a new email", "status": "completed"},
            {"phase_index": 2, "label": "Enter recipient yandrapueshwar2000@gmail.com", "status": "completed"},
            {"phase_index": 3, "label": "Enter subject 'hi'", "status": "active"},
            {"phase_index": 4, "label": "Enter body 'how are you'", "status": "pending"},
            {"phase_index": 5, "label": "Send the email", "status": "completed"},
        ],
        execution_progress={
            "predicted_phases": [
                {"phase_index": 0, "label": "Go to Gmail", "status": "completed"},
                {"phase_index": 1, "label": "Compose a new email", "status": "completed"},
                {"phase_index": 2, "label": "Enter recipient yandrapueshwar2000@gmail.com", "status": "completed"},
                {"phase_index": 3, "label": "Enter subject 'hi'", "status": "active"},
                {"phase_index": 4, "label": "Enter body 'how are you'", "status": "pending"},
                {"phase_index": 5, "label": "Send the email", "status": "completed"},
            ],
            "active_phase_index": 3,
            "recent_action_log": [
                {"message": 'I finished: Type "yandrapueshwar2000@gmail.com".', "status": "completed"},
                {"message": 'I finished: Type "hi".', "status": "completed"},
                {"message": 'I finished: Type "how are you".', "status": "completed"},
                {"message": "I finished: Send the email.", "status": "completed"},
            ],
            "status_summary": "I finished: Send the email.",
        },
    )
    raw_run = stale_run.model_dump(mode="json")
    raw_run["user_id"] = "dev-user"
    await save_run(stale_run.run_id, raw_run)

    response = await get_run_response("dev-user", stale_run.run_id)

    assert response.run.execution_progress.reconciled_phases
    assert [phase.status for phase in response.run.phase_states] == [
        "completed",
        "completed",
        "completed",
        "completed",
        "completed",
        "completed",
    ]


def test_runtime_tool_progress_entry_is_human_readable_for_search_actions() -> None:
    type_entry = _runtime_tool_progress_entry(
        payload={
            "toolName": "browser",
            "toolCallId": "browser_1",
            "args": {"action": "type", "text": "maroon men's shirt", "ref": "e9"},
        },
        status="completed",
    )
    press_entry = _runtime_tool_progress_entry(
        payload={
            "toolName": "browser",
            "toolCallId": "browser_2",
            "args": {"action": "press", "key": "Enter", "ref": "e9"},
        },
        status="completed",
    )

    assert type_entry["label"] == 'Type "maroon men\'s shirt"'
    assert type_entry["message"] == 'I finished: Type "maroon men\'s shirt".'
    assert press_entry["label"] == "Submit the current input"
    assert press_entry["message"] == "I finished: Submit the current input."


def test_runtime_browser_observation_does_not_blend_across_targets() -> None:
    previous = {
        "url": "https://www.myntra.com/maroon-men-shirt",
        "title": "Maroon Shirt Men - Buy online",
        "targetId": "results-tab",
        "snapshot_text": "Results for maroon men's shirt",
    }

    observation = _runtime_browser_observation_from_payload(
        {
            "args": {"action": "snapshot"},
            "result": {
                "details": {
                    "targetId": "product-tab",
                    "title": "Buy Roadster Shirt | Myntra",
                },
                "content": [{"type": "text", "text": "Add to bag"}],
            },
        },
        previous,
    )

    assert observation["targetId"] == "product-tab"
    assert observation["title"] == "Buy Roadster Shirt | Myntra"
    assert observation["url"] is None
    assert observation["snapshot_text"] == "Add to bag"


def test_runtime_tool_progress_entry_reads_nested_browser_act_requests() -> None:
    click_entry = _runtime_tool_progress_entry(
        payload={
            "toolName": "browser",
            "toolCallId": "browser_3",
            "args": {
                "action": "act",
                "request": {"kind": "click", "ref": "e44"},
            },
            "meta": "kind click",
        },
        status="completed",
    )
    type_entry = _runtime_tool_progress_entry(
        payload={
            "toolName": "browser",
            "toolCallId": "browser_4",
            "args": {
                "action": "act",
                "request": {"kind": "type", "ref": "e9", "text": "maroon men's shirt"},
            },
            "meta": "kind type",
        },
        status="completed",
    )

    assert click_entry["label"] == "Click the current page control"
    assert click_entry["message"] == "I finished: Click the current page control."
    assert type_entry["label"] == 'Type "maroon men\'s shirt"'
    assert type_entry["message"] == 'I finished: Type "maroon men\'s shirt".'


def test_runtime_tool_progress_entry_reads_act_kind_from_meta_when_request_is_missing() -> None:
    click_entry = _runtime_tool_progress_entry(
        payload={
            "toolName": "browser",
            "toolCallId": "browser_meta_1",
            "args": {
                "action": "act",
                "ref": "e44",
            },
            "meta": "kind click",
        },
        status="completed",
    )

    assert click_entry["command"] == "click"
    assert click_entry["label"] == "Click the current page control"
    assert click_entry["message"] == "I finished: Click the current page control."


def test_rebuild_page_registry_from_live_session_prefers_current_active_tab() -> None:
    page_registry, active_page_ref = _rebuild_page_registry_from_session(
        session_row={
            "page_id": "page-live-2",
            "pages": [
                {
                    "page_id": "page-live-1",
                    "url": "https://www.myntra.com/",
                    "title": "Myntra",
                    "is_active": False,
                },
                {
                    "page_id": "page-live-2",
                    "url": "https://www.myntra.com/checkout/cart",
                    "title": "SHOPPING BAG",
                    "is_active": True,
                },
            ],
        },
        existing_registry={
            "page_7": {
                "page_id": "page-live-2",
                "url": "https://www.myntra.com/old",
                "title": "Old cart",
            }
        },
        existing_active_page_ref="page_0",
    )

    assert active_page_ref == "page_7"
    assert page_registry["page_7"]["url"] == "https://www.myntra.com/checkout/cart"
    assert page_registry["page_7"]["tab_index"] == 1


def test_register_soft_runtime_incident_promotes_repeated_no_progress_to_terminal() -> None:
    incident = RuntimeIncident(
        incident_id="incident-1",
        category="blocker",
        severity="warning",
        code="RUNTIME_NO_PROGRESS",
        summary="The browser appears stuck in the same visual state across multiple steps.",
        details="Repeated screenshot.",
        visible_signals=["same_screenshot_hash", "no_progress"],
        requires_human=False,
        replannable=True,
        user_visible=True,
        browser_snapshot=BrowserStateSnapshot(
            captured_at="2026-03-13T00:00:00+00:00",
            url="https://www.myntra.com/maroon-men-shirt",
            title="Myntra results",
            page_id="page_1",
        ),
        created_at="2026-03-13T00:00:00+00:00",
    )

    tracker, first_incident = _register_soft_runtime_incident(tracker={}, incident=incident)
    tracker, second_incident = _register_soft_runtime_incident(tracker=tracker, incident=incident)

    assert first_incident is not None
    assert first_incident.code == "RUNTIME_NO_PROGRESS"
    assert second_incident is not None
    assert second_incident.code == "RUNTIME_NO_PROGRESS_PERSISTED"
    assert second_incident.replannable is False


def test_resolve_runtime_target_page_prefers_active_page_without_inferring_target_app() -> None:
    page_ref, page = _resolve_runtime_target_page(
        page_registry={
            "page_0": {
                "url": "https://www.myntra.com/login?referer=/checkout/cart",
                "title": "Myntra",
            },
            "page_1": {
                "url": "https://www.myntra.com/maroon-men's-shirt?rawQuery=maroon%20men%27s%20shirt",
                "title": "Maroon Men's Shirt - Buy Maroon Men's Shirt online in India",
            },
        },
        active_page_ref="page_0",
        target_app="Myntra",
        goal_text="Find a maroon men's shirt on Myntra under ₹1000 in size M",
    )

    assert page_ref == "page_0"
    assert page["url"].startswith("https://www.myntra.com/login")


def test_compute_phase_states_advances_from_runtime_evidence() -> None:
    plan = AutomationPlan(
        plan_id="plan-1",
        intent_id="intent-1",
        execution_mode="immediate",
        summary="Find a maroon men's shirt on Myntra",
        source_prompt="Find a maroon men's shirt on Myntra",
        execution_contract=ExecutionContract(
            contract_id="contract-1",
            resolved_goal="Find a maroon men's shirt on Myntra",
            target_app="Myntra",
            target_entities={"target": "maroon men's shirt"},
        ),
        predicted_plan=PredictedExecutionPlan(
            summary="Find a maroon men's shirt on Myntra",
            phases=[
                PredictedPhase(
                    phase_id="phase_1",
                    label="Go to Myntra.com",
                    goal="Go to Myntra.com",
                    completion_signals=["myntra"],
                    advisory=True,
                ),
                PredictedPhase(
                    phase_id="phase_2",
                    label="Search for 'maroon men's shirt'",
                    goal="Search for 'maroon men's shirt'",
                    completion_signals=["maroon men's shirt"],
                    advisory=True,
                ),
            ],
            advisory=True,
            generated_at="2026-03-13T00:00:00+00:00",
        ),
    )

    active_phase_index, phase_states, _ = _compute_phase_states(
        plan,
        fallback_active_phase_index=0,
        current_snapshot={"snapshot": "Maroon Men's Shirt - 6037 items"},
        current_url="https://www.myntra.com/maroon-men's-shirt",
        current_title="Maroon Men's Shirt - Myntra",
        known_variables={},
    )

    assert active_phase_index is None
    assert phase_states[0].status == "completed"
    assert phase_states[1].status == "completed"


def test_terminal_runtime_incident_detects_non_replannable_failure() -> None:
    incident = _terminal_runtime_incident_from_events(
        [
            {
                "type": "run.runtime_incident",
                "payload": {
                    "code": "EXECUTION_FAILED",
                    "reason": "API rate limit reached.",
                    "phase": "error",
                    "replannable": False,
                },
            }
        ]
    )

    assert incident is not None
    error, payload = incident
    assert error.code == "MODEL_RATE_LIMIT"
    assert error.message == "API rate limit reached."
    assert payload["phase"] == "error"


def test_runtime_code_to_run_error_marks_rate_limit_as_retryable() -> None:
    error = _runtime_code_to_run_error(
        "EXECUTION_FAILED",
        "⚠️ API rate limit reached. Please try again later.",
    )

    assert error.code == "MODEL_RATE_LIMIT"
    assert error.retryable is True


def test_runtime_code_to_run_error_marks_overload_as_retryable() -> None:
    error = _runtime_code_to_run_error(
        "EXECUTION_FAILED",
        "The AI service is temporarily overloaded. Please try again in a moment.",
    )

    assert error.code == "MODEL_OVERLOADED"
    assert error.retryable is True
