from oi_agent.automation.conversation_task_shape import infer_task_shape


def test_task_shape_detects_cross_app_transfer_and_visible_state() -> None:
    shape = infer_task_shape(
        "Open Gmail, copy the body from the latest email, switch to WhatsApp, and send it to Tortoise."
    )

    assert shape.cross_app_transfer is True
    assert shape.visible_state_dependence is True
    assert shape.execution_surface == "browser"
    assert "gmail" in shape.source_apps
    assert "whatsapp" in shape.destination_apps


def test_task_shape_detects_schedule_intent_without_live_ui() -> None:
    shape = infer_task_shape("Schedule a browser smoke test every 2 hours.")

    assert shape.cross_app_transfer is False
    assert shape.requires_live_ui is False
    assert shape.timing_intent == "recurring"
