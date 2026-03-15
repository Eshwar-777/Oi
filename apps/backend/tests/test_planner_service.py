from oi_agent.automation.models import IntentDraft, ResolveExecutionRequest
from oi_agent.automation.planner_service import (
    _resolve_app_name,
    build_execution_steps_from_predicted_plan,
    build_plan,
    build_plan_from_prompt,
)
from oi_agent.automation.models import PredictedExecutionPlan, PredictedPhase
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


async def test_build_plan_strips_stale_email_entities_from_non_email_browser_tasks() -> None:
    await reset_store()

    intent = IntentDraft(
        intent_id="intent-3",
        session_id="session-3",
        user_goal="Open Myntra and buy the first maroon shirt in size M under 1000 rupees.",
        goal_type="ui_automation",
        normalized_inputs=[],
        entities={
            "app": "Myntra",
            "target": "shirt",
            "recipient": "stale@example.com",
            "subject": "hi",
            "message_text": "how are you",
            "body": "how are you",
            "current_url": "https://mail.google.com/mail/u/0/#inbox",
            "current_title": "Inbox - Gmail",
        },
        decision="READY_TO_EXECUTE",
        workflow_outline=[
            "Go to Myntra.com",
            "Search for 'shirt'",
            "Apply color filter: 'maroon'",
        ],
    )
    request = ResolveExecutionRequest(
        session_id="session-3",
        intent_id="intent-3",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-3",
    )

    plan = await build_plan(intent, request)

    assert plan.execution_contract.target_entities == {"app": "Myntra", "target": "shirt"}
    criteria_text = " ".join(plan.execution_contract.completion_criteria).lower()
    assert "stale@example.com" not in criteria_text
    assert "how are you" not in criteria_text


async def test_build_plan_uses_canonical_checkout_slots_from_intent() -> None:
    await reset_store()

    intent = IntentDraft(
        intent_id="intent-4",
        session_id="session-4",
        user_goal="Purchase a maroon shirt of size M under 1000 rupees on Myntra, using UPI for payment and shipping to the specified address.",
        goal_type="ui_automation",
        normalized_inputs=[
            {
                "type": "text",
                "text": "open myntra and find a shirt which is maroon color with size M and price less than 1000. place the order for the first maroon shirt you find from the list. payment method: UPI. shipping address: 010, mbr scapple, bengalurur",
            }
        ],
        entities={
            "app": "Myntra",
            "target": "maroon shirt",
            "payment_method": "UPI",
            "shipping_address": "010, mbr scapple, bengalurur",
        },
        decision="READY_TO_EXECUTE",
        workflow_outline=[
            "Go to Myntra.com",
            "Search for 'maroon shirt'",
            "Proceed to checkout",
        ],
    )
    request = ResolveExecutionRequest(
        session_id="session-4",
        intent_id="intent-4",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-4",
    )

    plan = await build_plan(intent, request)

    assert plan.execution_contract.target_entities["payment_method"] == "UPI"
    assert plan.execution_contract.target_entities["shipping_address"] == "010, mbr scapple, bengalurur"


async def test_build_plan_preserves_app_scoped_email_phases_from_entities() -> None:
    await reset_store()

    intent = IntentDraft(
        intent_id="intent-email-app",
        session_id="session-email-app",
        user_goal="Send an email immediately.",
        goal_type="ui_automation",
        normalized_inputs=[],
        entities={
            "app": "Gmail",
            "recipient": "yandrapueshwar2000@gmail.com",
            "subject": "hi",
            "message_text": "how are you",
        },
        decision="READY_TO_EXECUTE",
        workflow_outline=[],
    )
    request = ResolveExecutionRequest(
        session_id="session-email-app",
        intent_id="intent-email-app",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-email-app",
    )

    plan = await build_plan(intent, request)

    labels = [phase.label for phase in plan.predicted_plan.phases]
    assert labels[0] == "Go to Gmail"
    assert "Compose a new email" in labels
    assert "Set recipient to yandrapueshwar2000@gmail.com" in labels
    assert "Set subject to hi" in labels
    assert "Set body to how are you" in labels
    assert labels[-1] == "Send the email"


async def test_build_plan_canonicalizes_generic_email_outline_from_entities() -> None:
    await reset_store()

    intent = IntentDraft(
        intent_id="intent-email-outline",
        session_id="session-email-outline",
        user_goal="Send an email immediately.",
        goal_type="ui_automation",
        normalized_inputs=[],
        entities={
            "app": "Gmail",
            "recipient": "yandrapueshwar2000@gmail.com",
            "subject": "hi",
            "message_text": "how are you",
        },
        decision="READY_TO_EXECUTE",
        workflow_outline=[
            "Go to an email application",
            "Compose a new email",
            "Address the correct recipient",
            "Draft the requested email",
            "Verify the send details",
        ],
    )
    request = ResolveExecutionRequest(
        session_id="session-email-outline",
        intent_id="intent-email-outline",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-email-outline",
    )

    plan = await build_plan(intent, request)

    labels = [phase.label for phase in plan.predicted_plan.phases]
    assert labels[0] == "Go to Gmail"
    assert "Compose a new email" in labels
    assert "Set recipient to yandrapueshwar2000@gmail.com" in labels
    assert "Set subject to hi" in labels
    assert "Set body to how are you" in labels
    assert labels[-1] == "Send the email"


