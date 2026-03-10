from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from fastapi import HTTPException

from oi_agent.automation.events import publish_event
from oi_agent.automation.executor import cancel_execution, has_live_execution, start_execution
from oi_agent.automation.models import (
    AutomationPlan,
    AutomationRun,
    AutomationScheduleCreateRequest,
    BrowserStateSnapshot,
    ConfirmIntentResponse,
    ExecutionProgress,
    ExecutionPhaseState,
    IntentDraft,
    ResolveExecutionRequest,
    ResolveExecutionResponse,
    ResumeContext,
    ResumeDecision,
    RunActionResponse,
    RunListResponse,
    RunArtifact,
    RunInterruptionRequest,
    RunProgressTracker,
    RunResponse,
    RunStatusSummary,
    RuntimeIncident,
    RunTransition,
    RunTransitionListResponse,
)
from oi_agent.automation.schedule_service import create_automation_schedule
from oi_agent.automation.planner_service import build_plan, build_plan_from_prompt
from oi_agent.automation.response_composer import (
    compose_confirmation_message,
    compose_interruption_message,
    compose_resolution_message,
    compose_run_action_message,
)
from oi_agent.automation.state_machine import ensure_action_allowed
from oi_agent.automation.store import (
    delete_run_records,
    find_run_by_intent,
    get_artifacts,
    get_intent,
    get_plan,
    get_run,
    list_run_transitions,
    list_runs_for_session,
    list_runs_for_user,
    list_runs_for_browser_session,
    save_run,
    save_run_transition,
    update_run,
)

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _normalize_execution_mode(value: str) -> str:
    mode = str(value or "").strip().lower()
    if mode in {"immediate", "once", "interval", "multi_time"}:
        return mode
    if mode == "cron":
        return "interval"
    return "once"


def _takeover_candidate_states() -> set[str]:
    return {
        "queued",
        "starting",
        "running",
        "paused",
        "waiting_for_user_action",
        "waiting_for_human",
        "human_controlling",
        "resuming",
        "retrying",
    }


_DELETABLE_RUN_STATES = {
    "completed",
    "succeeded",
    "failed",
    "cancelled",
    "canceled",
    "timed_out",
    "expired",
}


async def _capture_browser_state_snapshot(browser_session_id: str | None) -> BrowserStateSnapshot | None:
    if not browser_session_id:
        return None
    from oi_agent.api.websocket import connection_manager
    from oi_agent.automation.sessions.manager import browser_session_manager

    session = await browser_session_manager.get_session(browser_session_id)
    if session is None:
        return None
    frame = connection_manager.get_latest_session_frame(browser_session_id) or {}
    pages = [page.model_dump(mode="json") for page in session.pages]
    viewport = session.viewport.model_dump(mode="json") if session.viewport else {}
    screenshot_url = str(frame.get("screenshot", "") or "") or None
    return BrowserStateSnapshot(
        captured_at=_now_iso(),
        url=str(frame.get("current_url", "") or session.metadata.get("last_known_url", "") or "") or None,
        title=str(frame.get("page_title", "") or "") or None,
        page_id=str(frame.get("page_id", "") or session.page_id or "") or None,
        screenshot_url=screenshot_url,
        viewport=viewport,
        pages=pages,
        metadata={
            "origin": session.origin,
            "status": session.status,
            "provider": session.provider,
            "automation_engine": session.automation_engine,
        },
    )


