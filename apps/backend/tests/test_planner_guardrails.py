from oi_agent.services.tools.navigator.planner_guardrails import apply_flow_guardrails


def test_unsafe_css_target_escalates() -> None:
    steps = [
        {
            "type": "browser",
            "command": "click",
            "target": {"by": "css", "value": "div.foo .bar:nth-child(2)"},
            "description": "Click compose",
        }
    ]
    out = apply_flow_guardrails(
        steps=steps,
        user_prompt="click compose and send email",
        current_url="https://mail.google.com",
    )
    assert out == []


def test_xpath_target_is_rejected_and_escalates() -> None:
    steps = [
        {
            "type": "browser",
            "command": "click",
            "target": {"by": "xpath", "value": "//div[@id='compose']"},
            "description": "Click compose",
        }
    ]
    out = apply_flow_guardrails(
        steps=steps,
        user_prompt="send an email",
        current_url="https://mail.google.com",
    )
    assert out == []


def test_raw_coordinate_target_is_rejected_and_escalates() -> None:
    steps = [
        {
            "type": "browser",
            "command": "click",
            "target": {"by": "coords", "x": 640, "y": 480},
            "description": "Click the visible compose button",
        }
    ]
    out = apply_flow_guardrails(
        steps=steps,
        user_prompt="compose a new email",
        current_url="https://mail.google.com",
    )
    assert out == []


def test_act_without_snapshot_id_degrades_to_native_ref_click() -> None:
    steps = [
        {
            "type": "browser",
            "command": "act",
            "kind": "click",
            "ref": "e5",
            "description": "Click compose by ref",
        }
    ]
    out = apply_flow_guardrails(
        steps=steps,
        user_prompt="send an email",
        current_url="https://mail.google.com",
    )
    assert len(out) == 1
    assert out[0]["command"] == "click"
    assert out[0]["target"] == "@e5"


def test_role_name_target_gets_strict_disambiguation_and_preconditions() -> None:
    steps = [
        {
            "type": "browser",
            "command": "click",
            "target": {"by": "role", "value": "button", "name": "Compose"},
            "description": "Click compose",
        }
    ]
    out = apply_flow_guardrails(
        steps=steps,
        user_prompt="send an email",
        current_url="https://mail.google.com",
    )
    assert len(out) == 1
    step = out[0]
    assert step["command"] == "click"
    assert step["target"]["by"] == "role"
    assert step["disambiguation"]["max_matches"] == 1
    assert step["disambiguation"]["must_be_visible"] is True
    assert step["disambiguation"]["must_be_enabled"] is True
    assert step["disambiguation"]["prefer_topmost"] is True
    pre_types = {p.get("type") for p in step.get("preconditions", []) if isinstance(p, dict)}
    assert {"no_security_gate", "no_blocker_or_resolved", "target_clickable"}.issubset(pre_types)


def test_text_only_interaction_escalates() -> None:
    steps = [
        {
            "type": "browser",
            "command": "click",
            "target": {"by": "text", "value": "Compose"},
            "description": "Click compose",
        }
    ]
    out = apply_flow_guardrails(
        steps=steps,
        user_prompt="send an email",
        current_url="https://mail.google.com",
    )
    assert len(out) == 1
    assert out[0]["target"] == {"by": "text", "value": "Compose"}


def test_type_text_target_is_rewritten_to_label() -> None:
    steps = [
        {
            "type": "browser",
            "command": "type",
            "target": {"by": "text", "value": "To"},
            "value": "someone@example.com",
            "description": "Type into the To field",
        }
    ]
    out = apply_flow_guardrails(
        steps=steps,
        user_prompt="send an email",
        current_url="https://mail.google.com",
    )
    assert len(out) == 1
    assert out[0]["command"] == "type"
    assert out[0]["target"] == {"by": "label", "value": "To"}


def test_select_label_target_is_dropped_as_incompatible() -> None:
    steps = [
        {
            "type": "browser",
            "command": "select",
            "target": {"by": "label", "value": "Country"},
            "value": "India",
            "description": "Select India in the Country field",
        }
    ]
    out = apply_flow_guardrails(
        steps=steps,
        user_prompt="fill the form",
        current_url="https://example.com",
    )
    assert out == []


