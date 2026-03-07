from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from typing import Any

from oi_agent.api.browser.common import (
    fetch_page_snapshot,
    resolve_device_and_tab_for_prompt,
)
from oi_agent.automation.events import publish_event
from oi_agent.automation.models import (
    AutomationPlan,
    AutomationRun,
    AutomationStep,
    RunArtifact,
    RunError,
)
from oi_agent.automation.response_composer import (
    compose_cancellation_payload,
    compose_completion_payload,
)
from oi_agent.automation.state_machine import is_terminal_state
from oi_agent.automation.store import (
    get_plan,
    get_run,
    save_artifacts,
    save_plan,
    update_run,
)
from oi_agent.services.tools.base import ToolContext
from oi_agent.services.tools.browser_automation import BrowserAutomationTool
from oi_agent.services.tools.navigator.prompt_rewriter import rewrite_user_prompt
from oi_agent.services.tools.step_planner import plan_browser_steps

_tasks: dict[str, asyncio.Task[None]] = {}
_task_lock = asyncio.Lock()


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _coerce_step_kind(action: str) -> str:
    known = {"navigate", "click", "type", "scroll", "wait", "extract", "hover", "select"}
    return action if action in known else "unknown"


def _steps_from_browser_plan(steps: list[dict[str, Any]]) -> list[AutomationStep]:
    rows: list[AutomationStep] = []
    for idx, step in enumerate(steps):
        if not isinstance(step, dict) or step.get("type") != "browser":
            continue
        action = str(step.get("action", "")).strip().lower()
        label = str(step.get("description") or action.title() or f"Step {idx + 1}").strip()
        rows.append(
            AutomationStep(
                step_id=str(step.get("id") or f"s{idx + 1}"),
                kind=_coerce_step_kind(action),  # type: ignore[arg-type]
                label=label,
                description=label,
                status="pending",
            )
        )
    return rows


async def _update_plan_steps(plan_id: str, steps: list[AutomationStep]) -> AutomationPlan:
    raw_plan = await get_plan(plan_id)
    if raw_plan is None:
        raise RuntimeError("Plan not found during execution.")
    raw_plan["steps"] = [step.model_dump(mode="json") for step in steps]
    await save_plan(plan_id, raw_plan)
    return AutomationPlan.model_validate(raw_plan)


async def _set_run_state(run_id: str, state: str, error: RunError | None = None) -> AutomationRun:
    updated = await update_run(
        run_id,
        {
            "state": state,
            "updated_at": _now_iso(),
            "last_error": error.model_dump(mode="json") if error else None,
        },
    )
    if updated is None:
        raise RuntimeError("Run not found during execution.")
    return AutomationRun.model_validate(updated)


async def _update_run_progress(run_id: str, index: int | None) -> AutomationRun:
    updated = await update_run(
        run_id,
        {
            "current_step_index": index,
            "updated_at": _now_iso(),
        },
    )
    if updated is None:
        raise RuntimeError("Run not found during execution.")
    return AutomationRun.model_validate(updated)


async def _wait_if_paused_or_cancelled(run_id: str, session_id: str) -> None:
    _ = session_id
    while True:
        raw_run = await get_run(run_id)
        if raw_run is None:
            raise RuntimeError("Run not found.")
        state = str(raw_run.get("state", ""))
        if state == "paused":
            await asyncio.sleep(0.1)
            continue
        if state == "cancelled":
            raise asyncio.CancelledError()
        return