async def _seed_run_page_context(
    browser_session_id: str | None,
) -> tuple[dict[str, dict[str, str]], str | None]:
    if not browser_session_id:
        return {}, None
    from oi_agent.automation.sessions.manager import browser_session_manager

    session = await browser_session_manager.get_session(browser_session_id)
    if session is None or not session.pages:
        return {}, None

    page_registry: dict[str, dict[str, str]] = {}
    active_page_ref: str | None = None
    active_page_id = str(session.page_id or "") or None

    for index, page in enumerate(session.pages):
        page_ref = f"page_{index}"
        page_registry[page_ref] = {
            "url": str(page.url or ""),
            "title": str(page.title or ""),
            "last_seen_at": _now_iso(),
        }
        if active_page_ref is None and (
            (active_page_id and str(page.page_id or "") == active_page_id)
            or bool(page.is_active)
        ):
            active_page_ref = page_ref

    if active_page_ref is None and page_registry:
        active_page_ref = next(iter(page_registry.keys()))

    return page_registry, active_page_ref


async def _enter_reconciliation(
    *,
    run: AutomationRun,
    trigger: str,
    actor_type: str,
    actor_id: str | None,
    reason_code: str,
    reason_text: str,
) -> AutomationRun:
    snapshot = await _capture_browser_state_snapshot(run.browser_session_id)
    incident = RuntimeIncident(
        incident_id=str(uuid.uuid4()),
        category="resume_reconciliation",
        severity="info",
        code=reason_code,
        summary=reason_text,
        details="Runtime state must be reconciled against the current UI before automation resumes.",
        visible_signals=[trigger, run.state],
        requires_human=False,
        replannable=True,
        user_visible=True,
        browser_snapshot=snapshot,
        created_at=_now_iso(),
    )
    resume_context = ResumeContext(
        resume_id=str(uuid.uuid4()),
        trigger=trigger,
        previous_state=run.state,
        current_step_index=run.current_step_index,
        current_plan_summary=(await get_plan(run.plan_id) or {}).get("summary"),
        browser_snapshot=snapshot,
        trigger_incident=run.runtime_incident,
        incident_id=incident.incident_id,
        created_at=_now_iso(),
    )
    decision = ResumeDecision(
        decision_id=str(uuid.uuid4()),
        status="pending_replan",
        rationale="The browser state may have changed during pause or human control. Reconciliation is required before resuming execution.",
        user_message="I captured the current browser state and will reconcile the remaining automation steps before resuming.",
        created_at=_now_iso(),
    )
    updated = await update_run(
        run.run_id,
        {
            "state": "reconciling",
            "updated_at": _now_iso(),
            "last_error": None,
            "runtime_incident": incident.model_dump(mode="json"),
            "resume_context": resume_context.model_dump(mode="json"),
            "resume_decision": decision.model_dump(mode="json"),
        },
    )
    assert updated is not None
    await record_run_transition(
        run_id=run.run_id,
        from_state=run.state,
        to_state="reconciling",
        reason_code=reason_code,
        reason_text=reason_text,
        actor_type=actor_type,
        actor_id=actor_id,
    )
    await publish_event(
        user_id=str(getattr(run, "user_id", "") or ""),
        session_id=run.session_id,
        run_id=run.run_id,
        event_type="run.reconciliation_requested",
        payload={
            "run_id": run.run_id,
            "trigger": trigger,
            "reason_code": reason_code,
            "reason": reason_text,
            "browser_snapshot": snapshot.model_dump(mode="json") if snapshot else None,
        },
    )
    return AutomationRun.model_validate(updated)


async def _send_extension_control(run: AutomationRun, command_type: str) -> None:
    _ = (run, command_type)
    return


