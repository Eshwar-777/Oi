import pytest

from oi_agent.automation.conversation_resolver import _missing_fields, resolve_turn
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

    resolution = await resolve_turn(
        None,
        "Find a maroon men's shirt on Myntra under ₹1000 in size M, pick one and continue.",
        "Asia/Kolkata",
        None,
    )

    assert resolution.action_request == "execute"
    assert resolution.next_phase == "ready_to_execute"
    assert resolution.task_patch["timing"]["mode"] == "immediate"
