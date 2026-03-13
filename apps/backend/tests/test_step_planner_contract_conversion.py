from oi_agent.services.tools.navigator.planner_guardrails import apply_flow_guardrails
from oi_agent.services.tools.step_planner import (
    _can_automate_confidently,
    _enforce_named_entity_activation,
    _limit_browser_steps,
    _navigator_fallback,
    _is_next_action_payload,
    _plan_needs_refinement_to_snapshot_refs,
    _should_include_structured_context,
    _steps_from_contract,
    _validate_agent_browser_steps,
    _validate_contract_schema,
)
from oi_agent.automation.models import AutomationStep


def test_next_action_contract_is_detected() -> None:
    payload = {
        "action": "observe",
        "reason": "Need a fresh snapshot before interacting.",
        "targetId": "tab:12",
        "requiresHuman": False,
        "snapshotFormat": "ai",
    }

    assert _is_next_action_payload(payload) is True


def test_next_action_contract_validates_ref_action() -> None:
    payload = {
        "action": "act",
        "reason": "Stable ref is available for the visible compose button.",
        "targetId": "tab:12",
        "requiresHuman": False,
        "kind": "click",
        "ref": "e44",
    }

    assert _validate_contract_schema(payload) == []


def test_next_action_contract_rejects_missing_act_ref() -> None:
    payload = {
        "action": "act",
        "reason": "Try the visible button.",
        "targetId": "tab:12",
        "requiresHuman": False,
        "kind": "click",
    }

    assert "act requires ref" in _validate_contract_schema(payload)


def test_steps_from_next_action_contract_maps_observe_to_snapshot() -> None:
    payload = {
        "action": "observe",
        "reason": "Need a scoped snapshot for the open dialog.",
        "targetId": "tab:12",
        "requiresHuman": False,
        "snapshotFormat": "aria",
        "scopeSelector": "[role='dialog']",
        "frame": "iframe[name='compose']",
    }

    out = _steps_from_contract(payload)
    assert len(out) == 1
    assert out[0]["command"] == "snapshot"
    assert out[0]["page_ref"] == "tab:12"
    assert out[0]["target"]["snapshotFormat"] == "aria"
    assert out[0]["target"]["scopeSelector"] == "[role='dialog']"
    assert out[0]["target"]["frame"] == "iframe[name='compose']"


def test_steps_from_next_action_contract_maps_role_observation_mode() -> None:
    payload = {
        "action": "observe",
        "reason": "The visible modal may live in shadow DOM and needs a role snapshot.",
        "targetId": "tab:12",
        "requiresHuman": False,
        "snapshotFormat": "role",
        "scopeSelector": "[role='dialog']",
    }

    out = _steps_from_contract(payload)
    assert len(out) == 1
    assert out[0]["command"] == "snapshot"
    assert out[0]["target"]["snapshotFormat"] == "role"


def test_validate_agent_browser_steps_preserves_snapshot_observation_target_fields() -> None:
    out = _validate_agent_browser_steps(
        [
            {
                "type": "browser",
                "command": "snapshot",
                "description": "Capture the compose dialog.",
                "target": {
                    "snapshotFormat": "aria",
                    "observationMode": "full",
                    "scopeSelector": "[role='dialog']",
                    "frame": "iframe[name='compose']",
                    "targetId": "page_0",
                },
            }
        ]
    )

    assert len(out) == 1
    assert out[0]["target"]["snapshotFormat"] == "aria"
    assert out[0]["target"]["observationMode"] == "full"
    assert out[0]["target"]["scopeSelector"] == "[role='dialog']"
    assert out[0]["target"]["frame"] == "iframe[name='compose']"
    assert out[0]["target"]["targetId"] == "page_0"


def test_automation_step_normalized_command_payload_preserves_snapshot_target_fields() -> None:
    step = AutomationStep.model_validate(
        {
            "step_id": "s1",
            "label": "Capture compose dialog",
            "command_payload": {
                "type": "browser",
                "command": "snapshot",
                "description": "Capture compose dialog",
                "target": {
                    "snapshotFormat": "role",
                    "observationMode": "interactive",
                    "scopeSelector": "[role='dialog']",
                    "targetId": "page_0",
                },
            },
        }
    )

    payload = step.normalized_command_payload().model_dump(mode="json", exclude_none=True)
    assert payload["target"]["snapshotFormat"] == "role"
    assert payload["target"]["observationMode"] == "interactive"
    assert payload["target"]["scopeSelector"] == "[role='dialog']"
    assert payload["target"]["targetId"] == "page_0"


