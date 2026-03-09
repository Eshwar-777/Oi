from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import HTTPException

from oi_agent.automation.events import publish_event
from oi_agent.automation.executor import cancel_execution, has_live_execution, start_execution
from oi_agent.automation.models import (
    AutomationPlan,
    AutomationRun,
    ConfirmIntentResponse,
    IntentDraft,
    ResolveExecutionRequest,
    ResolveExecutionResponse,
    RunActionResponse,
    RunArtifact,
    RunInterruptionRequest,
    RunResponse,
)
from oi_agent.automation.planner_service import build_plan, build_plan_from_prompt
from oi_agent.automation.response_composer import (
    compose_confirmation_message,
    compose_interruption_message,
    compose_resolution_message,
    compose_run_action_message,
)
from oi_agent.automation.state_machine import ensure_action_allowed
from oi_agent.automation.store import (
    find_run_by_intent,
    get_artifacts,
    get_intent,
    get_plan,
    get_run,
    save_run,
    update_run,
)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _normalize_execution_mode(value: str) -> str:
    mode = str(value or "").strip().lower()
    if mode in {"immediate", "once", "interval", "multi_time"}:
        return mode
    if mode == "cron":
        return "interval"
    return "once"


async def _send_extension_control(run: AutomationRun, command_type: str) -> None:
    raw_plan = await get_plan(run.plan_id)
    if not raw_plan:
        return
    plan = AutomationPlan.model_validate(raw_plan)
    target = plan.targets[0] if plan.targets else None
    device_id = target.device_id if target else None
    tab_id = target.tab_id if target else None
    if not device_id:
        return
    from oi_agent.api.websocket import connection_manager

    payload: dict[str, object] = {"run_id": run.run_id}
    if tab_id is not None:
        payload["tab_id"] = tab_id
    await connection_manager.send_to_device(device_id, {"type": command_type, "payload": payload})


async def create_run_for_plan(
    *,
    user_id: str,
    session_id: str,
    plan: AutomationPlan,
    execution_mode: str,
    run_times: list[str] | None = None,
    initial_state: str = "queued",
) -> AutomationRun:
    normalized_mode = _normalize_execution_mode(execution_mode)
    run = AutomationRun(
        run_id=str(uuid.uuid4()),
        plan_id=plan.plan_id,
        session_id=session_id,
        state=initial_state,  # type: ignore[arg-type]
        execution_mode=normalized_mode,  # type: ignore[arg-type]
        current_step_index=None,
        total_steps=len(plan.steps),
        created_at=_now_iso(),
        updated_at=_now_iso(),
        scheduled_for=run_times or None,
        last_error=None,
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
    return run


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
    elif request.execution_mode == "interval" and request.schedule.interval_seconds:
        status = "scheduled"

    run = await create_run_for_plan(
        session_id=request.session_id,
        user_id=user_id,
        plan=plan,
        execution_mode=request.execution_mode,
        run_times=run_times or None,
        initial_state=run_state,
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
    device_id: str | None = raw_device_id if isinstance(raw_device_id, str) else None
    tab_id: int | None = raw_tab_id if isinstance(raw_tab_id, int) else None
    schedule_type = _normalize_execution_mode(str(schedule.get("schedule_type", "once") or "once"))
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
        updated = await update_run(
            run.run_id,
            {"state": "cancelled", "updated_at": _now_iso()},
        )
        assert updated is not None
        return ConfirmIntentResponse(
            assistant_message=compose_confirmation_message(False),
            plan=plan,
            run=AutomationRun.model_validate(updated),
        )

    next_state = "queued" if run.execution_mode == "immediate" else "scheduled"
    updated = await update_run(
        run.run_id,
        {"state": next_state, "updated_at": _now_iso()},
    )
    assert updated is not None
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
        raise HTTPException(status_code=404, detail="Run not found.")


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
    artifacts = [RunArtifact.model_validate(item) for item in await get_artifacts(run_id)]
    return RunResponse(run=run, plan=plan, artifacts=artifacts)


async def mutate_run_state(user_id: str, run_id: str, action: str) -> RunActionResponse:
    raw_run = await get_run(run_id)
    if not raw_run:
        raise HTTPException(status_code=404, detail="Run not found.")
    _assert_run_owner(raw_run, user_id)
    run = AutomationRun.model_validate(raw_run)
    ensure_action_allowed(run.state, action)

    state_map = {
        "pause": ("paused", "The automation is paused."),
        "resume": ("running", "The automation is ready to continue."),
        "stop": ("cancelled", "The automation has been stopped."),
        "retry": ("retrying", "Retry requested. The automation is being prepared again."),
    }
    next_state, text = state_map[action]
    updated = await update_run(
        run_id,
        {"state": next_state, "updated_at": _now_iso()},
    )
    assert updated is not None
    run_out = AutomationRun.model_validate(updated)
    event_type = {
        "pause": "run.paused",
        "resume": "run.resumed",
        "stop": "run.interrupted_by_user",
        "retry": "run.queued",
    }[action]
    payload: dict[str, object] = {"run_id": run_id}
    if action == "pause":
        payload["reason"] = "Paused by user"
        await _send_extension_control(run, "yield_control")
    elif action == "stop":
        payload["message"] = "I stopped the automation because you cancelled it."
        await _send_extension_control(run, "yield_control")
        await cancel_execution(run_id)
    elif action == "resume":
        await _send_extension_control(run, "resume_automation")
        if not await has_live_execution(run_id):
            await update_run(run_id, {"state": "queued", "updated_at": _now_iso()})
            run_out = AutomationRun.model_validate((await get_run(run_id)) or updated)
            await publish_event(
                user_id=user_id,
                session_id=run.session_id,
                run_id=run_id,
                event_type="run.queued",
                payload={"run_id": run_id},
            )
            await start_execution(run_id)
    elif action == "retry":
        payload["run_id"] = run_id
        await update_run(run_id, {"state": "queued", "updated_at": _now_iso(), "last_error": None})
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
