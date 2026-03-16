import pytest

from oi_agent.automation.models import InputPart, IntentDraft, ResolveExecutionRequest
from oi_agent.automation.planner_service import build_plan


@pytest.mark.asyncio
async def test_build_plan_emits_typed_task_shape_and_transfer_evidence() -> None:
    intent = IntentDraft(
        intent_id="intent-1",
        session_id="session-1",
        user_goal="Open Gmail, copy the latest email body, then send it in WhatsApp.",
        goal_type="ui_automation",
        normalized_inputs=[InputPart(type="text", text="Open Gmail, copy the latest email body, then send it in WhatsApp.")],
        decision="READY_TO_EXECUTE",
        can_automate=True,
        entities={},
    )
    request = ResolveExecutionRequest(
        session_id="session-1",
        intent_id="intent-1",
        execution_mode="immediate",
        schedule={"timezone": "UTC"},
    )

    plan = await build_plan(intent, request, "user-1")

    assert plan.execution_contract is not None
    assert plan.execution_contract.task_shape.cross_app_transfer is True
    assert plan.execution_contract.transfer_evidence.cross_app_transfer is True
    assert plan.execution_contract.verification_evidence.expected_state_change == intent.user_goal
