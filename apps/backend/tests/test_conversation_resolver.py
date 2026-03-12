from oi_agent.automation.conversation_resolver import _missing_fields


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