async def create_run_for_plan(
    *,
    user_id: str,
    session_id: str,
    plan: AutomationPlan,
    execution_mode: str,
    run_times: list[str] | None = None,
    initial_state: str = "queued",
    executor_mode: str = "unknown",
    automation_engine: str = "agent_browser",
    browser_session_id: str | None = None,
) -> AutomationRun:
    normalized_mode = _normalize_execution_mode(execution_mode)
    normalized_engine = "agent_browser"
    page_registry, active_page_ref = await _seed_run_page_context(browser_session_id)
    phase_labels = [phase.label for phase in plan.predicted_plan.phases] if plan.predicted_plan and plan.predicted_plan.phases else []
    phase_states = [
        ExecutionPhaseState(
            phase_index=index,
            label=label,
            status="active" if index == 0 else "pending",
            last_updated_at=_now_iso(),
        )
        for index, label in enumerate(phase_labels)
    ]
    run = AutomationRun(
        run_id=str(uuid.uuid4()),
        plan_id=plan.plan_id,
        session_id=session_id,
        state=initial_state,  # type: ignore[arg-type]
        execution_mode=normalized_mode,  # type: ignore[arg-type]
        executor_mode=executor_mode,  # type: ignore[arg-type]
        automation_engine=normalized_engine,  # type: ignore[arg-type]
        browser_session_id=browser_session_id,
        current_step_index=None,
        total_steps=len(plan.steps),
        created_at=_now_iso(),
        updated_at=_now_iso(),
        scheduled_for=run_times or None,
        last_error=None,
        known_variables={},
        page_registry=page_registry,
        active_page_ref=active_page_ref,
        progress_tracker=RunProgressTracker(),
        execution_progress=ExecutionProgress(
            predicted_phases=list(phase_states),
            active_phase_index=0 if phase_states else None,
        ),
        active_phase_index=0 if phase_states else None,
        phase_states=phase_states,
    )
    raw_run = run.model_dump(mode="json")
    raw_run["user_id"] = user_id
    await save_run(run.run_id, raw_run)
    await publish_event(
        user_id=user_id,
        session_id=session_id,
        run_id=run.run_id,
        event_type="run.created",
        payload={"run": run.model_dump(mode="json")},
    )
    await record_run_transition(
        run_id=run.run_id,
        from_state=None,
        to_state=run.state,
        reason_code="RUN_CREATED",
        reason_text="Run created.",
        actor_type="system",
    )
    return run


async def _resolve_browser_session_for_run_creation(
    *,
    user_id: str,
    browser_session_id: str | None,
    executor_mode: str,
) -> tuple[str | None, str]:
    normalized_browser_session_id = str(browser_session_id or "").strip() or None
    normalized_executor_mode = str(executor_mode or "unknown").strip() or "unknown"
    if normalized_browser_session_id:
        return normalized_browser_session_id, normalized_executor_mode
    if normalized_executor_mode not in {"local_runner", "server_runner"}:
        return None, normalized_executor_mode

    from oi_agent.automation.sessions.manager import browser_session_manager

    expected_origin = "local_runner" if normalized_executor_mode == "local_runner" else "server_runner"
    sessions = await browser_session_manager.list_sessions(user_id=user_id)
    preferred: str | None = None
    fallback: str | None = None
    for session in sessions:
        if session.origin != expected_origin:
            continue
        metadata = dict(session.metadata or {})
        cdp_url = str(metadata.get("cdp_url", "") or "").strip()
        if not cdp_url:
            continue
        candidate = str(session.session_id or "").strip() or None
        if not candidate:
            continue
        if session.status == "ready":
            return candidate, normalized_executor_mode
        if session.status == "busy" and preferred is None:
            preferred = candidate
        elif fallback is None:
            fallback = candidate
    return preferred or fallback, normalized_executor_mode


async def record_run_transition(
    *,
    run_id: str,
    from_state: str | None,
    to_state: str,
    reason_code: str,
    reason_text: str = "",
    actor_type: str = "system",
    actor_id: str | None = None,
) -> RunTransition:
    transition = RunTransition(
        transition_id=str(uuid.uuid4()),
        run_id=run_id,
        from_state=from_state,  # type: ignore[arg-type]
        to_state=to_state,  # type: ignore[arg-type]
        reason_code=reason_code,
        reason_text=reason_text,
        actor_type=actor_type,  # type: ignore[arg-type]
        actor_id=actor_id,
        created_at=_now_iso(),
    )
    await save_run_transition(transition.transition_id, transition.model_dump(mode="json"))
    return transition


