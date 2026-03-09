import pytest

from oi_agent.automation.executor import (
    _build_browser_observation,
    _classify_step_error_code,
    _execute_browser_steps_with_agent_browser,
    _is_redundant_disambiguation_loop,
    _needs_replan_after_observation,
    _step_likely_completes_goal,
    _should_seed_navigation,
    _snapshot_contains_target_ref,
    save_screenshot_artifact,
)
from oi_agent.automation.store import reset_store


def test_snapshot_contains_target_ref_matches_refs_map() -> None:
    snapshot = {
        "refs": {
            "e11": {
                "role": "textbox",
                "name": "Search or start a new chat",
            }
        }
    }

    assert _snapshot_contains_target_ref(snapshot, "@e11") is True


def test_snapshot_contains_target_ref_matches_snapshot_text() -> None:
    snapshot = {
        "snapshot": '- textbox "Search or start a new chat" [ref=e11]',
    }

    assert _snapshot_contains_target_ref(snapshot, {"by": "ref", "value": "e11"}) is True


def test_snapshot_contains_target_ref_rejects_missing_ref() -> None:
    snapshot = {
        "refs": {
            "e12": {
                "role": "button",
                "name": "Menu",
            }
        },
        "snapshot": '- button "Menu" [ref=e12]',
    }

    assert _snapshot_contains_target_ref(snapshot, "@e11") is False


def test_classify_step_error_code_distinguishes_editability_from_missing_element() -> None:
    assert _classify_step_error_code("Not editable: postcondition-value-mismatch") == "PAGE_CHANGED"
    assert _classify_step_error_code("Element not found for @e11") == "ELEMENT_NOT_FOUND"


def test_should_seed_navigation_when_current_tab_is_unrelated_site() -> None:
    assert _should_seed_navigation("https://oye.example/app", "https://web.whatsapp.com") is True


def test_should_not_seed_navigation_when_already_on_target_site() -> None:
    assert _should_seed_navigation("https://web.whatsapp.com/", "https://web.whatsapp.com") is False


def test_step_likely_completes_goal_for_send_click() -> None:
    assert _step_likely_completes_goal(
        action="click",
        step={
            "command": "click",
            "description": "Click the Send button to send the message to Dippa.",
        },
        plan_summary="Send the following message to dippa on whatsapp",
    ) is True


def test_step_does_not_complete_goal_for_non_terminal_click() -> None:
    assert _step_likely_completes_goal(
        action="click",
        step={
            "command": "click",
            "description": "Click the chat result for Dippa.",
        },
        plan_summary="Send the following message to dippa on whatsapp",
    ) is False


@pytest.mark.asyncio
async def test_agent_browser_executor_initializes_snapshot_state_for_first_ref_step(monkeypatch: pytest.MonkeyPatch) -> None:
    commands: list[list[str]] = []

    async def fake_run_node_json_command(*, args, stdin=None):
        _ = stdin
        commands.append(list(args))
        if "connect" in args:
            return {"launched": True}
        if "snapshot" in args:
            return {
                "origin": "https://web.whatsapp.com/",
                "title": "WhatsApp",
                "snapshot": '- textbox "Search or start a new chat" [ref=e11]',
                "refs": {"e11": {"role": "textbox", "name": "Search or start a new chat"}},
            }
        if "fill" in args:
            return {"filled": True}
        if "get" in args and "value" in args:
            return {"value": "dippa"}
        if "get" in args and "title" in args:
            return {"title": "WhatsApp"}
        return {}

    async def fake_detect_sensitive_page_over_cdp(cdp_url: str):
        _ = cdp_url
        return None, ""

    async def fake_sync_page_registry_over_cdp(*, cdp_url, step, page_registry, active_page_ref):
        _ = (cdp_url, step)
        return page_registry, active_page_ref, []

    async def fake_sync_agent_browser_active_tab(*, session_name, page_registry, active_page_ref):
        _ = (session_name, page_registry, active_page_ref)
        return None

    monkeypatch.setattr("oi_agent.automation.executor._run_node_json_command", fake_run_node_json_command)
    monkeypatch.setattr("oi_agent.automation.executor._detect_sensitive_page_over_cdp", fake_detect_sensitive_page_over_cdp)
    monkeypatch.setattr("oi_agent.automation.executor._sync_page_registry_over_cdp", fake_sync_page_registry_over_cdp)
    monkeypatch.setattr("oi_agent.automation.executor._sync_agent_browser_active_tab", fake_sync_agent_browser_active_tab)

    result = await _execute_browser_steps_with_agent_browser(
        "http://127.0.0.1:9222",
        [
            {
                "type": "browser",
                "command": "type",
                "target": "@e11",
                "value": "dippa",
                "description": "Type dippa into search",
            }
        ],
        page_registry={"page_0": {"url": "https://web.whatsapp.com/", "title": "WhatsApp"}},
        active_page_ref="page_0",
    )

    assert result.success is True
    assert not any("screenshot" in command for command in commands)