def test_steps_from_next_action_contract_maps_act_to_native_ref_step() -> None:
    payload = {
        "action": "act",
        "reason": "Current snapshot already exposes the compose button ref.",
        "targetId": "tab:12",
        "requiresHuman": False,
        "kind": "type",
        "ref": "e19",
        "text": "hello",
    }

    out = _steps_from_contract(payload)
    assert len(out) == 1
    assert out[0]["command"] == "type"
    assert out[0]["target"] == "@e19"
    assert out[0]["value"] == "hello"


def test_steps_from_next_action_contract_maps_semantic_target_action() -> None:
    payload = {
        "action": "click",
        "reason": "The current snapshot does not expose a safe ref for Compose.",
        "targetId": "tab:12",
        "requiresHuman": False,
        "target": {
            "by": "role",
            "value": "button",
            "name": "Compose",
        },
    }

    out = _steps_from_contract(payload)
    assert len(out) == 1
    assert out[0]["command"] == "click"
    assert out[0]["target"] == {"by": "role", "value": "button", "name": "Compose"}


def test_steps_from_next_action_contract_maps_diagnostics_action() -> None:
    payload = {
        "action": "diagnostics",
        "reason": "Observation and visible UI disagree.",
        "targetId": "tab:12",
        "requiresHuman": False,
    }

    out = _steps_from_contract(payload)
    assert len(out) == 1
    assert out[0]["command"] == "diagnostics"
    assert out[0]["page_ref"] == "tab:12"