async def resolve_execution(request: ResolveExecutionRequest, user_id: str) -> ResolveExecutionResponse:
    raw_intent = await get_intent(request.intent_id)
    if (
        not raw_intent
        or raw_intent.get("session_id") != request.session_id
        or raw_intent.get("user_id") != user_id
    ):
        raise HTTPException(status_code=404, detail="Intent not found.")

    intent = IntentDraft.model_validate(raw_intent)
    intent.timing_mode = request.execution_mode
    plan = await build_plan(intent, request, user_id)

    run_state = "scheduled"
    status = "scheduled"
    run_times = list(request.schedule.run_at)
    if request.execution_mode == "immediate":
        run_state = "awaiting_confirmation" if intent.requires_confirmation else "queued"
        status = "awaiting_confirmation" if intent.requires_confirmation else "queued"
        run_times = [_now_iso()]
    else:
        await create_automation_schedule(
            user_id=user_id,
            payload=AutomationScheduleCreateRequest(
                session_id=request.session_id,
                prompt=intent.user_goal,
                execution_mode=request.execution_mode,
                executor_mode=request.executor_mode,
                automation_engine=request.automation_engine,
                browser_session_id=request.browser_session_id,
                schedule=request.schedule,
            ),
        )
        return ResolveExecutionResponse(
            assistant_message=compose_resolution_message("scheduled"),
            plan=plan,
            run=None,
            status="scheduled",
        )

    resolved_browser_session_id, resolved_executor_mode = await _resolve_browser_session_for_run_creation(
        user_id=user_id,
        browser_session_id=request.browser_session_id,
        executor_mode=request.executor_mode,
    )
    run = await create_run_for_plan(
        session_id=request.session_id,
        user_id=user_id,
        plan=plan,
        execution_mode=request.execution_mode,
        run_times=run_times or None,
        initial_state=run_state,
        executor_mode=resolved_executor_mode,
        automation_engine=request.automation_engine,
        browser_session_id=resolved_browser_session_id,
    )

    response = ResolveExecutionResponse(
        assistant_message=compose_resolution_message(status),
        plan=plan,
        run=run,
        status=status,  # type: ignore[arg-type]
    )
    if status == "queued":
        await publish_event(
            user_id=user_id,
            session_id=request.session_id,
            run_id=run.run_id,
            event_type="run.queued",
            payload={"run_id": run.run_id},
        )
        await start_execution(run.run_id)
    return response


async def create_and_execute_scheduled_run(schedule: dict[str, object]) -> tuple[AutomationRun, AutomationPlan]:
    schedule_id = str(schedule.get("schedule_id", "") or "")
    prompt = str(schedule.get("prompt", "") or "")
    user_id = str(schedule.get("user_id", "") or "")
    raw_device_id = schedule.get("device_id")
    raw_tab_id = schedule.get("tab_id")
    raw_browser_session_id = schedule.get("browser_session_id")
    device_id: str | None = raw_device_id if isinstance(raw_device_id, str) else None
    tab_id: int | None = raw_tab_id if isinstance(raw_tab_id, int) else None
    browser_session_id: str | None = raw_browser_session_id if isinstance(raw_browser_session_id, str) else None
    schedule_type = _normalize_execution_mode(str(schedule.get("schedule_type", "once") or "once"))
    executor_mode = str(schedule.get("executor_mode", "unknown") or "unknown")
    automation_engine = "agent_browser"
    session_id = f"schedule:{schedule_id or uuid.uuid4()}"
    plan = await build_plan_from_prompt(
        user_id=user_id,
        prompt=prompt,
        execution_mode=schedule_type,
        device_id=device_id,
        tab_id=tab_id,
        app_name=None,
        intent_id=f"scheduled:{schedule_id}",
    )
    run = await create_run_for_plan(
        user_id=user_id,
        session_id=session_id,
        plan=plan,
        execution_mode=schedule_type,
        run_times=[str(schedule.get("next_run_at", "") or _now_iso())],
        initial_state="queued",
        executor_mode=executor_mode,
        automation_engine=automation_engine,
        browser_session_id=browser_session_id,
    )
    await publish_event(
        user_id=user_id,
        session_id=session_id,
        run_id=run.run_id,
        event_type="schedule.created",
        payload={"schedule_id": schedule_id, "run_times": run.scheduled_for or []},
    )
    _ = user_id
    return run, plan


