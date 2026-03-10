from oi_agent.services.tools.navigator.planner_guardrails import apply_flow_guardrails


def _is_safe_escalation(steps: list[dict]) -> bool:
    if len(steps) != 3:
        return False
    return (
        steps[0].get("type") == "browser"
        and steps[0].get("command") == "snapshot"
        and steps[1].get("type") == "browser"
        and steps[1].get("command") == "extract_structured"
        and steps[2].get("type") == "consult"
    )


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
    assert _is_safe_escalation(out)
    assert out[2]["reason"] == "no_interactive_steps"


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
    assert _is_safe_escalation(out)
    assert out[2]["reason"] == "no_interactive_steps"


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
    assert _is_safe_escalation(out)
    assert out[2]["reason"] == "no_interactive_steps"


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
    assert len(out) == 2
    assert out[0]["command"] == "snapshot"
    assert out[1]["command"] == "click"
    assert out[1]["target"] == "@e5"


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
    assert len(out) == 2
    assert out[0]["command"] == "snapshot"
    step = out[1]
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
    assert _is_safe_escalation(out)
    assert out[2]["reason"] == "interactive_steps_not_deterministic"


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
    assert out == []


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
    assert [step["command"] for step in out] == ["snapshot", "press"]
    assert out[1]["value"] == "Enter"


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
    assert len(out) == 2
    assert out[0]["command"] == "snapshot"
    assert out[1]["target"] == {"by": "css", "value": "#compose"}


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
    assert len(out) == 2
    assert out[0]["command"] == "snapshot"
    assert out[1]["command"] == "click"
    assert out[1]["target"] == "@e12"


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
    assert [step["command"] for step in out] == ["snapshot", "type", "type"]
    assert out[1]["target"] == "@e11"
    assert out[2]["target"] == "@e22"


def test_interactive_semantic_target_escalates_when_snapshot_already_exists() -> None:
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
    assert _is_safe_escalation(out)
    assert out[2]["reason"] == "interactive_steps_require_ref_after_snapshot"


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
