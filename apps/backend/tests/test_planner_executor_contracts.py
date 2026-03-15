from __future__ import annotations

import asyncio
import pytest

from oi_agent.automation.conversation_service import _sync_phase_from_run
from oi_agent.automation.conversation_task import ConversationTask
from oi_agent.automation.executor import (
    _agent_browser_command_prefix,
    _backend_directed_step_log_entry,
    _candidate_page_match_tokens,
    _compute_phase_states,
    _page_match_score,
    _run_uses_typed_execution,
    _resolve_runtime_target_page,
    _step_requires_ref_grounding,
    _typed_execution_blocked_action_plan,
    _phase_fact_texts,
    _rebuild_page_registry_from_session,
    _register_soft_runtime_incident,
    _run_backend_directed_runtime_actions,
    _should_backend_direct_runtime_action,
    _ungrounded_runtime_incident,
    _track_runtime_event_progress,
    _runtime_action_low_specificity,
    _runtime_failure_resolved_by_live_verification,
    _runtime_browser_observation_from_payload,
    _resolve_runtime_target_page,
    _runtime_code_to_run_error,
    _runtime_failure_resolved_by_live_verification,
    _runtime_tool_progress_entry,
    _runtime_snapshot_payload,
    _sync_run_phase_progress,
    _sync_agent_browser_active_tab,
    _terminal_runtime_incident_from_events,
    _typed_blocker_incident_from_run,
    reset_execution_tasks,
    start_execution,
)
from oi_agent.automation.models import (
    AutomationPlan,
    AutomationRun,
    BrowserStateSnapshot,
    ExecutionContract,
    ExecutionProgress,
    ExecutionStep,
    VerificationRule,
    RunProgressTracker,
    PredictedExecutionPlan,
    PredictedPhase,
    RuntimeIncident,
)
from oi_agent.automation.planner_service import (
    _completion_signals_for_phase,
    build_plan_from_prompt,
)
from oi_agent.automation.run_service import _build_run_status_summary, get_run_response
from oi_agent.automation.store import get_run, reset_store, save_plan, save_run, update_run
from oi_agent.services.tools.base import ToolResult
from oi_agent.services.tools import step_planner as step_planner_module


def test_should_backend_direct_runtime_action_accepts_deterministic_sources() -> None:
    from oi_agent.automation.models import RuntimeActionPlan, AgentBrowserStep

    plan = RuntimeActionPlan(
        status="action",
        step=AgentBrowserStep(command="press", args=["Enter"]),
        evidence={"source": "deterministic_search_submit_step"},
        preferred_execution_mode="ref",
    )

    assert _should_backend_direct_runtime_action(plan) is True


def test_should_backend_direct_runtime_action_accepts_grounded_action_for_current_step() -> None:
    from oi_agent.automation.models import RuntimeActionPlan, AgentBrowserStep, AgentBrowserTarget, AutomationRun, ExecutionProgress

    run = AutomationRun(
        run_id="run-grounded",
        user_id="dev-user",
        intent_id="intent-grounded",
        session_id="session-grounded",
        plan_id="plan-grounded",
        state="running",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        execution_progress=ExecutionProgress(
            execution_steps=[
                {
                    "step_id": "phase_2",
                    "kind": "search",
                    "label": "Search for 'fetch api'",
                    "status": "active",
                    "allowed_actions": ["snapshot", "click", "type", "press"],
                }
            ],
            current_execution_step_index=0,
        ),
        created_at="2026-03-15T00:00:00Z",
        updated_at="2026-03-15T00:00:00Z",
    )
    plan = RuntimeActionPlan(
        status="action",
        step=AgentBrowserStep(command="click", target=AgentBrowserTarget(ref="e15", by="ref", value="e15")),
        evidence={},
        preferred_execution_mode="ref",
    )

    assert _should_backend_direct_runtime_action(plan, run=run) is True


def test_step_requires_ref_grounding_for_typed_result_surface() -> None:
    run = AutomationRun(
        run_id="run-ref-grounding",
        user_id="dev-user",
        intent_id="intent-ref-grounding",
        session_id="session-ref-grounding",
        plan_id="plan-ref-grounding",
        state="running",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        execution_progress=ExecutionProgress(
            execution_steps=[
                {
                    "step_id": "phase_3",
                    "kind": "select_result",
                    "label": "Open the first matching result",
                    "status": "active",
                    "allowed_actions": ["snapshot", "click"],
                }
            ],
            current_execution_step_index=0,
        ),
        created_at="2026-03-15T00:00:00Z",
        updated_at="2026-03-15T00:00:00Z",
    )

    assert _step_requires_ref_grounding(run, {"refs": {"e21": {"role": "link", "name": "Result"}}}) is True
    assert _step_requires_ref_grounding(run, {"refs": {}}) is False
    assert _run_uses_typed_execution(run) is True


def test_typed_execution_blocked_action_plan_preserves_retryable_block() -> None:
    plan = _typed_execution_blocked_action_plan(
        summary="The current typed step could not find a grounded next action.",
        reason_code="typed_execution_requires_grounded_action",
    )

    assert plan.status == "blocked"
    assert plan.block is not None
    assert plan.block.reason_code == "typed_execution_requires_grounded_action"
    assert plan.block.retriable is True


def test_browser_owned_completed_run_without_runtime_evidence_is_not_success() -> None:
    plan = AutomationPlan(
        plan_id="plan-browser-owned-no-evidence",
        intent_id="intent-browser-owned-no-evidence",
        execution_mode="immediate",
        summary="Open Myntra and apply filters",
        steps=[],
    )
    run = AutomationRun(
        run_id="run-browser-owned-no-evidence",
        user_id="dev-user",
        intent_id="intent-browser-owned-no-evidence",
        session_id="session-browser-owned-no-evidence",
        plan_id="plan-browser-owned-no-evidence",
        state="completed",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-session-1",
        execution_progress=ExecutionProgress(),
        created_at="2026-03-15T00:00:00Z",
        updated_at="2026-03-15T00:00:00Z",
    )

    status = _build_run_status_summary(run, plan)

    assert status.status == "in_progress"
    assert status.is_success is False


def test_resolve_runtime_target_page_prefers_matching_open_tab() -> None:
    page_ref, page = _resolve_runtime_target_page(
        page_registry={
            "page_wikipedia": {
                "url": "https://www.wikipedia.org/",
                "title": "Wikipedia",
                "is_active": True,
                "tab_index": 0,
            },
            "page_mozilla": {
                "url": "https://developer.mozilla.org/en-US/",
                "title": "MDN Web Docs",
                "is_active": False,
                "tab_index": 2,
            },
        },
        active_page_ref="page_wikipedia",
        target_app="Developer.Mozilla.Org",
        goal_text="open developer.mozilla.org and search for fetch api",
    )

    assert page_ref == "page_mozilla"
    assert page["title"] == "MDN Web Docs"