async def confirm_intent(user_id: str, session_id: str, intent_id: str, confirmed: bool) -> ConfirmIntentResponse:
    raw_intent = await get_intent(intent_id)
    if (
        not raw_intent
        or raw_intent.get("session_id") != session_id
        or raw_intent.get("user_id") != user_id
    ):
        raise HTTPException(status_code=404, detail="Intent not found.")

    raw_run = await find_run_by_intent(session_id, intent_id)
    if raw_run is None:
        raise HTTPException(status_code=404, detail="Run not found.")
    _assert_run_owner(raw_run, user_id)

    run = AutomationRun.model_validate(raw_run)
    raw_plan = await get_plan(run.plan_id)
    if not raw_plan:
        raise HTTPException(status_code=404, detail="Plan not found.")
    plan = AutomationPlan.model_validate(raw_plan)

    if not confirmed:
        previous_state = run.state
        updated = await update_run(
            run.run_id,
            {"state": "cancelled", "updated_at": _now_iso()},
        )
        assert updated is not None
        await record_run_transition(
            run_id=run.run_id,
            from_state=previous_state,
            to_state="cancelled",
            reason_code="INTENT_REJECTED",
            reason_text="User declined confirmation.",
            actor_type="user",
        )
        return ConfirmIntentResponse(
            assistant_message=compose_confirmation_message(False),
            plan=plan,
            run=AutomationRun.model_validate(updated),
        )

    next_state = "queued" if run.execution_mode == "immediate" else "scheduled"
    previous_state = run.state
    updated = await update_run(
        run.run_id,
        {"state": next_state, "updated_at": _now_iso()},
    )
    assert updated is not None
    await record_run_transition(
        run_id=run.run_id,
        from_state=previous_state,
        to_state=next_state,
        reason_code="INTENT_CONFIRMED",
        reason_text="Intent confirmed.",
        actor_type="user",
    )
    response = ConfirmIntentResponse(
        assistant_message=compose_confirmation_message(True),
        plan=plan,
        run=AutomationRun.model_validate(updated),
    )
    if next_state == "queued":
        await publish_event(
            user_id=user_id,
            session_id=session_id,
            run_id=run.run_id,
            event_type="run.queued",
            payload={"run_id": run.run_id},
        )
        await start_execution(run.run_id)
    return response


def _assert_run_owner(raw_run: dict[str, object], user_id: str) -> None:
    if str(raw_run.get("user_id", "") or "") != user_id:
        logger.warning(
            "run_owner_mismatch",
            extra={
                "run_id": str(raw_run.get("run_id", "") or ""),
                "requested_user_id": user_id,
                "owner_user_id": str(raw_run.get("user_id", "") or ""),
            },
        )
        raise HTTPException(status_code=404, detail="Run not found.")


