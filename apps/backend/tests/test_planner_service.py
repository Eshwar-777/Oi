from oi_agent.automation.models import IntentDraft, ResolveExecutionRequest
from oi_agent.automation.planner_service import build_plan, build_plan_from_prompt
from oi_agent.automation.store import reset_store


async def test_build_plan_starts_empty_in_single_step_browser_mode() -> None:
    await reset_store()

    intent = IntentDraft(
        intent_id="intent-1",
        session_id="session-1",
        user_goal="send the following message to dippa on whatsapp",
        goal_type="ui_automation",
        normalized_inputs=[],
        entities={"app": "WhatsApp"},
        decision="READY_TO_EXECUTE",
        workflow_outline=[
            "Go to WhatsApp Web",
            "Search for contact 'dippa'",
            "Send message",
        ],
    )
    request = ResolveExecutionRequest(
        session_id="session-1",
        intent_id="intent-1",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-1",
    )

    plan = await build_plan(intent, request)

    assert plan.steps == []


async def test_build_plan_from_prompt_starts_empty_in_single_step_browser_mode() -> None:
    await reset_store()

    plan = await build_plan_from_prompt(
        prompt="send a message to dippa on whatsapp",
        execution_mode="immediate",
        app_name="WhatsApp",
        intent_id="intent-2",
    )

    assert plan.steps == []