def test_keyboard_invalid_value_is_dropped() -> None:
    steps = [
        {
            "type": "browser",
            "command": "keyboard",
            "value": "Ctrl+Shift+P",
            "description": "Open command palette",
        }
    ]
    out = apply_flow_guardrails(
        steps=steps,
        user_prompt="wait on this page",
        current_url="https://example.com",
    )
    assert out == [
        {
            "type": "browser",
            "command": "keyboard",
            "value": "Ctrl+Shift+P",
            "description": "Open command palette",
        }
    ]


def test_press_counts_as_interactive_followup_without_escalation() -> None:
    steps = [
        {
            "type": "browser",
            "command": "press",
            "value": "Enter",
            "description": "Submit the current focused control",
        }
    ]
    out = apply_flow_guardrails(
        steps=steps,
        user_prompt="send a message to tortoise on whatsapp",
        current_url="https://web.whatsapp.com",
        has_snapshot=True,
    )
    assert [step["command"] for step in out] == ["press"]
    assert out[0]["value"] == "Enter"


def test_safe_css_id_target_is_kept() -> None:
    steps = [
        {
            "type": "browser",
            "command": "click",
            "target": {"by": "css", "value": "#compose"},
            "description": "Click compose",
        }
    ]
    out = apply_flow_guardrails(
        steps=steps,
        user_prompt="send an email",
        current_url="https://mail.google.com",
    )
    assert len(out) == 1
    assert out[0]["target"] == {"by": "css", "value": "#compose"}


def test_ref_target_is_kept_as_deterministic_native_agent_browser_target() -> None:
    steps = [
        {
            "type": "browser",
            "command": "click",
            "target": "@e12",
            "description": "Click the search result by ref",
        }
    ]
    out = apply_flow_guardrails(
        steps=steps,
        user_prompt="open the selected search result",
        current_url="https://github.com",
    )
    assert len(out) == 1
    assert out[0]["command"] == "click"
    assert out[0]["target"] == "@e12"


def test_semantic_locator_is_kept_when_snapshot_exists_but_ref_is_missing() -> None:
    steps = [
        {
            "type": "browser",
            "command": "click",
            "target": {"by": "role", "value": "button", "name": "Compose"},
            "description": "Click Compose using a semantic locator because no ref is available yet.",
        }
    ]
    out = apply_flow_guardrails(
        steps=steps,
        user_prompt="open the compose dialog",
        current_url="https://mail.google.com",
        has_snapshot=True,
    )
    assert len(out) == 1
    assert out[0]["command"] == "click"
    assert out[0]["target"] == {"by": "role", "value": "button", "name": "Compose"}


def test_message_like_prompt_does_not_inject_synthetic_click_steps() -> None:
    steps = [
        {
            "type": "browser",
            "command": "type",
            "target": "@e11",
            "value": "dippa",
            "description": "Type the contact name into the search field",
        },
        {
            "type": "browser",
            "command": "type",
            "target": "@e22",
            "value": "hi ra, please ignore this message",
            "description": "Type the message into the chat input field",
        },
    ]
    out = apply_flow_guardrails(
        steps=steps,
        user_prompt="send the following message to dippa on whatsapp saying 'hi ra, please ignore this message'",
        current_url="https://web.whatsapp.com",
    )
    assert [step["command"] for step in out] == ["type", "type"]
    assert out[0]["target"] == "@e11"
    assert out[1]["target"] == "@e22"


def test_interactive_semantic_target_is_kept_when_snapshot_already_exists() -> None:
    steps = [
        {
            "type": "browser",
            "command": "click",
            "target": {"by": "text", "value": "dippa"},
            "description": "Open the chat result",
        }
    ]
    out = apply_flow_guardrails(
        steps=steps,
        user_prompt="send a message to dippa on whatsapp",
        current_url="https://web.whatsapp.com",
        has_snapshot=True,
    )
    assert len(out) == 1
    assert out[0]["target"] == {"by": "text", "value": "dippa"}


def test_interactive_prompt_allows_open_as_first_step_when_site_change_is_needed() -> None:
    steps = [
        {
            "type": "browser",
            "command": "open",
            "target": "https://web.whatsapp.com",
            "description": "Open WhatsApp Web to begin the task.",
        }
    ]
    out = apply_flow_guardrails(
        steps=steps,
        user_prompt="send the following message to tortoise on whatsapp",
        current_url="chrome://new-tab-page/",
        has_snapshot=True,
    )
    assert len(out) == 1
    assert out[0]["command"] == "open"
    assert out[0]["target"] == "https://web.whatsapp.com"