def _build_run_status_summary(run: AutomationRun, plan: AutomationPlan) -> RunStatusSummary:
    counts = {
        "pending": 0,
        "running": 0,
        "completed": 0,
        "failed": 0,
        "skipped": 0,
    }
    for step in plan.steps:
        step_status = step.status or "pending"
        if step_status in counts:
            counts[step_status] += 1

    total_steps = len(plan.steps)
    all_steps_completed = total_steps > 0 and counts["completed"] + counts["skipped"] == total_steps
    failed_states = {"failed", "cancelled", "canceled", "timed_out", "expired"}
    waiting_states = {
        "awaiting_clarification",
        "awaiting_execution_mode",
        "awaiting_confirmation",
        "paused",
        "waiting_for_user_action",
        "waiting_for_human",
        "human_controlling",
    }
    pending_states = {"draft", "scheduled", "queued"}

    if run.state in failed_states or counts["failed"] > 0:
        status = "failed"
    elif run.state in {"completed", "succeeded"} and all_steps_completed:
        status = "success"
    elif run.state in waiting_states:
        status = "waiting"
    elif run.state in pending_states:
        status = "pending"
    else:
        status = "in_progress"

    return RunStatusSummary(
        status=status,
        is_terminal=status in {"success", "failed"},
        is_success=status == "success",
        all_steps_completed=all_steps_completed,
        total_steps=total_steps,
        pending_steps=counts["pending"],
        running_steps=counts["running"],
        completed_steps=counts["completed"],
        failed_steps=counts["failed"],
        skipped_steps=counts["skipped"],
    )

async def list_runs_response(
    user_id: str,
    *,
    session_id: str | None = None,
    limit: int = 20,
) -> RunListResponse:
    safe_limit = max(1, min(limit, 100))
    raw_runs = (
        await list_runs_for_session(user_id, session_id, limit=safe_limit)
        if session_id
        else await list_runs_for_user(user_id, limit=safe_limit)
    )
    items: list[RunResponse] = []
    for raw_run in raw_runs:
        run = AutomationRun.model_validate(raw_run)
        raw_plan = await get_plan(run.plan_id)
        if not raw_plan:
            continue
        if str(raw_plan.get("user_id", "") or "") != user_id:
            continue
        plan = AutomationPlan.model_validate(raw_plan)
        plan = plan.model_copy(
            update={"steps": [step.with_response_command_payload() for step in plan.steps]}
        )
        artifacts = [RunArtifact.model_validate(item) for item in await get_artifacts(run.run_id)]
        items.append(
            RunResponse(
                run=run,
                plan=plan,
                artifacts=artifacts,
                status=_build_run_status_summary(run, plan),
            )
        )
    return RunListResponse(items=items)


async def get_run_response(user_id: str, run_id: str) -> RunResponse:
    raw_run = await get_run(run_id)
    if not raw_run:
        raise HTTPException(status_code=404, detail="Run not found.")
    _assert_run_owner(raw_run, user_id)
    run = AutomationRun.model_validate(raw_run)
    raw_plan = await get_plan(run.plan_id)
    if not raw_plan:
        raise HTTPException(status_code=404, detail="Plan not found.")
    if str(raw_plan.get("user_id", "") or "") != user_id:
        raise HTTPException(status_code=404, detail="Plan not found.")
    plan = AutomationPlan.model_validate(raw_plan)
    plan = plan.model_copy(
        update={"steps": [step.with_response_command_payload() for step in plan.steps]}
    )
    artifacts = [RunArtifact.model_validate(item) for item in await get_artifacts(run_id)]
    return RunResponse(
        run=run,
        plan=plan,
        artifacts=artifacts,
        status=_build_run_status_summary(run, plan),
    )


async def get_run_transitions_response(user_id: str, run_id: str) -> RunTransitionListResponse:
    raw_run = await get_run(run_id)
    if not raw_run:
        raise HTTPException(status_code=404, detail="Run not found.")
    _assert_run_owner(raw_run, user_id)
    items = [RunTransition.model_validate(item) for item in await list_run_transitions(run_id)]
    return RunTransitionListResponse(items=items)


async def delete_stale_run(user_id: str, run_id: str) -> dict[str, object]:
    raw_run = await get_run(run_id)
    if not raw_run:
        raise HTTPException(status_code=404, detail="Run not found.")
    run = AutomationRun.model_validate(raw_run)
    if run.user_id != user_id:
        raise HTTPException(status_code=404, detail="Run not found.")
    if run.state not in _DELETABLE_RUN_STATES:
        raise HTTPException(
            status_code=409,
            detail=f"Run in state '{run.state}' cannot be deleted while it may still be active.",
        )
    await delete_run_records(run_id)
    return {"ok": True, "run_id": run_id}


