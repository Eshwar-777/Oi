from oi_agent.services.tools.navigator.planner_guardrails import apply_flow_guardrails


def _is_safe_escalation(steps: list[dict]) -> bool:
    if len(steps) != 3:
        return False
    return (
        steps[0].get("type") == "browser"
        and steps[0].get("action") == "snapshot"
        and steps[1].get("type") == "browser"
        and steps[1].get("action") == "extract_structured"
        and steps[2].get("type") == "consult"
    )


def test_unsafe_css_target_escalates() -> None:
    steps = [
        {
            "type": "browser",
            "action": "click",
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
            "action": "click",
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


def test_act_without_snapshot_id_escalates_as_nondeterministic() -> None:
    steps = [
        {
            "type": "browser",
            "action": "act",
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
    assert _is_safe_escalation(out)
    assert out[2]["reason"] == "interactive_steps_not_deterministic"


def test_role_name_target_gets_strict_disambiguation_and_preconditions() -> None:
    steps = [
        {
            "type": "browser",
            "action": "click",
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
    assert step["action"] == "click"
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
            "action": "click",
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
            "action": "keyboard",
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


def test_safe_css_id_target_is_kept() -> None:
    steps = [
        {
            "type": "browser",
            "action": "click",
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

