import pytest

from oi_agent.automation.conversation_resolver import (
    _missing_fields,
    classify_turn_mode,
    resolve_turn,
)
from oi_agent.automation.conversation_task import ConversationTask
from oi_agent.automation.intent_extractor import IntentExtraction


def test_missing_fields_allows_delegated_email_content() -> None:
    missing = _missing_fields(
        {"recipient": "yandrapueshwar2000@gmail.com"},
        [],
        "Send an email to yandrapueshwar2000@gmail.com with anything you want.",
    )

    assert missing == []


def test_missing_fields_still_requires_subject_and_body_when_not_delegated() -> None:
    missing = _missing_fields(
        {"recipient": "yandrapueshwar2000@gmail.com"},
        [],
        "Send an email to yandrapueshwar2000@gmail.com.",
    )

    assert missing == ["subject", "message_text"]


def test_missing_fields_does_not_treat_gmail_navigation_as_email_composition() -> None:
    missing = _missing_fields(
        {},
        [],
        "Open Gmail and navigate to the Sent folder.",
    )

    assert missing == []


def test_missing_fields_treats_gmail_compose_as_email_composition() -> None:
    missing = _missing_fields(
        {"recipient": "yandrapueshwar2000@gmail.com"},
        [],
        "Open Gmail and compose a draft to yandrapueshwar2000@gmail.com.",
    )

    assert missing == ["subject", "message_text"]


def test_missing_fields_does_not_treat_gmail_search_as_email_composition() -> None:
    missing = _missing_fields(
        {},
        [],
        "Open Gmail and search for emails from me.",
    )

    assert missing == []


def test_missing_fields_does_not_treat_gmail_drafts_folder_as_email_composition() -> None:
    missing = _missing_fields(
        {},
        [],
        "Open Gmail and go to the Drafts folder.",
    )

    assert missing == []


def test_missing_fields_allows_browser_only_cross_app_transfer() -> None:
    missing = _missing_fields(
        {},
        ["recipient", "subject", "message_text"],
        "Using only the live browser, open Gmail inbox, copy the email body from the first email in the inbox, then open WhatsApp and send that copied email body to Tortoise.",
    )

    assert missing == []


def test_missing_fields_allows_normalized_cross_app_transfer_goal() -> None:
    missing = _missing_fields(
        {},
        ["recipient", "subject", "message_text"],
        "Open Gmail, copy the body of the first email, then open WhatsApp and send it to Tortoise.",
    )

    assert missing == []


def test_missing_fields_allows_cross_app_transfer_without_browser_phrase() -> None:
    missing = _missing_fields(
        {},
        ["recipient", "subject", "message_text"],
        "Open Gmail, copy the body from the latest email, switch to WhatsApp, and send it to Tortoise.",
    )

    assert missing == []


def test_missing_fields_keeps_email_composition_requirements_without_browser_transfer() -> None:
    missing = _missing_fields(
        {"recipient": "yandrapueshwar2000@gmail.com"},
        [],
        "Send an email to yandrapueshwar2000@gmail.com with the text copied from my inbox.",
    )

    assert missing == ["subject", "message_text"]


def test_missing_fields_allows_delegated_selection_under_constraints() -> None:
    missing = _missing_fields(
        {"size": "M"},
        ["product_selection", "size"],
        "On Myntra, find any suitable maroon shirt under 1000 rupees in size M, pick one yourself, and continue.",
    )

    assert missing == []


def test_missing_fields_requires_checkout_details_for_purchase_goal() -> None:
    missing = _missing_fields(
        {},
        [],
        "Find a maroon shirt on Myntra and place an order.",
    )

    assert missing == ["payment_method", "shipping_address"]


def test_missing_fields_ignores_generic_payment_details_when_checkout_contract_is_explicit() -> None:
    missing = _missing_fields(
        {},
        ["payment_details", "payment_method"],
        "Find a maroon shirt on Myntra and place an order.",
    )

    assert missing == ["payment_method", "shipping_address"]