def test_steps_from_contract_degrades_explicit_act_ref_steps_to_native_ref_targets() -> None:
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
                    "command": "act",
                    "kind": "click",
                    "ref": "e44",
                    "description": "Click search",
                    "snapshot_id": "snap-123",
                },
                {
                    "id": "s2",
                    "command": "act",
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
    assert out[0]["command"] == "click"
    assert "action" not in out[0]
    assert out[0]["target"] == "@e44"
    assert out[0]["snapshot_id"] == "snap-123"
    assert out[1]["command"] == "type"
    assert "action" not in out[1]
    assert out[1]["target"] == "@e44"
    assert out[1]["value"] == "dippa"


def test_steps_from_contract_ref_candidate_does_not_become_typed_value() -> None:
    contract = {
        "version": "1.1",
        "status": "OK",
        "summary": "message dippa",
        "snapshot_id": "snap-456",
        "plan": {
            "strategy": "SEARCH_FIRST_THEN_SELECT",
            "steps": [
                {
                    "id": "s1",
                    "command": "type",
                    "description": "Type message into chat with Dippa",
                    "value": "hi ra, this is an automated message, please ignore",
                    "target": {
                        "candidates": [
                            {"type": "ref", "value": "e166", "weight": 1.0},
                        ],
                        "disambiguation": {
                            "max_matches": 1,
                            "must_be_visible": True,
                            "must_be_enabled": True,
                            "prefer_topmost": True,
                        },
                    },
                },
            ],
        },
    }

    out = _steps_from_contract(contract)
    assert len(out) == 1
    assert out[0]["command"] == "type"
    assert "action" not in out[0]
    assert out[0]["target"] == "@e166"
    assert out[0]["value"] == "hi ra, this is an automated message, please ignore"


def test_steps_from_contract_promotes_type_args_into_value() -> None:
    contract = {
        "version": "1.2",
        "status": "OK",
        "summary": "search recipient",
        "plan": {
            "strategy": "SEARCH_FIRST_THEN_SELECT",
            "steps": [
                {
                    "id": "s1",
                    "command": "type",
                    "description": "Type tortoise into search",
                    "target": "@e11",
                    "args": ["tortoise"],
                },
            ],
        },
    }

    out = _steps_from_contract(contract)
    assert len(out) == 1
    assert out[0]["command"] == "type"
    assert out[0]["target"] == "@e11"
    assert out[0]["value"] == "tortoise"


def test_steps_from_contract_promotes_upload_args_into_value() -> None:
    contract = {
        "version": "1.2",
        "status": "OK",
        "summary": "upload file",
        "plan": {
            "strategy": "DIRECT_ACTION",
            "steps": [
                {
                    "id": "s1",
                    "command": "upload",
                    "description": "Upload the selected file",
                    "target": "@e19",
                    "args": ["/tmp/report.pdf"],
                }
            ],
        },
    }

    out = _steps_from_contract(contract)
    assert len(out) == 1
    assert out[0]["command"] == "upload"
    assert out[0]["target"] == "@e19"
    assert out[0]["value"] == "/tmp/report.pdf"


def test_steps_from_contract_promotes_click_args_into_target() -> None:
    contract = {
        "version": "1.2",
        "status": "OK",
        "summary": "click first result",
        "plan": {
            "strategy": "DIRECT_ACTION",
            "steps": [
                {
                    "id": "s1",
                    "command": "click",
                    "description": "Click the first result",
                    "args": ["@e25"],
                }
            ],
        },
    }

    out = _steps_from_contract(contract)
    assert len(out) == 1
    assert out[0]["command"] == "click"
    assert out[0]["target"] == "@e25"


def test_steps_from_contract_promotes_wait_args_into_target() -> None:
    contract = {
        "version": "1.2",
        "status": "OK",
        "summary": "wait for result",
        "plan": {
            "strategy": "DIRECT_ACTION",
            "steps": [
                {
                    "id": "s1",
                    "command": "wait",
                    "description": "Wait for the result row",
                    "args": ["@e25"],
                }
            ],
        },
    }

    out = _steps_from_contract(contract)
    assert len(out) == 1
    assert out[0]["command"] == "wait"
    assert out[0]["target"] == "@e25"


def test_steps_from_contract_promotes_numeric_wait_args_into_value() -> None:
    contract = {
        "version": "1.2",
        "status": "OK",
        "summary": "wait briefly",
        "plan": {
            "strategy": "DIRECT_ACTION",
            "steps": [
                {
                    "id": "s1",
                    "command": "wait",
                    "description": "Wait two seconds",
                    "args": ["2000"],
                }
            ],
        },
    }

    out = _steps_from_contract(contract)
    assert len(out) == 1
    assert out[0]["command"] == "wait"
    assert out[0].get("target", "") in ("", None)
    assert out[0]["value"] == 2000


def test_steps_from_contract_promotes_open_args_into_target() -> None:
    contract = {
        "version": "1.2",
        "status": "OK",
        "summary": "open github",
        "plan": {
            "strategy": "NAVIGATION_THEN_ACTION",
            "steps": [
                {
                    "id": "s1",
                    "command": "open",
                    "description": "Open GitHub",
                    "args": ["https://github.com"],
                }
            ],
        },
    }

    out = _steps_from_contract(contract)
    assert len(out) == 1
    assert out[0]["command"] == "open"
    assert out[0]["target"] == "https://github.com"


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
                    "command": "act",
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
    assert out[0]["command"] == "click"
    assert "action" not in out[0]
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
                    "command": "act",
                    "kind": "click",
                    "ref": "e81",
                    "description": "Click chat row",
                    "snapshot_id": "snap-1",
                },
                {
                    "id": "s4",
                    "type": "browser",
                    "command": "keyboard",
                    "key": "enter",
                    "description": "Press Enter to send the message",
                }
            ],
        },
    }
    out = _steps_from_contract(contract)
    assert len(out) == 2
    assert out[1]["command"] == "keyboard"
    assert "action" not in out[1]
    assert out[1]["value"] == "enter"

    guarded = apply_flow_guardrails(
        steps=out,
        user_prompt="send message to dippa on whatsapp",
        current_url="https://web.whatsapp.com",
    )
    assert len(guarded) == 2
    assert guarded[0]["command"] == "click"
    assert guarded[1]["command"] == "keyboard"
    assert guarded[1]["value"] == "Enter"


def test_press_key_field_is_preserved_and_normalized() -> None:
    contract = {
        "version": "1.2",
        "status": "OK",
        "summary": "submit search",
        "plan": {
            "strategy": "SEARCH_FIRST_THEN_SELECT",
            "steps": [
                {
                    "id": "s1",
                    "type": "browser",
                    "command": "press",
                    "key": "enter",
                    "description": "Submit the search",
                }
            ],
        },
    }
    out = _steps_from_contract(contract)
    assert len(out) == 1
    assert out[0]["command"] == "press"
    assert "action" not in out[0]
    assert out[0]["value"] == "enter"

    guarded = apply_flow_guardrails(
        steps=out,
        user_prompt="press enter",
        current_url="https://github.com",
    )
    assert len(guarded) == 1
    assert guarded[0]["command"] == "press"
    assert guarded[0]["value"] == "Enter"


