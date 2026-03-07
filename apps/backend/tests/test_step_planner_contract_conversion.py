from oi_agent.services.tools.navigator.planner_guardrails import apply_flow_guardrails
from oi_agent.services.tools.step_planner import _steps_from_contract


def test_steps_from_contract_keeps_explicit_act_ref_steps() -> None:
    contract = {
        "version": "1.1",
        "status": "OK",
        "summary": "message dippa",
        "snapshot_id": "snap-123",
        "plan": {
            "strategy": "SEARCH_FIRST_THEN_SELECT",
            "steps": [
                {
                    "id": "s1",
                    "action": "act",
                    "kind": "click",
                    "ref": "e44",
                    "description": "Click search",
                    "snapshot_id": "snap-123",
                },
                {
                    "id": "s2",
                    "action": "act",
                    "kind": "type",
                    "ref": "e44",
                    "value": "dippa",
                    "description": "Type recipient",
                    "snapshot_id": "snap-123",
                },
            ],
        },
    }

    out = _steps_from_contract(contract)
    assert len(out) == 2
    assert out[0]["action"] == "act"
    assert out[0]["kind"] == "click"
    assert out[0]["ref"] == "e44"
    assert out[0]["snapshot_id"] == "snap-123"
    assert out[1]["action"] == "act"
    assert out[1]["kind"] == "type"
    assert out[1]["ref"] == "e44"
    assert out[1]["value"] == "dippa"


def test_steps_from_contract_degrades_act_without_ref_to_semantic_action() -> None:
    contract = {
        "version": "1.1",
        "status": "OK",
        "summary": "click send",
        "plan": {
            "strategy": "SEARCH_FIRST_THEN_SELECT",
            "steps": [
                {
                    "id": "s5",
                    "action": "act",
                    "kind": "click",
                    "description": "Click send button",
                    "target": {
                        "candidates": [
                            {"type": "role", "role": "button", "name": "Send", "weight": 1.0}
                        ],
                        "disambiguation": {
                            "max_matches": 1,
                            "must_be_visible": True,
                            "must_be_enabled": True,
                            "prefer_topmost": True,
                        },
                    },
                }
            ],
        },
    }

    out = _steps_from_contract(contract)
    assert len(out) == 1
    assert out[0]["action"] == "click"
    assert out[0]["target"] == {"by": "role", "value": "button", "name": "Send"}
    assert out[0]["disambiguation"]["max_matches"] == 1


def test_keyboard_key_field_is_preserved_and_normalized() -> None:
    contract = {
        "version": "1.1",
        "status": "OK",
        "summary": "send message",
        "plan": {
            "strategy": "SEARCH_FIRST_THEN_SELECT",
            "steps": [
                {
                    "id": "s3",
                    "type": "browser",
                    "action": "act",
                    "kind": "click",
                    "ref": "e81",
                    "description": "Click chat row",
                    "snapshot_id": "snap-1",
                },
                {
                    "id": "s4",
                    "type": "browser",
                    "action": "keyboard",
                    "key": "enter",
                    "description": "Press Enter to send the message",
                }
            ],
        },
    }
    out = _steps_from_contract(contract)
    assert len(out) == 2
    assert out[1]["action"] == "keyboard"
    assert out[1]["value"] == "enter"

    guarded = apply_flow_guardrails(
        steps=out,
        user_prompt="send message to dippa on whatsapp",
        current_url="https://web.whatsapp.com",
    )
    assert len(guarded) == 2
    assert guarded[1]["action"] == "keyboard"
    assert guarded[1]["value"] == "Enter"