@pytest.mark.asyncio
async def test_resolve_turn_collects_checkout_details_from_follow_up_reply(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_extract_slots_for_fields(
        text: str,
        field_names: list[str],
        *,
        requested_model: str | None = None,
    ) -> dict[str, str]:
        _ = requested_model
        if "payment_method" in field_names and "shipping_address" in field_names:
            return {"payment_method": "cash on delivery"}
        return {}

    monkeypatch.setattr(
        "oi_agent.automation.conversation_resolver.extract_slots_for_fields",
        fake_extract_slots_for_fields,
    )

    task = _task(
        phase="collecting_requirements",
        user_goal="Find a maroon shirt on Myntra and place the order",
        resolved_goal="Find a maroon shirt on Myntra and place the order",
    )
    task.execution.missing_fields = ["payment_method", "shipping_address"]

    resolution = await resolve_turn(
        task,
        "payment method: cash on delivery",
        "Asia/Kolkata",
        None,
    )

    assert resolution.next_phase == "collecting_requirements"
    assert resolution.task_patch["slots"]["payment_method"] == "cash on delivery"
    assert resolution.task_patch["execution"]["missing_fields"] == ["shipping_address"]


@pytest.mark.asyncio
async def test_resolve_turn_accepts_shipping_address_when_it_is_the_only_missing_field(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_extract_slots_for_fields(
        text: str,
        field_names: list[str],
        *,
        requested_model: str | None = None,
    ) -> dict[str, str]:
        _ = text
        _ = requested_model
        if field_names == ["shipping_address"]:
            return {"shipping_address": "221B Baker Street, London"}
        return {}

    monkeypatch.setattr(
        "oi_agent.automation.conversation_resolver.extract_slots_for_fields",
        fake_extract_slots_for_fields,
    )

    task = _task(
        phase="collecting_requirements",
        user_goal="Find a maroon shirt on Myntra and place the order",
        resolved_goal="Find a maroon shirt on Myntra and place the order",
    )
    task.execution.missing_fields = ["shipping_address"]
    task.timing.mode = "immediate"

    resolution = await resolve_turn(
        task,
        "221B Baker Street, London",
        "Asia/Kolkata",
        None,
    )

    assert resolution.next_phase == "ready_to_execute"
    assert resolution.action_request == "execute"
    assert resolution.task_patch["slots"]["shipping_address"] == "221B Baker Street, London"
    assert resolution.task_patch["user_goal"] == "Find a maroon shirt on Myntra and place the order"


@pytest.mark.asyncio
async def test_browser_automation_defaults_to_immediate_execution(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_extract_intent(text: str, requested_model: str | None = None) -> IntentExtraction:
        return IntentExtraction(
            user_goal=text,
            goal_type="ui_automation",
            task_kind="browser_automation",
            execution_intent="unspecified",
            workflow_outline=["Go to Myntra", "Search for a shirt"],
            clarification_hints=[],
            entities={"app": "Myntra", "target": "maroon men's shirt", "size": "M"},
            timing_mode="unknown",
            timing_candidates=[],
            can_automate=True,
            confidence=0.9,
            risk_flags=[],
            missing_fields=[],
        )

    monkeypatch.setattr(
        "oi_agent.automation.conversation_resolver.extract_intent",
        fake_extract_intent,
    )
    async def fake_extract_slots_for_fields(
        text: str,
        field_names: list[str],
        *,
        requested_model: str | None = None,
    ) -> dict[str, str]:
        _ = text
        _ = field_names
        _ = requested_model
        return {}

    monkeypatch.setattr(
        "oi_agent.automation.conversation_resolver.extract_slots_for_fields",
        fake_extract_slots_for_fields,
    )

    resolution = await resolve_turn(
        None,
        "Find a maroon men's shirt on Myntra under ₹1000 in size M, pick one and continue.",
        "Asia/Kolkata",
        None,
    )

    assert resolution.action_request == "execute"
    assert resolution.next_phase == "ready_to_execute"
    assert resolution.task_patch["timing"]["mode"] == "immediate"


@pytest.mark.asyncio
async def test_resolve_turn_extracts_checkout_details_from_same_turn(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_extract_intent(text: str, requested_model: str | None = None) -> IntentExtraction:
        return IntentExtraction(
            user_goal="Find a maroon shirt on Myntra and place the order",
            goal_type="ui_automation",
            task_kind="browser_automation",
            execution_intent="immediate",
            workflow_outline=["Go to Myntra", "Search for a shirt", "Place the order"],
            clarification_hints=[],
            entities={"app": "Myntra", "target": "shirt", "size": "M", "color": "maroon", "price_max": "1000"},
            timing_mode="immediate",
            timing_candidates=[],
            can_automate=True,
            confidence=0.9,
            risk_flags=[],
            missing_fields=[],
        )

    monkeypatch.setattr(
        "oi_agent.automation.conversation_resolver.extract_intent",
        fake_extract_intent,
    )
    async def fake_extract_slots_for_fields(
        text: str,
        field_names: list[str],
        *,
        requested_model: str | None = None,
    ) -> dict[str, str]:
        _ = text
        _ = requested_model
        values = {
            "payment_method": "UPI",
            "shipping_address": "010, mbr scapple, bengalurur",
        }
        return {field_name: values[field_name] for field_name in field_names if field_name in values}

    monkeypatch.setattr(
        "oi_agent.automation.conversation_resolver.extract_slots_for_fields",
        fake_extract_slots_for_fields,
    )

    resolution = await resolve_turn(
        None,
        "open myntra and find a shirt which is maroon color with size M and price less than 1000. place the order for the first maroon shirt you find from the list. payment method: UPI. shipping address: 010, mbr scapple, bengalurur",
        "Asia/Kolkata",
        None,
    )

    assert resolution.next_phase == "ready_to_execute"
    assert resolution.action_request == "execute"
    assert resolution.task_patch["slots"]["payment_method"] == "UPI"
    assert resolution.task_patch["slots"]["shipping_address"] == "010, mbr scapple, bengalurur"


def _task(**overrides: object) -> ConversationTask:
    base = ConversationTask(
        task_id="task-1",
        legacy_intent_id="intent-1",
        conversation_id="conv-1",
        session_id="sess-1",
        user_id="dev-user",
        user_goal="Send an email",
        resolved_goal="Send an email",
        created_at="2026-03-14T00:00:00+00:00",
        updated_at="2026-03-14T00:00:00+00:00",
    )
    for key, value in overrides.items():
        setattr(base, key, value)
    return base


def test_classify_turn_mode_identifies_run_control() -> None:
    task = _task(phase="awaiting_user_action", active_run_id="run-1")
    assert classify_turn_mode(task, "resume") == "run_control"


def test_classify_turn_mode_identifies_new_task_while_run_active() -> None:
    task = _task(phase="executing", active_run_id="run-1")
    assert classify_turn_mode(task, "open github and create a new issue") == "new_task"


def test_classify_turn_mode_identifies_general_chat_without_task() -> None:
    assert classify_turn_mode(None, "hello") == "general_chat"


def test_classify_turn_mode_identifies_new_task_after_terminal_task() -> None:
    task = _task(phase="completed", status="completed")
    assert classify_turn_mode(task, "send a WhatsApp message to Tortoise") == "new_task"


def test_classify_turn_mode_keeps_requirement_follow_up_on_current_task() -> None:
    task = _task(
        phase="collecting_requirements",
        user_goal="Send an email to Tortoise",
        resolved_goal="Send an email to Tortoise",
    )
    assert classify_turn_mode(task, "subject: launch update") == "continue_task"


def test_classify_turn_mode_identifies_new_task_when_app_changes() -> None:
    task = _task(
        phase="executing",
        active_run_id="run-1",
        user_goal="Open Gmail and send an email",
        resolved_goal="Open Gmail and send an email",
    )
    assert classify_turn_mode(task, "open github and create a new issue") == "new_task"


def test_classify_turn_mode_identifies_new_scheduled_task_from_active_browser_task() -> None:
    task = _task(
        phase="executing",
        active_run_id="run-1",
        user_goal="Open Gmail and send an email",
        resolved_goal="Open Gmail and send an email",
    )
    assert classify_turn_mode(task, "schedule a reminder for tomorrow at 9am") == "new_task"


def test_classify_turn_mode_promotes_timed_request_out_of_general_chat() -> None:
    task = _task(
        phase="general_chat",
        user_goal="Just chatting",
        resolved_goal="Just chatting",
    )
    assert classify_turn_mode(task, "remind me tomorrow at 9am to pay rent") == "new_task"
