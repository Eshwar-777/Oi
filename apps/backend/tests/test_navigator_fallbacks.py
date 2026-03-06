from oi_agent.services.tools.navigator.fallbacks import pick_adaptive_target


def test_pick_adaptive_target_returns_stable_selector_not_coords() -> None:
    elements = [
        {
            "tag": "button",
            "role": "button",
            "type": "button",
            "text": "Compose",
            "ariaLabel": "Compose",
            "name": "",
            "id": "compose_btn",
            "visible": True,
            "rect": {"x": 20, "y": 20, "w": 120, "h": 40},
        }
    ]
    failed_step = {
        "action": "click",
        "description": "Click Compose button",
        "target": {"by": "role", "value": "button", "name": "Compose"},
    }
    target = pick_adaptive_target(elements, failed_step=failed_step)
    assert isinstance(target, dict)
    assert target.get("by") in {"css", "label", "name", "role"}
    assert target.get("by") != "coords"
    assert isinstance(target.get("disambiguation"), dict)
    assert target["disambiguation"]["max_matches"] == 1


def test_pick_adaptive_target_rejects_risky_candidate() -> None:
    elements = [
        {
            "tag": "button",
            "role": "button",
            "type": "button",
            "text": "Delete account",
            "ariaLabel": "Delete account",
            "name": "",
            "id": "delete_account_btn",
            "visible": True,
            "rect": {"x": 20, "y": 20, "w": 120, "h": 40},
        }
    ]
    failed_step = {
        "action": "click",
        "description": "Delete account",
        "target": {"by": "role", "value": "button", "name": "Delete account"},
    }
    target = pick_adaptive_target(elements, failed_step=failed_step)
    assert target is None


def test_pick_adaptive_target_requires_confident_margin() -> None:
    elements = [
        {
            "tag": "button",
            "role": "button",
            "type": "button",
            "text": "Send report",
            "ariaLabel": "Send report",
            "name": "",
            "id": "send_report",
            "visible": True,
            "rect": {"x": 20, "y": 20, "w": 120, "h": 40},
        },
        {
            "tag": "button",
            "role": "button",
            "type": "button",
            "text": "Send message",
            "ariaLabel": "Send message",
            "name": "",
            "id": "send_message",
            "visible": True,
            "rect": {"x": 20, "y": 70, "w": 120, "h": 40},
        },
    ]
    failed_step = {
        "action": "click",
        "description": "Send to bob",
        "target": {"by": "text", "value": "send"},
    }
    target = pick_adaptive_target(elements, failed_step=failed_step)
    # Ambiguous near-ties should not auto-recover.
    assert target is None