@pytest.mark.asyncio
async def test_agent_browser_executor_fails_when_typed_value_does_not_match(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_run_node_json_command(*, args, stdin=None):
        _ = stdin
        if "connect" in args:
            return {"launched": True}
        if "snapshot" in args:
            return {
                "origin": "https://example.com/",
                "title": "Example",
                "snapshot": '- textbox "Search" [ref=e11]',
                "refs": {"e11": {"role": "textbox", "name": "Search"}},
            }
        if "fill" in args:
            return {"filled": True}
        if "get" in args and "value" in args:
            return {"value": "wrong"}
        if "get" in args and "text" in args:
            return {"text": "wrong"}
        return {}

    async def fake_detect_sensitive_page_over_cdp(cdp_url: str):
        _ = cdp_url
        return None, ""

    async def fake_sync_page_registry_over_cdp(*, cdp_url, step, page_registry, active_page_ref):
        _ = (cdp_url, step)
        return page_registry, active_page_ref, []

    async def fake_sync_agent_browser_active_tab(*, session_name, page_registry, active_page_ref):
        _ = (session_name, page_registry, active_page_ref)
        return None

    monkeypatch.setattr("oi_agent.automation.executor._run_node_json_command", fake_run_node_json_command)
    monkeypatch.setattr("oi_agent.automation.executor._detect_sensitive_page_over_cdp", fake_detect_sensitive_page_over_cdp)
    monkeypatch.setattr("oi_agent.automation.executor._sync_page_registry_over_cdp", fake_sync_page_registry_over_cdp)
    monkeypatch.setattr("oi_agent.automation.executor._sync_agent_browser_active_tab", fake_sync_agent_browser_active_tab)

    result = await _execute_browser_steps_with_agent_browser(
        "http://127.0.0.1:9222",
        [
            {
                "type": "browser",
                "command": "type",
                "target": "@e11",
                "value": "expected",
                "description": "Type expected value",
            }
        ],
        page_registry={"page_0": {"url": "https://example.com/", "title": "Example"}},
        active_page_ref="page_0",
    )

    assert result.success is False
    assert "postcondition-value-mismatch" in str(result.error)


@pytest.mark.asyncio
async def test_agent_browser_executor_requires_exact_typed_value_match(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_run_node_json_command(*, args, stdin=None):
        _ = stdin
        if "connect" in args:
            return {"launched": True}
        if "snapshot" in args:
            return {
                "origin": "https://example.com/",
                "title": "Example",
                "snapshot": '- textbox "Search" [ref=e11]',
                "refs": {"e11": {"role": "textbox", "name": "Search"}},
            }
        if "fill" in args:
            return {"filled": True}
        if "get" in args and "value" in args:
            return {"value": "ignore this message , this is automated draft"}
        if "get" in args and "text" in args:
            return {"text": "ignore this message , this is automated draft"}
        return {}

    async def fake_detect_sensitive_page_over_cdp(cdp_url: str):
        _ = cdp_url
        return None, ""

    async def fake_sync_page_registry_over_cdp(*, cdp_url, step, page_registry, active_page_ref):
        _ = (cdp_url, step)
        return page_registry, active_page_ref, []

    async def fake_sync_agent_browser_active_tab(*, session_name, page_registry, active_page_ref):
        _ = (session_name, page_registry, active_page_ref)
        return None

    monkeypatch.setattr("oi_agent.automation.executor._run_node_json_command", fake_run_node_json_command)
    monkeypatch.setattr("oi_agent.automation.executor._detect_sensitive_page_over_cdp", fake_detect_sensitive_page_over_cdp)
    monkeypatch.setattr("oi_agent.automation.executor._sync_page_registry_over_cdp", fake_sync_page_registry_over_cdp)
    monkeypatch.setattr("oi_agent.automation.executor._sync_agent_browser_active_tab", fake_sync_agent_browser_active_tab)

    result = await _execute_browser_steps_with_agent_browser(
        "http://127.0.0.1:9222",
        [
            {
                "type": "browser",
                "command": "type",
                "target": "@e11",
                "value": "ignore this message , this is automated",
                "description": "Type exact value",
            }
        ],
        page_registry={"page_0": {"url": "https://example.com/", "title": "Example"}},
        active_page_ref="page_0",
    )

    assert result.success is False
    assert "postcondition-value-mismatch" in str(result.error)


def test_needs_replan_after_observation_when_snapshot_changes_and_remaining_uses_ref() -> None:
    previous = _build_browser_observation(
        snapshot={"origin": "https://web.whatsapp.com/", "snapshot": '- textbox "Search" [ref=e11]', "refs": {"e11": {"role": "textbox"}}},
        snapshot_id="snap-1",
        screenshot_url="",
        page_registry={"page_0": {"url": "https://web.whatsapp.com/", "title": "WhatsApp"}},
        active_page_ref="page_0",
        title="WhatsApp",
    )
    current = _build_browser_observation(
        snapshot={"origin": "https://web.whatsapp.com/", "snapshot": '- listitem "dippa" [ref=e25]', "refs": {"e25": {"role": "listitem"}}},
        snapshot_id="snap-2",
        screenshot_url="",
        page_registry={"page_0": {"url": "https://web.whatsapp.com/", "title": "WhatsApp"}},
        active_page_ref="page_0",
        title="WhatsApp",
    )

    reasons = _needs_replan_after_observation(
        previous_observation=previous,
        current_observation=current,
        remaining_steps=[
            {"type": "browser", "command": "click", "target": "@e25"},
            {"type": "browser", "command": "type", "target": {"by": "role", "value": "textbox", "name": "Type a message"}},
        ],
    )

    assert reasons == ["observed_state_changed", "remaining_plan_uses_ref", "remaining_plan_interactive"]


def test_redundant_disambiguation_loop_detects_repeated_extract_structured() -> None:
    observation = _build_browser_observation(
        snapshot={"origin": "https://web.whatsapp.com/", "snapshot": '- textbox "Search" [ref=e11]', "refs": {"e11": {"role": "textbox"}}},
        snapshot_id="snap-1",
        screenshot_url="",
        page_registry={"page_0": {"url": "https://web.whatsapp.com/", "title": "WhatsApp"}},
        active_page_ref="page_0",
        title="WhatsApp",
    )

    assert _is_redundant_disambiguation_loop(
        current_action="extract_structured",
        replanned_steps=[{"type": "browser", "command": "extract_structured"}],
        current_observation=observation,
        previous_observation=observation,
        structured_context={"elements": [{"tag": "input"}]},
    ) is True


def test_redundant_disambiguation_loop_does_not_trigger_when_observation_changed() -> None:
    previous = _build_browser_observation(
        snapshot={"origin": "https://web.whatsapp.com/", "snapshot": '- textbox "Search" [ref=e11]', "refs": {"e11": {"role": "textbox"}}},
        snapshot_id="snap-1",
        screenshot_url="",
        page_registry={"page_0": {"url": "https://web.whatsapp.com/", "title": "WhatsApp"}},
        active_page_ref="page_0",
        title="WhatsApp",
    )
    current = _build_browser_observation(
        snapshot={"origin": "https://web.whatsapp.com/", "snapshot": '- listitem "Tortoise" [ref=e25]', "refs": {"e25": {"role": "listitem"}}},
        snapshot_id="snap-2",
        screenshot_url="",
        page_registry={"page_0": {"url": "https://web.whatsapp.com/", "title": "WhatsApp"}},
        active_page_ref="page_0",
        title="WhatsApp",
    )

    assert _is_redundant_disambiguation_loop(
        current_action="snapshot",
        replanned_steps=[{"type": "browser", "command": "extract_structured"}],
        current_observation=current,
        previous_observation=previous,
        structured_context={"elements": [{"tag": "input"}]},
    ) is False


@pytest.mark.asyncio
async def test_save_screenshot_artifact_skips_duplicate_consecutive_images() -> None:
    await reset_store()

    first = await save_screenshot_artifact("run-1", "final", "data:image/png;base64,abc")
    second = await save_screenshot_artifact("run-1", "failure", "data:image/png;base64,abc")

    assert len(first) == 1
    assert len(second) == 1


@pytest.mark.asyncio
async def test_agent_browser_executor_fails_when_expected_entity_is_not_active_after_click(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_run_node_json_command(*, args, stdin=None):
        _ = stdin
        if "connect" in args:
            return {"launched": True}
        if "snapshot" in args:
            return {
                "origin": "https://web.whatsapp.com/",
                "title": "Dippa",
                "snapshot": '- button "Tortoise" [ref=e21]\n- textbox "Type a message" [ref=e37]',
                "refs": {
                    "e21": {"role": "button", "name": "Tortoise"},
                    "e37": {"role": "textbox", "name": "Type a message"},
                },
            }
        if "click" in args:
            return {"clicked": True}
        if "get" in args and "title" in args:
            return {"title": "Dippa"}
        return {}

    async def fake_detect_sensitive_page_over_cdp(cdp_url: str):
        _ = cdp_url
        return None, ""

    async def fake_sync_page_registry_over_cdp(*, cdp_url, step, page_registry, active_page_ref):
        _ = (cdp_url, step)
        return page_registry, active_page_ref, []

    async def fake_sync_agent_browser_active_tab(*, session_name, page_registry, active_page_ref):
        _ = (session_name, page_registry, active_page_ref)
        return None

    monkeypatch.setattr("oi_agent.automation.executor._run_node_json_command", fake_run_node_json_command)
    monkeypatch.setattr("oi_agent.automation.executor._detect_sensitive_page_over_cdp", fake_detect_sensitive_page_over_cdp)
    monkeypatch.setattr("oi_agent.automation.executor._sync_page_registry_over_cdp", fake_sync_page_registry_over_cdp)
    monkeypatch.setattr("oi_agent.automation.executor._sync_agent_browser_active_tab", fake_sync_agent_browser_active_tab)

    result = await _execute_browser_steps_with_agent_browser(
        "http://127.0.0.1:9222",
        [
            {
                "type": "browser",
                "command": "click",
                "target": "@e21",
                "description": "Open the result for tortoise before continuing.",
                "success_criteria": [
                    {"type": "page_contains_text", "value": "tortoise"},
                    {"type": "target_absent", "target": "@e21"},
                ],
            }
        ],
        page_registry={"page_0": {"url": "https://web.whatsapp.com/", "title": "WhatsApp"}},
        active_page_ref="page_0",
    )

    assert result.success is False
    assert "postcondition-target-still-present" in str(result.error)
