from oi_agent.automation.executor import (
    _build_unified_evidence_bundle,
    _select_execution_mode,
)
from oi_agent.automation.models import AgentBrowserStep, AgentBrowserTarget
from oi_agent.services.tools.navigator.visual_fallback import ScreenshotBasis


def test_execution_mode_selector_prefers_visual_when_foreground_focus_contradicts_snapshot() -> None:
    snapshot = {
        "refs": {
            "e1": {"name": "Inbox row", "role": "link"},
            "e2": {"name": "Compose", "role": "button"},
        },
        "snapshot": "Inbox row Compose",
    }
    structured = {
        "elements": [
            {"text": "To", "ariaLabel": "To", "role": "textbox", "placeholder": "", "name": ""},
            {"text": "Subject", "ariaLabel": "Subject", "role": "textbox", "placeholder": "", "name": ""},
        ],
        "activeElement": {"tag": "input", "role": "textbox", "ariaLabel": "To", "editable": True},
    }
    basis = ScreenshotBasis(
        screenshot="data:image/jpeg;base64,abc",
        screenshot_id="snap-1",
        current_url="https://example.com/dialog",
        page_title="Dialog",
        viewport_width=1280,
        viewport_height=720,
        device_pixel_ratio=1.0,
    )

    evidence = _build_unified_evidence_bundle(
        current_url="https://example.com/dialog",
        current_title="Dialog",
        active_page_ref="page_0",
        snapshot=snapshot,
        snapshot_id="snapdom",
        screenshot_basis=basis,
        structured_context=structured,
        completed_steps=["Open modal", "Capture snapshot"],
    )

    decision = _select_execution_mode(evidence)
    assert decision.mode == "visual"
    assert "foreground_focus_not_represented_in_snapshot" in decision.contradiction_signals


def test_execution_mode_selector_prefers_ref_when_snapshot_is_strong() -> None:
    snapshot = {
        "refs": {
            "e1": {"name": "Search", "role": "textbox"},
            "e2": {"name": "Submit", "role": "button"},
            "e3": {"name": "Cancel", "role": "button"},
            "e4": {"name": "Help", "role": "link"},
            "e5": {"name": "Settings", "role": "button"},
        },
        "snapshot": "Search Submit Cancel Help Settings",
    }
    structured = {
        "elements": [
            {"text": "Search", "ariaLabel": "Search", "role": "textbox", "placeholder": "", "name": ""},
            {"text": "Submit", "ariaLabel": "Submit", "role": "button", "placeholder": "", "name": ""},
        ],
        "activeElement": {"tag": "body", "role": "", "ariaLabel": "", "editable": False},
    }
    basis = ScreenshotBasis(
        screenshot="data:image/jpeg;base64,abc",
        screenshot_id="snap-2",
        current_url="https://example.com",
        page_title="Example",
        viewport_width=1280,
        viewport_height=720,
        device_pixel_ratio=1.0,
    )

    evidence = _build_unified_evidence_bundle(
        current_url="https://example.com",
        current_title="Example",
        active_page_ref="page_0",
        snapshot=snapshot,
        snapshot_id="snapdom",
        screenshot_basis=basis,
        structured_context=structured,
        completed_steps=["Capture snapshot"],
    )

    decision = _select_execution_mode(evidence)
    assert decision.mode == "ref"


def test_agent_browser_step_preserves_visual_type_target_and_value() -> None:
    step = AgentBrowserStep.model_validate(
        {
            "type": "browser",
            "command": "type",
            "value": "alice@example.com",
            "target": {
                "by": "coords",
                "x": 420,
                "y": 310,
                "screenshot_id": "snap-3",
                "viewport_width": 1280,
                "viewport_height": 720,
                "device_pixel_ratio": 2.0,
                "verification_checks": ["recipient chip should appear"],
            },
        }
    )

    assert isinstance(step.target, AgentBrowserTarget)
    assert step.target.by == "coords"
    assert step.target.x == 420
    assert step.target.y == 310
    assert step.target.screenshot_id == "snap-3"
    assert step.value == "alice@example.com"
