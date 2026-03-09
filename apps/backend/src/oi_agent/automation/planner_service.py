from __future__ import annotations

import uuid

from oi_agent.automation.models import (
    AutomationPlan,
    AutomationStep,
    AutomationTarget,
    IntentDraft,
    ResolveExecutionRequest,
)
from oi_agent.automation.store import save_plan


def _step(step_id: str, kind: str, label: str, description: str) -> AutomationStep:
    return AutomationStep(
        step_id=step_id,
        kind=kind,  # type: ignore[arg-type]
        label=label,
        description=description,
        status="pending",
    )


async def build_plan(intent: IntentDraft, request: ResolveExecutionRequest, user_id: str) -> AutomationPlan:
    plan_id = str(uuid.uuid4())
    app_name = str(intent.entities.get("app", "") or "").strip() or None
    target = AutomationTarget(
        target_type="browser_tab",
        device_id=None,
        tab_id=None,
        app_name=app_name,
    )
    steps = [
        _step("s1", "navigate", "Open target application", "Navigate to the application or page needed for the task."),
        _step("s2", "extract", "Locate the relevant UI area", "Find the page region, contact, or workflow entry point."),
        _step("s3", "click", "Perform the requested action", "Execute the main user intent through the UI."),
        _step("s4", "wait", "Verify the outcome", "Confirm that the requested UI state or action completed."),
    ]
    plan = AutomationPlan(
        plan_id=plan_id,
        intent_id=intent.intent_id,
        execution_mode=request.execution_mode,
        summary=intent.user_goal,
        model_id=intent.model_id,
        targets=[target],
        steps=steps,
        requires_confirmation=intent.requires_confirmation,
    )
    raw_plan = plan.model_dump(mode="json")
    raw_plan["user_id"] = user_id
    await save_plan(plan_id, raw_plan)
    return plan


async def build_plan_from_prompt(
    *,
    user_id: str,
    prompt: str,
    execution_mode: str,
    device_id: str | None = None,
    tab_id: int | None = None,
    app_name: str | None = None,
    intent_id: str = "",
) -> AutomationPlan:
    plan_id = str(uuid.uuid4())
    target = AutomationTarget(
        target_type="browser_tab",
        device_id=device_id,
        tab_id=tab_id,
        app_name=app_name,
    )
    steps = [
        _step("s1", "navigate", "Open target application", "Navigate to the application or page needed for the task."),
        _step("s2", "extract", "Locate the relevant UI area", "Find the page region, contact, or workflow entry point."),
        _step("s3", "click", "Perform the requested action", "Execute the main user intent through the UI."),
        _step("s4", "wait", "Verify the outcome", "Confirm that the requested UI state or action completed."),
    ]
    plan = AutomationPlan(
        plan_id=plan_id,
        intent_id=intent_id,
        execution_mode=execution_mode,  # type: ignore[arg-type]
        summary=prompt,
        model_id=None,
        targets=[target],
        steps=steps,
        requires_confirmation=False,
    )
    raw_plan = plan.model_dump(mode="json")
    raw_plan["user_id"] = user_id
    await save_plan(plan_id, raw_plan)
    return plan