def test_navigator_fallback_generates_native_steps_for_github_search_prompt() -> None:
    out = _navigator_fallback(
        "search for OI repository from github",
        current_url="https://example.com",
    )
    steps = out["steps"]
    assert out["status"] == "NEEDS_INPUT"
    assert len(steps) == 1
    assert steps[0]["type"] == "consult"
    assert steps[0]["reason"] == "planner_output_invalid"


def test_plan_needs_refinement_when_target_uses_semantic_locator_and_snapshot_has_refs() -> None:
    steps = [
        {
            "type": "browser",
            "command": "type",
            "target": {"by": "role", "value": "searchbox", "name": ""},
            "value": "OI",
        }
    ]
    snapshot = {
        "snapshot": '- textbox "Search" [ref=e2]',
        "refs": {"e2": {"role": "textbox", "name": "Search"}},
    }
    assert _plan_needs_refinement_to_snapshot_refs(steps, snapshot) is True


def test_plan_needs_refinement_when_snapshot_has_refs_and_target_uses_css() -> None:
    steps = [
        {
            "type": "browser",
            "command": "click",
            "target": {"by": "css", "value": "#compose"},
        }
    ]
    snapshot = {
        "snapshot": '- button "Compose" [ref=e2]',
        "refs": {"e2": {"role": "button", "name": "Compose"}},
    }
    assert _plan_needs_refinement_to_snapshot_refs(steps, snapshot) is True


def test_plan_does_not_need_refinement_when_target_already_uses_ref() -> None:
    steps = [
        {
            "type": "browser",
            "command": "click",
            "target": "@e2",
        }
    ]
    snapshot = {
        "snapshot": '- link "Repo" [ref=e2]',
        "refs": {"e2": {"role": "link", "name": "Repo"}},
    }
    assert _plan_needs_refinement_to_snapshot_refs(steps, snapshot) is False


def test_structured_context_is_kept_after_recent_extract_even_when_snapshot_has_refs() -> None:
    snapshot = {
        "snapshot": '- textbox "Search" [ref=e2]',
        "refs": {"e2": {"role": "textbox", "name": "Search"}},
    }
    structured = {
        "elements": [
            {"ref": "e2", "role": "textbox", "text": "Search"},
        ]
    }

    assert _should_include_structured_context(
        page_snapshot=snapshot,
        structured_context=structured,
        completed_steps=["Extract interactive structure for disambiguation"],
    ) is True


def test_structured_context_is_skipped_with_snapshot_refs_when_not_recently_needed() -> None:
    snapshot = {
        "snapshot": '- textbox "Search" [ref=e2]',
        "refs": {"e2": {"role": "textbox", "name": "Search"}},
    }
    structured = {
        "elements": [
            {"ref": "e2", "role": "textbox", "text": "Search"},
        ]
    }

    assert _should_include_structured_context(
        page_snapshot=snapshot,
        structured_context=structured,
        completed_steps=["Click the result"],
    ) is False


def test_contract_schema_accepts_native_semantic_target_dict() -> None:
    contract = {
        "version": "1.2",
        "status": "OK",
        "summary": "Message dippa on WhatsApp",
        "plan": {
            "strategy": "SEARCH_FIRST_THEN_SELECT",
            "steps": [
                {
                    "id": "s1",
                    "command": "type",
                    "description": "Type dippa into the search box",
                    "target": {"by": "role", "value": "textbox", "name": "Search or start a new chat"},
                    "value": "dippa",
                }
            ],
        },
    }

    assert _validate_contract_schema(contract) == []


def test_contract_schema_accepts_completed_status_with_no_steps() -> None:
    contract = {
        "version": "1.3",
        "status": "COMPLETED",
        "summary": "The message has already been sent.",
        "plan": {
            "strategy": "DIRECT_ACTION",
            "steps": [],
        },
    }

    assert _validate_contract_schema(contract) == []