def test_resolve_app_name_prefers_concrete_task_shape_app_over_generic_placeholder() -> None:
    intent = IntentDraft(
        intent_id="intent-app-resolve",
        session_id="session-app-resolve",
        user_goal="can you send an email now to yandrapueshwar2000@gmail.com subject is hi email is how are you",
        goal_type="ui_automation",
        normalized_inputs=[],
        entities={"app": "Email App", "recipient": "yandrapueshwar2000@gmail.com"},
        decision="READY_TO_EXECUTE",
    )

    assert _resolve_app_name(intent) == "Gmail"


def test_build_execution_steps_adds_target_constraints_for_select_result() -> None:
    plan = PredictedExecutionPlan(
        summary="Choose the first matching result",
        phases=[
            PredictedPhase(
                phase_id="phase_1",
                label="Select the first matching result",
                completion_signals=["maroon", "shirt", "size:M"],
            )
        ],
    )

    steps = build_execution_steps_from_predicted_plan(plan)

    assert len(steps) == 1
    assert steps[0].kind == "select_result"
    assert steps[0].allowed_actions == ["snapshot", "click"]
    assert steps[0].target_constraints["result_index"] == 0
    assert steps[0].target_constraints["match_terms"] == ["maroon", "shirt", "size:M"]


def test_build_execution_steps_treats_open_first_result_as_select_result() -> None:
    plan = PredictedExecutionPlan(
        summary="Search and open the first result",
        phases=[
            PredictedPhase(
                phase_id="phase_1",
                label="Open the first result",
                completion_signals=["fetch api"],
            )
        ],
    )

    steps = build_execution_steps_from_predicted_plan(plan)

    assert len(steps) == 1
    assert steps[0].kind == "select_result"
    assert steps[0].allowed_actions == ["snapshot", "click"]
    assert steps[0].target_constraints["result_index"] == 0
    assert any(rule.kind == "surface_kind" and rule.expected_surface == "detail" for rule in steps[0].verification_rules)
    assert all(rule.kind != "search_query" for rule in steps[0].verification_rules)


def test_build_execution_steps_treats_open_article_as_select_result() -> None:
    plan = PredictedExecutionPlan(
        summary="Search and open the article",
        phases=[
            PredictedPhase(
                phase_id="phase_1",
                label="Open the Alan Turing article",
                completion_signals=["Alan Turing"],
            )
        ],
    )

    steps = build_execution_steps_from_predicted_plan(plan)

    assert len(steps) == 1
    assert steps[0].kind == "select_result"
    assert steps[0].allowed_actions == ["snapshot", "click"]


def test_build_execution_steps_adds_filter_constraints_from_phase_label() -> None:
    plan = PredictedExecutionPlan(
        summary="Apply a size filter",
        phases=[
            PredictedPhase(
                phase_id="phase_1",
                label="Apply size filter 'M'",
                completion_signals=[],
            )
        ],
    )

    steps = build_execution_steps_from_predicted_plan(plan)

    assert len(steps) == 1
    assert steps[0].kind == "filter"
    assert steps[0].allowed_actions == ["snapshot", "click", "select"]
    assert steps[0].target_constraints["filters"] == {"size": "M"}


def test_build_execution_steps_adds_fill_constraints_from_phase_label() -> None:
    plan = PredictedExecutionPlan(
        summary="Enter a shipping address",
        phases=[
            PredictedPhase(
                phase_id="phase_1",
                label="Enter shipping address '010, mbr scapple, bengalurur'",
                completion_signals=[],
            )
        ],
    )

    steps = build_execution_steps_from_predicted_plan(plan)

    assert len(steps) == 1
    assert steps[0].kind == "fill_field"
    assert steps[0].target_constraints["value"] == "010, mbr scapple, bengalurur"
    assert steps[0].target_constraints["field_hint"] == "shipping address"


def test_build_execution_steps_adds_target_host_for_navigate_phase() -> None:
    plan = PredictedExecutionPlan(
        summary="Open developer.mozilla.org",
        phases=[
            PredictedPhase(
                phase_id="phase_1",
                label="Go to developer.mozilla.org",
                completion_signals=[],
            )
        ],
    )

    steps = build_execution_steps_from_predicted_plan(plan)

    assert len(steps) == 1
    assert steps[0].kind == "navigate"
    assert steps[0].target_constraints["target_host"] == "developer.mozilla.org"
    assert any(
        rule.kind == "url_contains" and rule.value == "developer.mozilla.org"
        for rule in steps[0].verification_rules
    )


def test_build_execution_steps_treats_set_field_phases_as_fill_field() -> None:
    plan = PredictedExecutionPlan(
        summary="Send an email",
        phases=[
            PredictedPhase(
                phase_id="phase_1",
                label="Set recipient to yandrapueshwar2000@gmail.com",
                completion_signals=[],
            )
        ],
    )

    steps = build_execution_steps_from_predicted_plan(plan)

    assert len(steps) == 1
    assert steps[0].kind == "fill_field"
    assert steps[0].target_constraints["value"] == "yandrapueshwar2000@gmail.com"


def test_build_execution_steps_adds_identity_terms_for_app_navigate_phase() -> None:
    plan = PredictedExecutionPlan(
        summary="Go to Gmail",
        phases=[
            PredictedPhase(
                phase_id="phase_1",
                label="Go to Gmail",
                completion_signals=["Gmail"],
            )
        ],
    )

    steps = build_execution_steps_from_predicted_plan(plan)

    assert len(steps) == 1
    assert steps[0].kind == "navigate"
    assert steps[0].target_constraints["target_identity_terms"] == ["gmail"]
