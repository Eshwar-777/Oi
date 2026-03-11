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