async def mark_browser_session_human_control(
    *,
    browser_session_id: str,
    actor_id: str,
) -> AutomationRun | None:
    candidates = await list_runs_for_browser_session(browser_session_id)
    for row in candidates:
        run = AutomationRun.model_validate(row)
        if run.state not in _takeover_candidate_states() or run.state == "human_controlling":
            continue
        updated = await update_run(
            run.run_id,
            {"state": "human_controlling", "updated_at": _now_iso()},
        )
        assert updated is not None
        await record_run_transition(
            run_id=run.run_id,
            from_state=run.state,
            to_state="human_controlling",
            reason_code="HUMAN_TAKEOVER_STARTED",
            reason_text="A human controller acquired the linked browser session.",
            actor_type="user",
            actor_id=actor_id,
        )
        await publish_event(
            user_id=str(row.get("user_id", "") or ""),
            session_id=run.session_id,
            run_id=run.run_id,
            event_type="run.paused",
            payload={"run_id": run.run_id, "reason": "Human takeover started"},
        )
        return AutomationRun.model_validate(updated)
    return None


async def release_browser_session_human_control(
    *,
    browser_session_id: str,
    actor_id: str,
) -> AutomationRun | None:
    candidates = await list_runs_for_browser_session(browser_session_id)
    for row in candidates:
        run = AutomationRun.model_validate(row)
        if run.state != "human_controlling":
            continue
        updated_run = await _enter_reconciliation(
            run=run,
            trigger="human_control_released",
            actor_type="user",
            actor_id=actor_id,
            reason_code="HUMAN_TAKEOVER_RELEASED",
            reason_text="Human controller released the linked browser session. The current UI state must be reconciled before resuming.",
        )
        if not await has_live_execution(run.run_id):
            await start_execution(run.run_id)
        return updated_run
    return None


async def mutate_run_state(
    user_id: str,
    run_id: str,
    action: str,
    *,
    browser_session_id: str | None = None,
) -> RunActionResponse:
    logger.info(
        "run_action_requested",
        extra={
            "run_id": run_id,
            "action": action,
            "user_id": user_id,
            "browser_session_id": str(browser_session_id or "") or None,
        },
    )
    raw_run = await get_run(run_id)
    if not raw_run:
        logger.warning(
            "run_action_run_missing",
            extra={
                "run_id": run_id,
                "action": action,
                "user_id": user_id,
            },
        )
        raise HTTPException(status_code=404, detail="Run not found.")
    _assert_run_owner(raw_run, user_id)
    run = AutomationRun.model_validate(raw_run)
    ensure_action_allowed(run.state, action)

    if action == "resume":
        run_out = await _enter_reconciliation(
            run=run,
            trigger="manual_resume",
            actor_type="user",
            actor_id=None,
            reason_code="RUN_RESUME_REQUESTED",
            reason_text="Resume requested. The current UI state will be reconciled before continuing.",
        )
        if not await has_live_execution(run_id):
            await start_execution(run_id)
        return RunActionResponse(
            run=run_out,
            assistant_message=compose_run_action_message(action),
        )

    state_map = {
        "pause": ("paused", "The automation is paused."),
        "stop": ("cancelled", "The automation has been stopped."),
        "retry": ("starting", "Retry requested. The automation is starting again."),
    }
    next_state, text = state_map[action]
    updated = await update_run(
        run_id,
        {"state": next_state, "updated_at": _now_iso()},
    )
    assert updated is not None
    await record_run_transition(
        run_id=run_id,
        from_state=run.state,
        to_state=next_state,
        reason_code=f"RUN_{action.upper()}",
        reason_text=text,
        actor_type="user",
    )
    run_out = AutomationRun.model_validate(updated)
    event_type = {
        "pause": "run.paused",
        "resume": "run.resumed",
        "stop": "run.interrupted_by_user",
        "retry": "run.started",
    }[action]
    payload: dict[str, object] = {"run_id": run_id}
    if action == "pause":
        payload["reason"] = "Paused by user"
        await _send_extension_control(run, "yield_control")
    elif action == "stop":
        payload["message"] = "I stopped the automation because you cancelled it."
        await _send_extension_control(run, "yield_control")
        await cancel_execution(run_id)
    elif action == "retry":
        payload["run_id"] = run_id
        retry_patch: dict[str, object] = {
            "state": "starting",
            "updated_at": _now_iso(),
            "last_error": None,
        }
        normalized_browser_session_id = str(browser_session_id or "").strip() or None
        if normalized_browser_session_id is not None:
            from oi_agent.automation.sessions.manager import browser_session_manager

            session = await browser_session_manager.get_session(normalized_browser_session_id)
            if session is None or session.user_id != user_id:
                raise HTTPException(status_code=404, detail="Browser session not found.")
            retry_patch["browser_session_id"] = normalized_browser_session_id
        await update_run(run_id, retry_patch)
        run_out = AutomationRun.model_validate((await get_run(run_id)) or updated)
        await start_execution(run_id)
    await publish_event(
        user_id=user_id,
        session_id=run.session_id,
        run_id=run_id,
        event_type=event_type,
        payload=payload,
    )
    return RunActionResponse(
        run=run_out,
        assistant_message=compose_run_action_message(action),
    )


