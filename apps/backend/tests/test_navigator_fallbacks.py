from oi_agent.services.tools.navigator.fallbacks import pick_adaptive_target
from oi_agent.services.tools.navigator.visual_fallback import (
    ScreenshotBasis,
    VisualFallbackPlan,
    build_screenshot_basis,
    is_visual_fallback_blocked,
    visual_plan_invalidated,
)


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


def test_visual_fallback_blocks_sensitive_actions() -> None:
    blocked, reason = is_visual_fallback_blocked(
        executor_mode="extension_stream",
        step={"action": "click", "description": "Click Send"},
    )

    assert blocked is True
    assert reason == "sensitive_action"


def test_visual_fallback_allows_agent_browser_mode_for_benign_actions() -> None:
    blocked, reason = is_visual_fallback_blocked(
        executor_mode="agent_browser",
        step={"action": "click", "description": "Click the visible To field"},
    )

    assert blocked is False
    assert reason == ""


def test_visual_fallback_blocks_unsupported_executor_mode() -> None:
    blocked, reason = is_visual_fallback_blocked(
        executor_mode="agent_browser",
        step={"action": "click", "description": "Click Compose"},
    )

    assert blocked is True
    assert reason == "unsupported_executor_mode"


def test_build_screenshot_basis_extracts_viewport_and_dpr() -> None:
    basis = build_screenshot_basis(
        {
            "screenshot": "data:image/jpeg;base64,abc123",
            "current_url": "https://mail.google.com",
            "page_title": "Inbox",
            "viewport": {"width": 1280, "height": 720},
            "device_pixel_ratio": 2,
        },
        tab_id=77,
    )

    assert basis is not None
    assert basis.current_url == "https://mail.google.com"
    assert basis.page_title == "Inbox"
    assert basis.viewport_width == 1280
    assert basis.viewport_height == 720
    assert basis.device_pixel_ratio == 2.0
    assert basis.tab_id == 77


def test_visual_plan_invalidated_when_screenshot_epoch_changes() -> None:
    original = ScreenshotBasis(
        screenshot="data:image/jpeg;base64,one",
        screenshot_id="snap-one",
        current_url="https://mail.google.com",
        page_title="Inbox",
        viewport_width=1280,
        viewport_height=720,
        device_pixel_ratio=2.0,
        tab_id=10,
    )
    changed = ScreenshotBasis(
        screenshot="data:image/jpeg;base64,two",
        screenshot_id="snap-two",
        current_url="https://mail.google.com",
        page_title="Inbox",
        viewport_width=1280,
        viewport_height=720,
        device_pixel_ratio=2.0,
        tab_id=10,
    )
    plan = VisualFallbackPlan(
        action="click",
        x=400,
        y=300,
        confidence=0.9,
        rationale="Compose button is visible",
        basis=original,
    )

    assert visual_plan_invalidated(plan, changed) is True


def test_visual_plan_invalidated_when_viewport_changes() -> None:
    original = ScreenshotBasis(
        screenshot="data:image/jpeg;base64,one",
        screenshot_id="snap-one",
        current_url="https://mail.google.com",
        page_title="Inbox",
        viewport_width=1280,
        viewport_height=720,
        device_pixel_ratio=1.0,
        tab_id=10,
    )
    resized = ScreenshotBasis(
        screenshot="data:image/jpeg;base64,one",
        screenshot_id="snap-one",
        current_url="https://mail.google.com",
        page_title="Inbox",
        viewport_width=1024,
        viewport_height=720,
        device_pixel_ratio=1.0,
        tab_id=10,
    )
    plan = VisualFallbackPlan(
        action="click",
        x=400,
        y=300,
        confidence=0.9,
        rationale="Compose button is visible",
        basis=original,
    )

    assert visual_plan_invalidated(plan, resized) is True