def test_page_match_helpers_score_matching_domain_higher() -> None:
    tokens = _candidate_page_match_tokens(
        target_app="Developer.Mozilla.Org",
        goal_text="open developer.mozilla.org and search for fetch api",
    )

    assert "developer mozilla org" in tokens
    assert _page_match_score(
        {"url": "https://developer.mozilla.org/en-US/search?q=fetch+api", "title": "Search | MDN"},
        tokens=tokens,
    ) > _page_match_score(
        {"url": "https://www.wikipedia.org/", "title": "Wikipedia"},
        tokens=tokens,
    )


def test_page_match_helpers_ignore_service_worker_targets() -> None:
    tokens = _candidate_page_match_tokens(
        target_app="Myntra",
        goal_text="open myntra and search for black running shoes for men",
    )

    assert _page_match_score(
        {"url": "https://www.myntra.com/dsw.js", "title": "Service Worker https://www.myntra.com/dsw.js"},
        tokens=tokens,
    ) == 0
    assert _page_match_score(
        {"url": "https://www.myntra.com/", "title": "Online Shopping for Women, Men, Kids Fashion & Lifestyle - Myntra"},
        tokens=tokens,
    ) > 0


def test_resolve_runtime_target_page_ignores_service_worker_when_matching_target_app() -> None:
    page_ref, page = _resolve_runtime_target_page(
        page_registry={
            "page_service_worker": {
                "url": "https://www.myntra.com/dsw.js",
                "title": "Service Worker https://www.myntra.com/dsw.js",
                "is_active": True,
                "tab_index": 0,
            },
            "page_myntra": {
                "url": "https://www.myntra.com/",
                "title": "Online Shopping for Women, Men, Kids Fashion & Lifestyle - Myntra",
                "is_active": False,
                "tab_index": 1,
            },
        },
        active_page_ref="page_service_worker",
        target_app="Myntra",
        goal_text="open myntra and search for black running shoes for men",
    )

    assert page_ref == "page_myntra"
    assert page["url"] == "https://www.myntra.com/"


def test_resolve_runtime_target_page_prefers_neutral_blank_tab_for_fresh_external_navigation() -> None:
    page_ref, page = _resolve_runtime_target_page(
        page_registry={
            "page_oye": {
                "url": "http://127.0.0.1:5175/sessions",
                "title": "Oye",
                "is_active": True,
                "tab_index": 0,
            },
            "page_blank": {
                "url": "about:blank",
                "title": "",
                "is_active": False,
                "tab_index": 1,
            },
        },
        active_page_ref="page_oye",
        target_app="Myntra",
        goal_text="open myntra and search for black running shoes for men",
    )

    assert page_ref == "page_blank"
    assert page["url"] == "about:blank"


def test_ungrounded_runtime_incident_describes_ref_rich_typed_step() -> None:
    from oi_agent.automation.models import RuntimeActionPlan

    run = AutomationRun(
        run_id="run-incident",
        user_id="dev-user",
        intent_id="intent-incident",
        session_id="session-incident",
        plan_id="plan-incident",
        state="running",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        execution_progress=ExecutionProgress(
            execution_steps=[
                {
                    "step_id": "phase_1",
                    "kind": "search",
                    "label": "Search for fetch api",
                    "status": "active",
                    "allowed_actions": ["snapshot", "click", "type", "press"],
                }
            ],
            current_execution_step_index=0,
        ),
        created_at="2026-03-15T00:00:00Z",
        updated_at="2026-03-15T00:00:00Z",
    )
    action_plan = RuntimeActionPlan(
        status="blocked",
        summary="Planner returned a vague click target.",
        preferred_execution_mode="ref",
    )
    observation = BrowserStateSnapshot(
        captured_at="2026-03-15T00:00:00Z",
        url="https://developer.mozilla.org/en-US/search?q=fetch+api",
        title="Search results",
    )

    incident = _ungrounded_runtime_incident(
        run=run,
        observation=observation,
        page_snapshot={"snapshot_id": "snap-123", "refs": {"e5": {"role": "link", "name": "Fetch API"}}},
        action_plan=action_plan,
    )

    assert incident.code == "OBSERVATION_UNGROUNDED"
    assert "Search for fetch api" in incident.summary
    assert incident.replannable is True