def test_limit_browser_steps_prefers_action_over_redundant_snapshot_when_snapshot_exists() -> None:
    steps = [
        {"type": "browser", "command": "snapshot", "description": "Refresh snapshot"},
        {"type": "browser", "command": "click", "target": "@e2", "description": "Click the result"},
        {"type": "browser", "command": "type", "target": "@e3", "value": "hello", "description": "Type message"},
    ]

    limited = _limit_browser_steps(
        steps,
        max_browser_steps=1,
        prefer_existing_snapshot=True,
    )

    assert limited == [steps[1]]


def test_limit_browser_steps_keeps_single_browser_step_plus_consult_rows() -> None:
    steps = [
        {"type": "consult", "reason": "needs_review", "description": "Review the page"},
        {"type": "browser", "command": "open", "target": "https://web.whatsapp.com", "description": "Open WhatsApp"},
        {"type": "browser", "command": "snapshot", "description": "Capture snapshot"},
    ]

    limited = _limit_browser_steps(
        steps,
        max_browser_steps=1,
        prefer_existing_snapshot=False,
    )

    assert limited == [steps[0], steps[1]]


def test_enforce_named_entity_activation_injects_result_click_before_message_type() -> None:
    snapshot = {
        "refs": {
            "e11": {"role": "searchbox", "name": "Search or start a new chat"},
            "e21": {"role": "button", "name": "Tortoise"},
            "e37": {"role": "textbox", "name": "Type a message"},
        },
        "snapshot": '\n'.join(
            [
                '- searchbox "Search or start a new chat" [ref=e11]',
                '- button "Tortoise" [ref=e21]',
                '- textbox "Type a message" [ref=e37]',
            ]
        ),
    }

    out = _enforce_named_entity_activation(
        steps=[
            {
                "type": "browser",
                "command": "type",
                "target": "@e37",
                "value": "ignore this message",
                "description": "Type the message into the chat input field.",
            }
        ],
        user_prompt="Send the following message to tortoise on whatsapp: ignore this message",
        page_snapshot=snapshot,
        completed_steps=["Type 'tortoise' into the search textbox."],
    )

    assert len(out) == 1
    assert out[0]["command"] == "click"
    assert out[0]["target"] == "@e21"
    assert out[0]["success_criteria"] == [
        {"type": "page_contains_text", "value": "tortoise"},
        {"type": "target_absent", "target": "@e21"},
    ]


def test_enforce_named_entity_activation_leaves_flow_when_entity_already_opened() -> None:
    snapshot = {
        "refs": {
            "e37": {"role": "textbox", "name": "Type a message"},
        },
        "snapshot": '- textbox "Type a message" [ref=e37]',
    }
    steps = [
        {
            "type": "browser",
            "command": "type",
            "target": "@e37",
            "value": "ignore this message",
            "description": "Type the message into the chat input field.",
        }
    ]

    out = _enforce_named_entity_activation(
        steps=steps,
        user_prompt="Send the following message to tortoise on whatsapp: ignore this message",
        page_snapshot=snapshot,
        completed_steps=["Click the chat result for tortoise."],
    )

    assert out == steps


def test_can_automate_confidently_rejects_unknown_ui_without_live_evidence() -> None:
    ok, reason = _can_automate_confidently(
        steps=[
            {
                "type": "browser",
                "command": "click",
                "target": {"by": "role", "value": "button", "name": "Run"},
                "description": "Click Run",
            }
        ],
        user_prompt="Run the selected workflow in Amagi",
        page_snapshot=None,
        structured_context=None,
        completed_steps=None,
    )

    assert ok is False
    assert reason == "insufficient_live_ui_evidence"


def test_can_automate_confidently_rejects_downstream_edit_before_entity_activation() -> None:
    snapshot = {
        "refs": {
            "e21": {"role": "button", "name": "Tortoise"},
            "e37": {"role": "textbox", "name": "Type a message"},
        },
        "snapshot": '\n'.join(
            [
                '- button "Tortoise" [ref=e21]',
                '- textbox "Type a message" [ref=e37]',
            ]
        ),
    }

    ok, reason = _can_automate_confidently(
        steps=[
            {
                "type": "browser",
                "command": "type",
                "target": "@e37",
                "value": "hello",
                "description": "Type the message into the chat input field.",
            }
        ],
        user_prompt="Send hello to tortoise on whatsapp",
        page_snapshot=snapshot,
        structured_context=None,
        completed_steps=["Type tortoise into search"],
    )

    assert ok is False
    assert reason == "no_verifiable_entity_activation_path"