async def _publish_step_event(
    *,
    session_id: str,
    run_id: str,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    await publish_event(session_id=session_id, run_id=run_id, event_type=event_type, payload=payload)


async def execute_run(run_id: str) -> None:
    raw_run = await get_run(run_id)
    if raw_run is None:
        return
    run = AutomationRun.model_validate(raw_run)
    raw_plan = await get_plan(run.plan_id)
    if raw_plan is None:
        await _set_run_state(
            run_id,
            "failed",
            RunError(code="PLAN_NOT_FOUND", message="Automation plan not found.", retryable=False),
        )
        return
    plan = AutomationPlan.model_validate(raw_plan)
    session_id = run.session_id

    try:
        await publish_event(
            session_id=session_id,
            run_id=run_id,
            event_type="run.started",
            payload={"run_id": run_id},
        )
        run = await _set_run_state(run_id, "running")

        prompt = plan.summary
        device_id, tab_id = resolve_device_and_tab_for_prompt(
            prompt=prompt,
            device_id=plan.targets[0].device_id if plan.targets else None,
            tab_id=plan.targets[0].tab_id if plan.targets else None,
        )
        if plan.targets:
            plan.targets[0].device_id = device_id
            plan.targets[0].tab_id = tab_id
            raw_plan = await get_plan(plan.plan_id)
            assert raw_plan is not None
            raw_plan["targets"] = [target.model_dump(mode="json") for target in plan.targets]
            await save_plan(plan.plan_id, raw_plan)
        snapshot = await fetch_page_snapshot(device_id, tab_id, f"run-{run_id}")
        rewritten_prompt = await rewrite_user_prompt(
            user_prompt=prompt,
            current_url=str((snapshot or {}).get("url", "") or ""),
            current_page_title=str((snapshot or {}).get("title", "") or ""),
            model_override=plan.model_id,
        )
        browser_plan = await plan_browser_steps(
            user_prompt=rewritten_prompt,
            current_url=str((snapshot or {}).get("url", "") or ""),
            current_page_title=str((snapshot or {}).get("title", "") or ""),
            page_snapshot=snapshot,
            structured_context=None,
            model_override=plan.model_id,
        )
        browser_steps = [
            step for step in browser_plan.get("steps", []) if isinstance(step, dict) and step.get("type") == "browser"
        ]
        plan = await _update_plan_steps(plan.plan_id, _steps_from_browser_plan(browser_steps))
        await update_run(run_id, {"total_steps": len(plan.steps), "updated_at": _now_iso()})

        async def before_step(step_index: int, step: dict[str, Any]) -> None:
            await _wait_if_paused_or_cancelled(run_id, session_id)
            await _update_run_progress(run_id, step_index)
            step_id = str(step.get("id") or f"s{step_index + 1}")
            label = str(step.get("description") or step.get("action") or f"Step {step_index + 1}")
            if step_index < len(plan.steps):
                rows = [row.model_dump(mode="json") for row in plan.steps]
                rows[step_index]["status"] = "running"
                rows[step_index]["started_at"] = _now_iso()
                raw_plan = await get_plan(plan.plan_id)
                assert raw_plan is not None
                raw_plan["steps"] = rows
                await save_plan(plan.plan_id, raw_plan)
            await _publish_step_event(
                session_id=session_id,
                run_id=run_id,
                event_type="step.started",
                payload={"run_id": run_id, "step_id": step_id, "index": step_index, "label": label},
            )

        async def after_step(step_index: int, step: dict[str, Any], result: dict[str, Any]) -> None:
            step_id = str(step.get("id") or f"s{step_index + 1}")
            status = str(result.get("status", "") or "")
            label = str(step.get("description") or step.get("action") or f"Step {step_index + 1}")
            rows = [row.model_dump(mode="json") for row in plan.steps]
            if step_index < len(rows):
                rows[step_index]["completed_at"] = _now_iso()
                rows[step_index]["status"] = "completed" if status != "error" else "failed"
                screenshot = str(result.get("screenshot", "") or "")
                if screenshot:
                    rows[step_index]["screenshot_url"] = screenshot
            raw_plan = await get_plan(plan.plan_id)
            assert raw_plan is not None
            raw_plan["steps"] = rows
            await save_plan(plan.plan_id, raw_plan)
            screenshot = str(result.get("screenshot", "") or "")
            if screenshot:
                artifacts = await save_screenshot_artifact(run_id, step_id, screenshot)
                _ = artifacts
            event_type = "step.completed" if status != "error" else "step.failed"
            payload = {
                "run_id": run_id,
                "step_id": step_id,
                "index": step_index,
                "label": label,
                "screenshot_url": screenshot or None,
            }
            if status == "error":
                payload.update(
                    {
                        "code": "ELEMENT_NOT_FOUND",
                        "message": str(result.get("data", "") or "Step failed"),
                        "retryable": True,
                    }
                )
            await _publish_step_event(session_id=session_id, run_id=run_id, event_type=event_type, payload=payload)

        context = ToolContext(
            automation_id=f"run-{run_id}",
            user_id="automation-user",
            action_config={
                "type": "browser_automation",
                "device_id": device_id,
                "tab_id": tab_id,
                "run_id": run_id,
                "before_step": before_step,
                "after_step": after_step,
            },
            data_sources=[],
            trigger_config={"type": "manual"},
            automation_name="Automation Run",
            automation_description=rewritten_prompt,
            execution_mode="autopilot",
        )
        result = await BrowserAutomationTool().execute(context, [{"steps": browser_steps}])
        if not result.success:
            message = result.error or "Automation failed."
            lowered = message.lower()
            if any(
                token in lowered
                for token in (
                    "manual intervention required",
                    "security_gate",
                    "captcha",
                    "otp",
                    "2fa",
                    "login required",
                    "payment",
                    "permission",
                )
            ):
                await _set_run_state(run_id, "waiting_for_user_action")
                await publish_event(
                    session_id=session_id,
                    run_id=run_id,
                    event_type="run.waiting_for_user_action",
                    payload={"run_id": run_id, "reason": message},
                )
                return
            error = RunError(
                code="EXECUTION_FAILED",
                message=message,
                retryable=True,
            )
            await _set_run_state(run_id, "failed", error)
            await publish_event(
                session_id=session_id,
                run_id=run_id,
                event_type="run.failed",
                payload={"run_id": run_id, "code": error.code, "message": error.message, "retryable": error.retryable},
            )
            return

        last_screenshot = str(result.metadata.get("last_screenshot", "") or "")
        if last_screenshot:
            await save_screenshot_artifact(run_id, "final", last_screenshot)
        await _update_run_progress(run_id, len(plan.steps) - 1 if plan.steps else None)
        await _set_run_state(run_id, "completed")
        await publish_event(
            session_id=session_id,
            run_id=run_id,
            event_type="run.completed",
            payload={"run_id": run_id, **compose_completion_payload(result.text)},
        )
    except asyncio.CancelledError:
        raw_run = await get_run(run_id)
        current_state = str((raw_run or {}).get("state", ""))
        if not is_terminal_state(current_state):
            await _set_run_state(run_id, "cancelled")
        await publish_event(
            session_id=session_id,
            run_id=run_id,
            event_type="run.interrupted_by_user",
            payload={
                "run_id": run_id,
                **compose_cancellation_payload(),
            },
        )
    except Exception as exc:
        error = RunError(code="EXECUTION_FAILED", message=str(exc), retryable=True)
        await _set_run_state(run_id, "failed", error)
        await publish_event(
            session_id=session_id,
            run_id=run_id,
            event_type="run.failed",
            payload={"run_id": run_id, "code": error.code, "message": error.message, "retryable": error.retryable},
        )
    finally:
        async with _task_lock:
            _tasks.pop(run_id, None)


async def save_screenshot_artifact(run_id: str, step_id: str, screenshot_url: str) -> list[dict[str, Any]]:
    artifacts = await get_run_artifacts(run_id)
    artifacts.append(
        RunArtifact(
            artifact_id=f"{run_id}-{step_id}-{len(artifacts) + 1}",
            type="screenshot",
            url=screenshot_url,
            created_at=_now_iso(),
            step_id=step_id,
        ).model_dump(mode="json")
    )
    await save_artifacts(run_id, artifacts)
    return artifacts


async def get_run_artifacts(run_id: str) -> list[dict[str, Any]]:
    from oi_agent.automation.store import get_artifacts

    return await get_artifacts(run_id)


async def start_execution(run_id: str) -> None:
    async with _task_lock:
        if run_id in _tasks and not _tasks[run_id].done():
            return
        _tasks[run_id] = asyncio.create_task(execute_run(run_id))


async def cancel_execution(run_id: str) -> None:
    async with _task_lock:
        task = _tasks.get(run_id)
        if task and not task.done():
            task.cancel()


async def has_live_execution(run_id: str) -> bool:
    async with _task_lock:
        task = _tasks.get(run_id)
        return bool(task and not task.done())


async def reset_execution_tasks() -> None:
    async with _task_lock:
        tasks = list(_tasks.values())
        _tasks.clear()
    for task in tasks:
        if not task.done():
            task.cancel()
    for task in tasks:
        try:
            await task
        except BaseException:
            pass