def test_agent_browser_command_prefix_falls_back_to_js_wrapper(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from pathlib import Path

    cli = Path("/tmp/agent-browser-darwin-arm64")
    monkeypatch.setattr("oi_agent.automation.executor._AGENT_BROWSER_CLI", cli)
    monkeypatch.setattr(Path, "exists", lambda self: self in {cli, cli.with_name("agent-browser.js")})
    monkeypatch.setattr("oi_agent.automation.executor.os.access", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(Path, "chmod", lambda self, mode: None)

    assert _agent_browser_command_prefix() == ["node", str(cli.with_name("agent-browser.js"))]


@pytest.mark.asyncio
async def test_sync_agent_browser_active_tab_prefers_identity_over_stale_index(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[list[str]] = []

    async def fake_run_node_json_command(*, args: list[str], timeout_seconds: float | None = None) -> dict[str, object]:
        calls.append(list(args))
        if args[-1] == "tab":
            return {
                "tabs": [
                    {"index": 0, "title": "Search | MDN", "url": "https://developer.mozilla.org/en-US/search?q=fetch+api", "active": False},
                    {"index": 1, "title": "MDN Web Docs", "url": "https://developer.mozilla.org/en-US/", "active": False},
                    {"index": 3, "title": "Wikipedia", "url": "https://www.wikipedia.org/", "active": True},
                ]
            }
        return {"success": True}

    monkeypatch.setattr("oi_agent.automation.executor._run_node_json_command", fake_run_node_json_command)

    page_registry = {
        "page_3": {
            "url": "https://developer.mozilla.org/en-US/",
            "title": "MDN Web Docs",
            "tab_index": 3,
        }
    }

    await _sync_agent_browser_active_tab(
        session_name="oi-run-test",
        page_registry=page_registry,
        active_page_ref="page_3",
    )

    assert calls[0][-1] == "tab"
    assert calls[1][-2:] == ["tab", "1"]
    assert page_registry["page_3"]["tab_index"] == 1


def test_backend_directed_step_log_entry_preserves_typed_value() -> None:
    entry = _backend_directed_step_log_entry(
        {
            "id": "step-1",
            "command": "type",
            "value": "fetch api",
            "description": "Enter 'fetch api' into the search field.",
        }
    )

    assert entry["command"] == "type"
    assert "fetch api" in str(entry["label"])
    assert "fetch api" in str(entry["description"])


@pytest.mark.asyncio
async def test_sync_run_phase_progress_uses_previous_surface_for_transition_verification() -> None:
    captured_previous_urls: list[str | None] = []

    run = AutomationRun(
        run_id="run-sync-transition",
        user_id="dev-user",
        intent_id="intent-sync-transition",
        session_id="session-sync-transition",
        plan_id="plan-sync-transition",
        state="running",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        execution_progress=ExecutionProgress(
            ui_surface={
                "captured_at": "2026-03-15T00:00:00Z",
                "kind": "listing",
                "url": "https://developer.mozilla.org/en-US/",
                "result_items": [{"ref": "e1", "name": "Home item"}],
            },
            execution_steps=[
                ExecutionStep(
                    step_id="phase_1",
                    kind="navigate",
                    label="Go to developer.mozilla.org",
                    target_constraints={"target_host": "developer.mozilla.org"},
                    verification_rules=[
                        VerificationRule(kind="url_contains", value="developer.mozilla.org"),
                        VerificationRule(kind="surface_kind", expected_surface="listing"),
                    ],
                    status="completed",
                ).model_dump(mode="json"),
            ],
            current_execution_step_index=0,
        ),
        created_at="2026-03-15T00:00:00Z",
        updated_at="2026-03-15T00:00:00Z",
    )
    plan = AutomationPlan(
        plan_id="plan-sync-transition",
        intent_id="intent-sync-transition",
        execution_mode="immediate",
        summary="Open developer.mozilla.org and search for fetch api",
    )
    await save_run(run.run_id, run.model_dump(mode="json"))

    def fake_reconcile_execution_steps(*, steps, ui_surface, previous_surface=None):
        captured_previous_urls.append(getattr(previous_surface, "url", None))
        return (None, steps)

    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr("oi_agent.automation.executor.reconcile_execution_steps", fake_reconcile_execution_steps)

    try:
        await _sync_run_phase_progress(
            run_id=run.run_id,
            plan=plan,
            current_snapshot={
                "url": "https://developer.mozilla.org/en-US/search?q=fetch+api",
                "title": "Search | MDN",
                "targetId": "page_mozilla",
                "refs": {
                    "e2": {"role": "link", "name": "Fetch API reference"},
                    "e3": {"role": "link", "name": "Using the Fetch API"},
                },
                "snapshot": 'Fetch API reference Using the Fetch API',
            },
            current_url="https://developer.mozilla.org/en-US/search?q=fetch+api",
            current_title="Search | MDN",
        )
    finally:
        monkeypatch.undo()

    assert captured_previous_urls
    assert captured_previous_urls[-1] == "https://developer.mozilla.org/en-US/"


@pytest.mark.asyncio
async def test_run_backend_directed_runtime_actions_executes_deterministic_step_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = AutomationRun(
        run_id="run-directed",
        user_id="dev-user",
        intent_id="intent-directed",
        session_id="session-directed",
        plan_id="plan-directed",
        state="running",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-session-1",
        active_page_ref="page_mozilla",
        page_registry={"page_mozilla": {"url": "https://developer.mozilla.org/en-US/", "title": "MDN Web Docs"}},
        phase_states=[],
        progress_tracker=RunProgressTracker(),
        execution_progress=ExecutionProgress(
            execution_steps=[
                {
                    "step_id": "phase_2",
                    "kind": "search",
                    "label": "Search for 'fetch api'",
                    "status": "active",
                    "verification_rules": [{"kind": "search_query", "value": "fetch api"}],
                }
            ],
            current_execution_step_index=0,
        ),
        browser_snapshot=BrowserStateSnapshot(captured_at="2026-03-15T00:00:00Z"),
        created_at="2026-03-15T00:00:00Z",
        updated_at="2026-03-15T00:00:00Z",
    )
    plan = AutomationPlan(
        plan_id="plan-directed",
        intent_id="intent-directed",
        execution_mode="immediate",
        summary="Search for fetch api on MDN",
        execution_contract=ExecutionContract(
            contract_id="contract-directed",
            resolved_goal="Search for fetch api on MDN",
        ),
    )
    await save_run(run.run_id, run.model_dump(mode="json"))

    async def fake_run_node_json_command(*, args, stdin=None):
        _ = stdin
        if args[-2:] == ["connect", "wss-never"]:
            return {}
        return {}

    async def fake_capture_browser_observation(**kwargs):
        _ = kwargs
        snapshot = {
            "snapshot": '[ref=e2] link "Search"\n[ref=e8] textbox "Search docs"',
            "refs": {
                "e2": {"role": "link", "name": "Search"},
                "e8": {"role": "textbox", "name": "Search docs"},
            },
            "url": "https://developer.mozilla.org/en-US/",
            "title": "MDN Web Docs",
            "targetId": "page_mozilla",
            "snapshot_id": "snap-1",
        }
        observation = BrowserStateSnapshot(
            captured_at="2026-03-15T00:00:00Z",
            url="https://developer.mozilla.org/en-US/",
            title="MDN Web Docs",
            page_id="page_mozilla",
            metadata={"snapshot_id": "snap-1"},
        )
        return observation, snapshot, "snap-1"

    async def fake_sync_run_phase_progress(**kwargs):
        _ = kwargs
        return None

    planned = []

    async def fake_plan_next_runtime_action(**kwargs):
        _ = kwargs
        from oi_agent.automation.models import RuntimeActionPlan, AgentBrowserStep

        if not planned:
            planned.append("deterministic")
            return RuntimeActionPlan(
                status="action",
                summary="Submit the visible search query.",
                step=AgentBrowserStep(command="press", args=["Enter"]),
                evidence={"source": "deterministic_search_submit_step"},
                preferred_execution_mode="ref",
            ), ""
        return RuntimeActionPlan(status="action", preferred_execution_mode="ref"), ""

    async def fake_apply_runtime_action_plan(**kwargs):
        _ = kwargs
        return ([{"command": "press", "args": ["Enter"], "description": "Submit the active search input."}], False)

    executed_steps = []

    async def fake_execute_browser_steps_with_engine(**kwargs):
        executed_steps.extend(kwargs.get("steps", []))
        return ToolResult(
            success=True,
            data=[],
            metadata={
                "page_registry": {"page_mozilla": {"url": "https://developer.mozilla.org/en-US/search", "title": "Search"}},
                "active_page_ref": "page_mozilla",
            },
            text="ok",
        )

    monkeypatch.setattr("oi_agent.automation.executor._run_node_json_command", fake_run_node_json_command)
    monkeypatch.setattr("oi_agent.automation.executor._capture_browser_observation", fake_capture_browser_observation)
    monkeypatch.setattr("oi_agent.automation.executor._sync_run_phase_progress", fake_sync_run_phase_progress)
    monkeypatch.setattr("oi_agent.automation.executor._plan_next_runtime_action", fake_plan_next_runtime_action)
    monkeypatch.setattr("oi_agent.automation.executor._apply_runtime_action_plan", fake_apply_runtime_action_plan)
    monkeypatch.setattr("oi_agent.automation.executor._execute_browser_steps_with_engine", fake_execute_browser_steps_with_engine)

    refreshed_run, terminal = await _run_backend_directed_runtime_actions(
        run_id=run.run_id,
        user_id="dev-user",
        session_id="session-directed",
        run=run,
        plan=plan,
        prompt="Search for fetch api on MDN",
        cdp_url="wss-never",
        max_iterations=1,
    )

    assert terminal is False
    assert executed_steps == [{"command": "press", "args": ["Enter"], "description": "Submit the active search input."}]
    assert refreshed_run.active_page_ref == "page_mozilla"


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


def test_runtime_snapshot_payload_preserves_structured_snapshot_fields() -> None:
    payload = _runtime_snapshot_payload(
        {
            "snapshot_text": "[ref=e1] button 'Continue'",
            "url": "https://example.com/checkout",
            "title": "Checkout",
            "targetId": "page-1",
            "snapshot_id": "snap-1",
            "snapshotFormat": "aria",
            "refs": {"e1": {"role": "button", "name": "Continue"}},
        }
    )

    assert payload is not None
    assert payload["url"] == "https://example.com/checkout"
    assert payload["snapshot_id"] == "snap-1"
    assert "refs" in payload


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
async def test_start_execution_serializes_runs_per_browser_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await reset_store()
    await reset_execution_tasks()
    order: list[str] = []

    async def fake_execute_run(run_id: str) -> None:
        order.append(f"start:{run_id}")
        await asyncio.sleep(0.02)
        await update_run(run_id, {"state": "completed", "updated_at": "2026-03-14T00:00:01+00:00"})
        order.append(f"done:{run_id}")

    monkeypatch.setattr("oi_agent.automation.executor.execute_run", fake_execute_run)

    for run_id, created_at in (("run-1", "2026-03-14T00:00:00+00:00"), ("run-2", "2026-03-14T00:00:02+00:00")):
        run = AutomationRun(
            run_id=run_id,
            user_id="dev-user",
            intent_id=f"intent-{run_id}",
            session_id=f"session-{run_id}",
            plan_id=f"plan-{run_id}",
            state="queued",
            execution_mode="immediate",
            executor_mode="local_runner",
            automation_engine="agent_browser",
            browser_session_id="browser-session-1",
            phase_states=[],
            progress_tracker=RunProgressTracker(),
            execution_progress=ExecutionProgress(),
            browser_snapshot=BrowserStateSnapshot(captured_at=created_at),
            created_at=created_at,
            updated_at=created_at,
        )
        await save_run(run_id, run.model_dump(mode="json"))

    await start_execution("run-1")
    await start_execution("run-2")
    await asyncio.sleep(0.08)

    assert order == ["start:run-1", "done:run-1", "start:run-2", "done:run-2"]
    await reset_execution_tasks()


def test_compute_phase_states_prefers_execution_steps_over_legacy_phase_text() -> None:
    plan = AutomationPlan(
        plan_id="plan-1",
        intent_id="intent-1",
        execution_mode="immediate",
        summary="Find a maroon shirt",
        predicted_plan=PredictedExecutionPlan(
            summary="Find a maroon shirt",
            phases=[
                PredictedPhase(phase_id="phase_1", label='Search for "shirt"'),
                PredictedPhase(phase_id="phase_2", label='Apply color filter "maroon"'),
            ],
        ),
    )

    active_phase_index, phase_states, _, ui_surface = _compute_phase_states(
        plan,
        current_snapshot={
            "snapshot": "listing",
            "url": "https://example.com/search?rawquery=shirt",
            "title": "Results",
            "refs": {
                "e1": {"role": "link", "name": "Maroon Shirt"},
                "e2": {"role": "checkbox", "name": "maroon"},
                "e3": {"role": "link", "name": "Blue Shirt"},
            },
        },
        current_url="https://example.com/search?rawquery=shirt&color=maroon",
        current_title="Results",
        execution_steps=[
            {
                "step_id": "phase_1",
                "kind": "search",
                "label": 'Search for "shirt"',
                "verification_rules": [{"kind": "search_query", "value": "shirt"}],
            },
            {
                "step_id": "phase_2",
                "kind": "filter",
                "label": 'Apply color filter "maroon"',
                "verification_rules": [{"kind": "selected_filter", "key": "color", "value": "maroon"}],
            },
        ],
    )

    assert ui_surface is not None
    assert active_phase_index is None
    assert phase_states[0].status == "completed"
    assert phase_states[1].status == "completed"


def test_compute_phase_states_ignores_execution_steps_for_browser_owned_runtime() -> None:
    plan = AutomationPlan(
        plan_id="plan-browser-owned",
        intent_id="intent-browser-owned",
        execution_mode="immediate",
        summary="Search on a live browser homepage",
        predicted_plan=PredictedExecutionPlan(
            summary="Search on a live browser homepage",
            phases=[
                PredictedPhase(phase_id="phase_1", label="Go to the site"),
                PredictedPhase(phase_id="phase_2", label="Search for shoes"),
            ],
        ),
        execution_contract=ExecutionContract.model_validate(
            {
                "contract_id": "contract-browser-owned",
                "resolved_goal": "Search on a live browser homepage",
                "task_shape": {
                    "execution_surface": "browser",
                    "target_app": "Myntra",
                    "required_inputs": [],
                }
            }
        ),
    )

    active_phase_index, phase_states, phase_fact_evidence, ui_surface = _compute_phase_states(
        plan,
        current_snapshot={
            "snapshot": '- searchbox "Search for products, brands and more" [ref=e8]',
            "url": "https://www.myntra.com/",
            "title": "Online Shopping",
            "refs": {
                "e8": {
                    "role": "searchbox",
                    "name": "Search for products, brands and more",
                }
            },
        },
        execution_steps=[
            {
                "step_id": "phase_1",
                "kind": "search",
                "label": "Search for shoes",
                "status": "active",
                "allowed_actions": ["snapshot", "click", "type", "press"],
            }
        ],
        previous_ui_surface={"kind": "listing"},
    )

    assert ui_surface is not None
    assert phase_states
    assert phase_fact_evidence == {}
    assert active_phase_index in {0, 1, None}


def test_typed_blocker_incident_from_run_requires_human_takeover() -> None:
    plan = AutomationPlan(
        plan_id="plan-blocker",
        intent_id="intent-blocker",
        execution_mode="immediate",
        summary="Open MDN and search for fetch",
    )
    run = AutomationRun(
        run_id="run-blocker",
        user_id="dev-user",
        intent_id="intent-blocker",
        session_id="session-blocker",
        plan_id="plan-blocker",
        state="running",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        phase_states=[],
        progress_tracker=RunProgressTracker(),
        execution_progress=ExecutionProgress(
            current_execution_step_index=0,
            execution_steps=[
                {
                    "step_id": "phase_nav",
                    "kind": "navigate",
                    "label": "Go to developer.mozilla.org",
                    "target_constraints": {"target_host": "developer.mozilla.org"},
                }
            ],
            ui_surface={
                "captured_at": "2026-03-15T00:00:00Z",
                "kind": "blocker",
                "url": "https://1click-google-settings.freebusinessapps.net/welcome#google_vignette",
                "title": "MDN Web Docs",
                "blockers": ["blocked"],
                "signals": ["developer.mozilla.org refused to connect"],
            },
        ),
        browser_snapshot=BrowserStateSnapshot(captured_at="2026-03-15T00:00:00Z"),
        created_at="2026-03-15T00:00:00Z",
        updated_at="2026-03-15T00:00:00Z",
    )

    incident = _typed_blocker_incident_from_run(run=run, plan=plan)

    assert incident is not None
    error, payload = incident
    assert error.code == "BLOCKED_FOREGROUND_SURFACE"
    assert payload["category"] == "blocker"
    assert payload["requires_human"] is True
    assert payload["replannable"] is False


@pytest.mark.asyncio
async def test_plan_runtime_action_blocks_mutating_step_without_ref_when_snapshot_has_refs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_plan_browser_steps(**kwargs):
        _ = kwargs
        return {
            "status": "OK",
            "summary": "Click the primary action.",
            "steps": [
                {
                    "type": "browser",
                    "command": "click",
                    "description": "Click the primary action.",
                    "target": {"by": "role", "value": "button", "name": "Continue"},
                }
            ],
        }

    monkeypatch.setattr(step_planner_module, "plan_browser_steps", fake_plan_browser_steps)

    result = await step_planner_module.plan_runtime_action(
        execution_contract={"resolved_goal": "Continue the checkout flow"},
        current_url="https://example.com/cart",
        current_page_title="Cart",
        page_snapshot={"refs": {"e1": {"role": "button", "name": "Continue"}}, "snapshot": "[ref=e1] button 'Continue'"},
    )

    assert result.status == "blocked"
    assert result.block is not None
    assert result.block.reason_code == "planner_requires_concrete_ref"


@pytest.mark.asyncio
async def test_plan_runtime_action_blocks_same_origin_navigation_when_live_surface_has_refs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_plan_browser_steps(**kwargs):
        _ = kwargs
        return {
            "status": "OK",
            "summary": "Open the search results URL directly.",
            "steps": [
                {
                    "type": "browser",
                    "command": "navigate",
                    "description": "Open the shirt results page directly.",
                    "target": "https://www.myntra.com/shirt",
                }
            ],
        }

    monkeypatch.setattr(step_planner_module, "plan_browser_steps", fake_plan_browser_steps)

    result = await step_planner_module.plan_runtime_action(
        execution_contract={"resolved_goal": "Find a maroon shirt on Myntra"},
        user_prompt="Find a maroon shirt on Myntra",
        current_url="https://www.myntra.com/",
        current_page_title="Myntra",
        page_snapshot={"refs": {"e1": {"role": "textbox", "name": "Search"}}, "snapshot": "[ref=e1] textbox 'Search'"},
    )

    assert result.status == "blocked"
    assert result.block is not None
    assert result.block.reason_code == "planner_requires_grounded_navigation"


@pytest.mark.asyncio
async def test_plan_runtime_action_allows_explicit_url_navigation_from_user_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_plan_browser_steps(**kwargs):
        _ = kwargs
        return {
            "status": "OK",
            "summary": "Open the requested URL.",
            "steps": [
                {
                    "type": "browser",
                    "command": "navigate",
                    "description": "Open the requested URL.",
                    "target": "https://www.myntra.com/shirt",
                }
            ],
        }

    monkeypatch.setattr(step_planner_module, "plan_browser_steps", fake_plan_browser_steps)

    result = await step_planner_module.plan_runtime_action(
        execution_contract={"resolved_goal": "Open the requested URL"},
        user_prompt="Open https://www.myntra.com/shirt",
        current_url="https://www.myntra.com/",
        current_page_title="Myntra",
        page_snapshot={"refs": {"e1": {"role": "textbox", "name": "Search"}}, "snapshot": "[ref=e1] textbox 'Search'"},
    )

    assert result.status == "action"
    assert result.step is not None
    assert result.step.command == "navigate"


@pytest.mark.asyncio
async def test_plan_runtime_action_blocks_redundant_short_text_entry_when_surface_already_reflects_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_plan_browser_steps(**kwargs):
        _ = kwargs
        return {
            "status": "OK",
            "summary": "Type the search term again.",
            "steps": [
                {
                    "type": "browser",
                    "command": "type",
                    "description": "Type the search term again.",
                    "target": {"ref": "e1"},
                    "value": "shirt",
                }
            ],
        }

    monkeypatch.setattr(step_planner_module, "plan_browser_steps", fake_plan_browser_steps)

    result = await step_planner_module.plan_runtime_action(
        execution_contract={"resolved_goal": "Find a shirt on Myntra"},
        user_prompt="Find a shirt on Myntra",
        current_url="https://www.myntra.com/search?q=shirt",
        current_page_title="Search - Shirt",
        page_snapshot={"refs": {"e1": {"role": "textbox", "name": "Search"}}, "snapshot": "[ref=e1] textbox 'Search' shirt"},
    )

    assert result.status == "blocked"
    assert result.block is not None
    assert result.block.reason_code == "planner_requires_grounded_reentry"


@pytest.mark.asyncio
async def test_plan_runtime_action_deterministically_selects_first_result_from_listing_surface(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_plan_browser_steps(**_: object) -> dict[str, object]:
        return {
            "status": "BLOCKED",
            "summary": "Planner could not ground the result from the current snapshot.",
            "steps": [],
        }

    monkeypatch.setattr(step_planner_module, "plan_browser_steps", fake_plan_browser_steps)

    result = await step_planner_module.plan_runtime_action(
        execution_contract={
            "resolved_goal": "Select the first matching result",
            "current_execution_step": {
                "step_id": "phase_4",
                "kind": "select_result",
                "target_constraints": {"result_index": 0, "match_terms": ["maroon", "shirt"]},
            },
            "ui_surface": {
                "kind": "listing",
                "result_items": [
                    {"ref": "e2", "name": "Maroon Shirt Rs. 999"},
                    {"ref": "e3", "name": "Blue Shirt Rs. 899"},
                ],
            },
        },
        current_url="https://example.com/search?q=shirt",
        current_page_title="Results",
        page_snapshot={
            "refs": {
                "e2": {"role": "link", "name": "Maroon Shirt Rs. 999"},
                "e3": {"role": "link", "name": "Blue Shirt Rs. 899"},
            },
            "snapshot": '[ref=e2] link "Maroon Shirt Rs. 999"\n[ref=e3] link "Blue Shirt Rs. 899"',
        },
    )

    assert result.status == "action"
    assert result.step is not None
    assert result.step.command == "click"
    assert getattr(result.step.target, "ref", None) == "e2"
    assert result.evidence == {"source": "deterministic_select_result_step"}


@pytest.mark.asyncio
async def test_plan_runtime_action_prefers_grounded_planner_result_for_select_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_plan_browser_steps(**_: object) -> dict[str, object]:
        return {
            "status": "OK",
            "summary": "Open the first matching visible result.",
            "steps": [
                {
                    "type": "browser",
                    "command": "click",
                    "description": "Open Fetch API.",
                    "target": {"by": "ref", "ref": "e22", "value": "e22", "name": "Fetch API"},
                }
            ],
        }

    monkeypatch.setattr(step_planner_module, "plan_browser_steps", fake_plan_browser_steps)

    result = await step_planner_module.plan_runtime_action(
        execution_contract={
            "resolved_goal": "Open the first matching result",
            "current_execution_step": {
                "step_id": "phase_4",
                "kind": "select_result",
                "target_constraints": {"result_index": 0, "match_terms": ["fetch", "api"]},
            },
            "ui_surface": {
                "kind": "listing",
                "result_items": [
                    {"ref": "e1", "name": "Skip to main content"},
                    {"ref": "e22", "name": "Fetch API"},
                ],
            },
        },
        current_url="https://developer.mozilla.org/en-US/search?q=fetch+api",
        current_page_title="Search results | MDN",
        page_snapshot={
            "refs": {
                "e1": {"role": "link", "name": "Skip to main content"},
                "e22": {"role": "link", "name": "Fetch API"},
            },
            "snapshot": '[ref=e1] link "Skip to main content"\n[ref=e22] link "Fetch API"',
        },
    )

    assert result.status == "action"
    assert result.step is not None
    assert result.step.command == "click"
    assert getattr(result.step.target, "ref", None) == "e22"


@pytest.mark.asyncio
async def test_plan_runtime_action_deterministically_selects_filter_control_from_listing_surface() -> None:
    result = await step_planner_module.plan_runtime_action(
        execution_contract={
            "resolved_goal": "Apply the size filter",
            "current_execution_step": {
                "step_id": "phase_2",
                "kind": "filter",
                "target_constraints": {"filters": {"size": "M"}},
            },
            "ui_surface": {
                "kind": "listing",
                "selected_filters": {},
            },
        },
        current_url="https://example.com/search?q=shirt",
        current_page_title="Results",
        page_snapshot={
            "refs": {
                "e2": {"role": "checkbox", "name": "M"},
                "e3": {"role": "checkbox", "name": "L"},
            },
            "snapshot": '[ref=e2] checkbox "M"\n[ref=e3] checkbox "L"',
        },
    )

    assert result.status == "action"
    assert result.step is not None
    assert result.step.command == "click"
    assert getattr(result.step.target, "ref", None) == "e2"
    assert result.evidence == {"source": "deterministic_filter_step"}


@pytest.mark.asyncio
async def test_plan_runtime_action_deterministically_advances_with_primary_cta() -> None:
    result = await step_planner_module.plan_runtime_action(
        execution_contract={
            "resolved_goal": "Proceed to checkout",
            "current_execution_step": {
                "step_id": "phase_7",
                "kind": "advance",
                "verification_rules": [{"kind": "surface_kind", "expected_surface": "checkout"}],
            },
            "ui_surface": {
                "kind": "cart",
                "primary_action_refs": ["e9"],
            },
        },
        current_url="https://example.com/cart",
        current_page_title="Cart",
        page_snapshot={
            "refs": {
                "e9": {"role": "button", "name": "Continue"},
                "e10": {"role": "link", "name": "Keep shopping"},
            },
            "snapshot": '[ref=e9] button "Continue"\n[ref=e10] link "Keep shopping"',
        },
    )

    assert result.status == "action"
    assert result.step is not None
    assert result.step.command == "click"
    assert getattr(result.step.target, "ref", None) == "e9"
    assert result.evidence == {"source": "deterministic_advance_step"}


@pytest.mark.asyncio
async def test_plan_runtime_action_deterministically_fills_visible_field() -> None:
    result = await step_planner_module.plan_runtime_action(
        execution_contract={
            "resolved_goal": "Enter the shipping address",
            "current_execution_step": {
                "step_id": "phase_9",
                "kind": "fill_field",
                "target_constraints": {
                    "value": "010, mbr scapple, bengalurur",
                    "field_hint": "shipping address",
                },
            },
            "ui_surface": {
                "kind": "checkout",
            },
        },
        current_url="https://example.com/checkout",
        current_page_title="Checkout",
        page_snapshot={
            "refs": {
                "e4": {"role": "textbox", "name": "Shipping address"},
                "e5": {"role": "textbox", "name": "City"},
            },
            "snapshot": '[ref=e4] textbox "Shipping address"\n[ref=e5] textbox "City"',
        },
    )

    assert result.status == "action"
    assert result.step is not None
    assert result.step.command == "type"
    assert getattr(result.step.target, "ref", None) == "e4"
    assert result.step.value == "010, mbr scapple, bengalurur"
    assert result.evidence == {"source": "deterministic_fill_field_step"}


@pytest.mark.asyncio
async def test_plan_runtime_action_blocks_click_on_container_like_ref(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_plan_browser_steps(**kwargs):
        _ = kwargs
        return {
            "status": "OK",
            "summary": "Click the selected listing container.",
            "steps": [
                {
                    "type": "browser",
                    "command": "click",
                    "description": "Click the selected listing container.",
                    "target": {"ref": "e11"},
                }
            ],
        }

    monkeypatch.setattr(step_planner_module, "plan_browser_steps", fake_plan_browser_steps)

    result = await step_planner_module.plan_runtime_action(
        execution_contract={"resolved_goal": "Open the first product"},
        user_prompt="Open the first product",
        current_url="https://example.com/listing",
        current_page_title="Listing",
        page_snapshot={
            "refs": {"e11": {"role": "group", "name": ""}, "e12": {"role": "link", "name": "Maroon Shirt"}},
            "snapshot": "[ref=e11] group\n[ref=e12] link 'Maroon Shirt'",
        },
    )

    assert result.status == "blocked"
    assert result.block is not None
    assert result.block.reason_code == "planner_requires_specific_ref"


@pytest.mark.asyncio
async def test_plan_runtime_action_prefers_deterministic_search_fill_on_grounded_listing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_plan_browser_steps(**kwargs):
        raise AssertionError("LLM planner should not be used for grounded search correction")

    monkeypatch.setattr(step_planner_module, "plan_browser_steps", fake_plan_browser_steps)

    result = await step_planner_module.plan_runtime_action(
        execution_contract={
            "resolved_goal": "Find a shirt on Myntra",
            "current_execution_step": {
                "step_id": "phase_2",
                "kind": "search",
                "verification_rules": [{"kind": "search_query", "value": "shirt"}],
            },
            "ui_surface": {
                "kind": "listing",
                "search_query": "sshirt",
            },
        },
        current_url="https://www.myntra.com/sshirt?rawQuery=sshirt",
        current_page_title="Results",
        page_snapshot={
            "refs": {
                "e8": {"role": "textbox", "name": "Search for products, brands and more"},
                "e9": {"role": "link", "name": "Roadster Casual Shirt"},
            },
            "snapshot": '[ref=e8] textbox "Search for products, brands and more"\n[ref=e9] link "Roadster Casual Shirt"',
        },
    )

    assert result.status == "action"
    assert result.step is not None
    assert result.step.command == "type"
    assert result.step.value == "shirt"
    assert result.step.target is not None
    assert getattr(result.step.target, "ref", None) == "e8"


@pytest.mark.asyncio
async def test_plan_runtime_action_expands_search_surface_when_no_input_is_visible(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_plan_browser_steps(**kwargs):
        raise AssertionError("LLM planner should not be used when a search affordance is grounded")

    monkeypatch.setattr(step_planner_module, "plan_browser_steps", fake_plan_browser_steps)

    result = await step_planner_module.plan_runtime_action(
        execution_contract={
            "resolved_goal": "Search for fetch api on MDN",
            "current_execution_step": {
                "step_id": "phase_2",
                "kind": "search",
                "verification_rules": [{"kind": "search_query", "value": "fetch api"}],
            },
            "ui_surface": {
                "kind": "listing",
            },
        },
        current_url="https://developer.mozilla.org/en-US/",
        current_page_title="MDN Web Docs",
        page_snapshot={
            "refs": {
                "e2": {"role": "link", "name": "Skip to search"},
                "e3": {"role": "button", "name": "Learn"},
            },
            "snapshot": '[ref=e2] link "Skip to search"\n[ref=e3] button "Learn"',
        },
    )

    assert result.status == "action"
    assert result.step is not None
    assert result.step.command == "click"
    assert getattr(result.step.target, "ref", None) == "e2"
    assert result.evidence == {"source": "deterministic_search_affordance_step"}


@pytest.mark.asyncio
async def test_plan_runtime_action_submits_grounded_search_after_query_was_typed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_plan_browser_steps(**kwargs):
        raise AssertionError("LLM planner should not be used for grounded search submission")

    monkeypatch.setattr(step_planner_module, "plan_browser_steps", fake_plan_browser_steps)

    result = await step_planner_module.plan_runtime_action(
        execution_contract={
            "resolved_goal": "Search for fetch api on MDN",
            "current_execution_step": {
                "step_id": "phase_2",
                "kind": "search",
                "verification_rules": [{"kind": "search_query", "value": "fetch api"}],
            },
            "ui_surface": {
                "kind": "listing",
            },
            "recent_action_log": [
                {
                    "command": "click",
                    "label": "Click Search",
                },
                {
                    "command": "type",
                    "label": 'Type "fetch api"',
                },
            ],
        },
        current_url="https://developer.mozilla.org/en-US/",
        current_page_title="MDN Web Docs",
        page_snapshot={
            "refs": {
                "e2": {"role": "link", "name": "Skip to search"},
                "e8": {"role": "textbox", "name": "Search docs"},
            },
            "snapshot": '[ref=e2] link "Skip to search"\n[ref=e8] textbox "Search docs"',
        },
    )

    assert result.status == "action"
    assert result.step is not None
    assert result.step.command == "press"
    assert result.step.args == ["Enter"]
    assert result.evidence == {"source": "deterministic_search_submit_step"}


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


def test_completion_signals_prefer_label_specific_values_for_filter_and_do_not_genericize_selection() -> None:
    entities = {
        "target": "shirt",
        "app": "Myntra",
    }

    filter_signals = _completion_signals_for_phase(
        'Apply color filter "maroon"',
        entities,
        "Myntra",
    )
    select_signals = _completion_signals_for_phase(
        "Select the first product from the search results",
        entities,
        "Myntra",
    )

    assert "maroon" in filter_signals
    assert "shirt" not in filter_signals
    assert select_signals == []


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

    active_phase_index, phase_states, phase_fact_evidence, _ = _compute_phase_states(
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

    active_phase_index, phase_states, phase_fact_evidence, _ = _compute_phase_states(
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

    active_phase_index, phase_states, phase_fact_evidence, _ = _compute_phase_states(
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

    active_phase_index, phase_states, phase_fact_evidence, _ = _compute_phase_states(
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


def test_phase_fact_texts_ignores_low_specificity_runtime_entries() -> None:
    page_haystack, execution_haystack = _phase_fact_texts(
        current_snapshot={"snapshot": "Search results visible"},
        current_url="https://www.myntra.com/search?q=shirt",
        current_title="Search - Buy Search online in India",
        known_variables=None,
        completed_phase_evidence=None,
        recent_action_log=[
            {
                "label": 'Type "shirt"',
                "message": 'I finished: Type "shirt".',
                "status": "completed",
                "command": "type",
            },
            {
                "label": "Click the current page control",
                "message": "I finished: Click the current page control.",
                "status": "completed",
                "command": "click",
            },
            {
                "label": "Fill the search box",
                "message": 'I finished: Fill the search box with "shirt".',
                "status": "completed",
                "command": "fill",
            },
        ],
        current_runtime_action=None,
        status_summary="I finished: Click the current page control.",
    )

    assert "type shirt" not in execution_haystack
    assert "click the current page control" not in execution_haystack
    assert "fill the search box" in execution_haystack
    assert "myntra" in page_haystack


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

    active_phase_index, phase_states, _, _ = _compute_phase_states(
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
async def test_runtime_failure_is_not_overridden_by_weak_page_tokens_or_blocker_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = AutomationPlan(
        plan_id="plan-runtime-weak-verify",
        intent_id="intent-runtime-weak-verify",
        execution_mode="immediate",
        summary="Place an order on Myntra.",
        execution_contract=ExecutionContract(
            contract_id="contract-runtime-weak-verify",
            resolved_goal="Place an order for a maroon shirt on Myntra.",
            target_app="Myntra",
            target_entities={"app": "Myntra", "target": "shirt"},
            visible_state_evidence={"signals": ["Myntra", "shirt"]},
            verification_evidence={"checks": ["Myntra", "shirt"], "expected_state_change": "Place an order for a maroon shirt on Myntra."},
            completion_criteria=["The requested outcome is completed for: Place an order for a maroon shirt on Myntra."],
        ),
    )

    async def fake_capture_agent_browser_visual_context(**kwargs):  # type: ignore[no-untyped-def]
        _ = kwargs
        return (
            BrowserStateSnapshot(
                captured_at="2026-03-13T00:00:00+00:00",
                url="https://www.myntra.com/men-shirts?rawQuery=shirt&color=Maroon&size=M&priceRange=0-1000",
                title="Buy Men's shirts Online at India's Best Fashion Store | Myntra",
            ),
            {
                "url": "https://www.myntra.com/men-shirts?rawQuery=shirt&color=Maroon&size=M&priceRange=0-1000",
                "title": "Buy Men's shirts Online at India's Best Fashion Store | Myntra",
                "bodyText": "Myntra shirt results maroon size M under 1000",
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
        run_id="run-runtime-weak-verify",
        cdp_url="http://127.0.0.1:9222",
        plan=plan,
        page_registry={},
        active_page_ref=None,
        runtime_observation=None,
        runtime_text="Snapshots are still showing the search results page.",
        runtime_error="I am blocked. I am unable to navigate to the individual product page to place the order.",
    )

    assert resolved is False


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


def test_runtime_browser_observation_reads_raw_snapshot_event_payload() -> None:
    observation = _runtime_browser_observation_from_payload(
        {
            "operation": "snapshot",
            "result": {
                "targetId": "results-tab",
                "url": "https://developer.mozilla.org/en-US/search?q=fetch+api",
                "title": "Search | MDN",
                "snapshot": '[e22] link "Fetch API reference"\n[e23] link "Using the Fetch API"',
                "refs": {
                    "e22": {"role": "link", "name": "Fetch API reference"},
                    "e23": {"role": "link", "name": "Using the Fetch API"},
                },
            },
        },
    )

    assert observation["targetId"] == "results-tab"
    assert observation["url"] == "https://developer.mozilla.org/en-US/search?q=fetch+api"
    assert observation["title"] == "Search | MDN"
    assert observation["snapshot_text"] == '[e22] link "Fetch API reference"\n[e23] link "Using the Fetch API"'
    assert observation["refs"]["e22"]["name"] == "Fetch API reference"


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

    assert click_entry["label"] == "Click e44"
    assert click_entry["message"] == "I finished: Click e44."
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
    assert click_entry["label"] == "Click e44"
    assert click_entry["message"] == "I finished: Click e44."


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


def test_rebuild_page_registry_assigns_semantic_ref_for_known_open_site() -> None:
    page_registry, active_page_ref = _rebuild_page_registry_from_session(
        session_row={
            "page_id": "page-live-1",
            "pages": [
                {
                    "page_id": "page-live-1",
                    "url": "https://www.myntra.com/shirts",
                    "title": "Shirts - Myntra",
                    "is_active": True,
                }
            ],
        },
        existing_registry={},
        existing_active_page_ref=None,
    )

    assert active_page_ref == "page_myntra"
    assert page_registry["page_myntra"]["page_id"] == "page-live-1"


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


def test_register_soft_runtime_incident_promotes_repeated_ambiguous_action_to_terminal() -> None:
    incident = RuntimeIncident(
        incident_id="incident-ambiguous-1",
        category="ambiguity",
        severity="warning",
        code="RUNTIME_AMBIGUOUS_ACTION",
        summary="The agent is relying on ambiguous page actions instead of a concrete visible target.",
        details="Repeated vague page control clicks.",
        visible_signals=["low_specificity_action", "ambiguity"],
        requires_human=False,
        replannable=True,
        user_visible=True,
        browser_snapshot=BrowserStateSnapshot(
            captured_at="2026-03-13T00:00:00+00:00",
            url="https://example.com/cart",
            title="Cart",
            page_id="page_1",
        ),
        created_at="2026-03-13T00:00:00+00:00",
    )

    tracker, first_incident = _register_soft_runtime_incident(tracker={}, incident=incident)
    tracker, second_incident = _register_soft_runtime_incident(tracker=tracker, incident=incident)

    assert first_incident is not None
    assert first_incident.code == "RUNTIME_AMBIGUOUS_ACTION"
    assert second_incident is not None
    assert second_incident.code == "RUNTIME_AMBIGUOUS_ACTION_PERSISTED"
    assert second_incident.replannable is False


def test_runtime_action_low_specificity_allows_ref_backed_clicks() -> None:
    payload = {
        "toolName": "browser",
        "args": {"action": "click", "request": {"ref": "e12"}},
    }
    entry = {"label": "Click the current page control"}

    assert _runtime_action_low_specificity(payload=payload, entry=entry) is False


def test_runtime_action_low_specificity_flags_ref_only_text_entry_actions() -> None:
    payload = {
        "toolName": "browser",
        "args": {"action": "type", "request": {"ref": "e12", "text": "shirt"}},
    }
    entry = {"label": 'Type "shirt"'}

    assert _runtime_action_low_specificity(payload=payload, entry=entry) is True


def test_track_runtime_event_progress_reports_ambiguous_action_after_unchanged_snapshot() -> None:
    click_payload = {
        "toolName": "browser",
        "args": {"action": "click"},
    }
    click_entry = {"label": "Click the current page control"}
    tracker, incident = _track_runtime_event_progress(
        tracker={},
        payload=click_payload,
        observation={
            "url": "https://example.com/cart",
            "title": "Cart",
            "targetId": "page_1",
            "snapshot_text": "Checkout Cart Continue",
        },
        progress_entry=click_entry,
    )

    assert incident is None

    snapshot_payload = {
        "toolName": "browser",
        "args": {"action": "snapshot"},
    }
    snapshot_entry = {"label": "Inspect the current page state"}
    tracker, incident = _track_runtime_event_progress(
        tracker=tracker,
        payload=snapshot_payload,
        observation={
            "url": "https://example.com/cart",
            "title": "Cart",
            "targetId": "page_1",
            "snapshot_text": "Checkout Cart Continue",
        },
        progress_entry=snapshot_entry,
    )

    assert incident is not None
    assert incident.code == "RUNTIME_AMBIGUOUS_ACTION"


def test_track_runtime_event_progress_reports_ambiguous_action_after_repeated_low_specificity_mutation() -> None:
    click_payload = {
        "toolName": "browser",
        "args": {"action": "click"},
    }
    click_entry = {"label": "Click the current page control"}
    tracker, incident = _track_runtime_event_progress(
        tracker={},
        payload=click_payload,
        observation={
            "url": "https://example.com/cart",
            "title": "Cart",
            "targetId": "page_1",
            "snapshot_text": "Checkout Cart Continue",
        },
        progress_entry=click_entry,
    )

    assert incident is None

    tracker, incident = _track_runtime_event_progress(
        tracker=tracker,
        payload=click_payload,
        observation={
            "url": "https://example.com/cart",
            "title": "Cart",
            "targetId": "page_1",
            "snapshot_text": "Checkout Cart Continue",
        },
        progress_entry=click_entry,
    )

    assert incident is not None
    assert incident.code == "RUNTIME_AMBIGUOUS_ACTION"


def test_track_runtime_event_progress_reports_ambiguous_action_after_low_specificity_chain() -> None:
    click_payload = {
        "toolName": "browser",
        "args": {"action": "click"},
    }
    click_entry = {"label": "Click the current page control"}
    tracker, incident = _track_runtime_event_progress(
        tracker={},
        payload=click_payload,
        observation={
            "url": "https://example.com/cart",
            "title": "Cart",
            "targetId": "page_1",
            "snapshot_text": "Checkout Cart Continue",
        },
        progress_entry=click_entry,
    )
    assert incident is None

    snapshot_payload = {
        "toolName": "browser",
        "args": {"action": "snapshot"},
    }
    snapshot_entry = {"label": "Inspect the current page state"}
    tracker, incident = _track_runtime_event_progress(
        tracker=tracker,
        payload=snapshot_payload,
        observation={
            "url": "https://example.com/cart",
            "title": "Cart",
            "targetId": "page_1",
            "snapshot_text": "Checkout Cart Continue",
        },
        progress_entry=snapshot_entry,
    )
    assert incident is not None
    assert incident.code == "RUNTIME_AMBIGUOUS_ACTION"


def test_runtime_tool_progress_entry_parses_nested_request_action_without_top_level_action() -> None:
    entry = _runtime_tool_progress_entry(
        payload={
            "toolName": "browser",
            "args": {
                "request": {
                    "action": "click",
                    "ref": "e12",
                }
            },
        },
        status="completed",
    )

    assert entry["command"] == "click"
    assert entry["label"] == "Click e12"


def test_runtime_tool_progress_entry_parses_args_kind_without_top_level_action() -> None:
    entry = _runtime_tool_progress_entry(
        payload={
            "toolName": "browser",
            "args": {
                "kind": "snapshot",
                "request": {
                    "targetId": "page_1",
                },
            },
        },
        status="completed",
    )

    assert entry["command"] == "snapshot"
    assert entry["label"] == "Inspect the current page state"


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

    active_phase_index, phase_states, _, _ = _compute_phase_states(
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