async def approve_sensitive_action(user_id: str, run_id: str) -> RunActionResponse:
    raw_run = await get_run(run_id)
    if not raw_run:
        raise HTTPException(status_code=404, detail="Run not found.")
    _assert_run_owner(raw_run, user_id)
    run = AutomationRun.model_validate(raw_run)
    ensure_action_allowed(run.state, "approve_sensitive_action")
    run_out = await _enter_reconciliation(
        run=run,
        trigger="sensitive_action_approved",
        actor_type="user",
        actor_id=None,
        reason_code="SENSITIVE_ACTION_APPROVED",
        reason_text="Sensitive action approved by the user. The current UI state will be reconciled before continuing.",
    )
    if not await has_live_execution(run_id):
        await start_execution(run_id)
    return RunActionResponse(
        run=run_out,
        assistant_message=compose_run_action_message("approve_sensitive_action"),
    )


async def report_run_interruption(user_id: str, run_id: str, payload: RunInterruptionRequest) -> RunActionResponse:
    raw_run = await get_run(run_id)
    if not raw_run:
        raise HTTPException(status_code=404, detail="Run not found.")
    _assert_run_owner(raw_run, user_id)
    run = AutomationRun.model_validate(raw_run)
    ensure_action_allowed(run.state, "interrupt")
    updated = await update_run(
        run_id,
        {"state": "paused", "updated_at": _now_iso()},
    )
    assert updated is not None
    await record_run_transition(
        run_id=run_id,
        from_state=run.state,
        to_state="paused",
        reason_code="RUN_INTERRUPTED",
        reason_text=payload.reason or "Run interrupted.",
        actor_type="user" if payload.source == "user" else "system",
    )
    await _send_extension_control(run, "yield_control")
    reason = compose_interruption_message(payload.reason).text
    await publish_event(
        user_id=user_id,
        session_id=run.session_id,
        run_id=run_id,
        event_type="run.interrupted_by_user",
        payload={
            "run_id": run_id,
            "message": reason,
            "source": payload.source,
            "resumable": True,
        },
    )
    return RunActionResponse(
        run=AutomationRun.model_validate(updated),
        assistant_message=compose_interruption_message(reason),
    )
