from pathlib import Path

import pytest

from oi_agent.automation.executor import (
    _apply_runtime_step_event,
    _attempt_agent_browser_visual_replan,
    _build_browser_observation,
    _classify_step_error_code,
    _execute_browser_steps_with_agent_browser,
    _execute_browser_steps_with_engine,
    _execute_run_via_automation_runtime,
    _maybe_escalate_observation_runtime_action,
    _needs_replan_after_observation,
    _planner_declares_completion,
    _resolve_cdp_page_for_step,
    _runtime_code_to_run_error,
    _runtime_failure_resolved_by_live_verification,
    _should_attempt_failure_observation_recovery,
    _should_seed_navigation,
    _snapshot_contains_target_ref,
    _sync_agent_browser_active_tab,
    _verify_runtime_completion_against_browser_state,
    save_screenshot_artifact,
)
from oi_agent.automation.models import (
    AgentBrowserStep,
    AutomationPlan,
    AutomationRun,
    BrowserStateSnapshot,
    RuntimeActionPlan,
)
from oi_agent.automation.store import get_plan, get_run, reset_store, save_plan, save_run


class _FakeAgentBrowserCli:
    def exists(self) -> bool:
        return True

    def __str__(self) -> str:
        return str(Path("/tmp/fake-agent-browser"))


class _FakePage:
    def __init__(self, url: str, title: str) -> None:
        self.url = url
        self._title = title
        self._oi_cached_title = title

    async def title(self) -> str:
        return self._title


class _FakeContext:
    def __init__(self, pages: list[_FakePage]) -> None:
        self.pages = pages
        self.new_page_calls = 0

    async def new_page(self) -> _FakePage:
        self.new_page_calls += 1
        page = _FakePage("about:blank", "")
        self.pages.append(page)
        return page


class _FakeBrowser:
    def __init__(self, context: _FakeContext) -> None:
        self.contexts = [context]


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
    assert _classify_step_error_code("Text target does not support action 'type' in agent-browser.") == "TARGET_ACTION_INCOMPATIBLE"


def test_should_seed_navigation_when_current_tab_is_unrelated_site() -> None:
    assert _should_seed_navigation("https://oye.example/app", "https://web.whatsapp.com") is True


def test_should_not_seed_navigation_when_already_on_target_site() -> None:
    assert _should_seed_navigation("https://web.whatsapp.com/", "https://web.whatsapp.com") is False


@pytest.mark.asyncio
async def test_resolve_cdp_page_for_step_reuses_semantically_matching_open_tab() -> None:
    existing_page = _FakePage("https://www.myntra.com/shirts", "Shirts - Myntra")
    context = _FakeContext([existing_page])
    browser = _FakeBrowser(context)

    page, registry, active_page_ref = await _resolve_cdp_page_for_step(
        browser=browser,
        fallback_page=existing_page,
        step={"command": "open", "page_ref": "page_myntra"},
        page_registry={
            "page_0": {
                "url": "https://www.myntra.com/shirts",
                "title": "Shirts - Myntra",
            }
        },
        active_page_ref="page_0",
    )

    assert page is existing_page
    assert context.new_page_calls == 0
    assert active_page_ref == "page_myntra"
    assert registry["page_myntra"]["url"] == "https://www.myntra.com/shirts"


def test_planner_declares_completion_for_completed_status() -> None:
    assert _planner_declares_completion({"status": "COMPLETED", "summary": "The message was sent."}) is True


def test_planner_does_not_declare_completion_for_ok_status() -> None:
    assert _planner_declares_completion({"status": "OK", "summary": "Click the chat result."}) is False


def test_observation_runtime_action_escalates_to_scoped_role_snapshot_for_compose_dialog() -> None:
    action_plan = RuntimeActionPlan(
        status="action",
        summary="Need a better observation of the compose dialog.",
        step=AgentBrowserStep(
            command="snapshot",
            description="The compose dialog is visible but its interactive elements are not present in the current snapshot.",
            target={"snapshotFormat": "ai", "observationMode": "interactive", "targetId": "page_0"},
        ),
        preferred_execution_mode="ref",
    )

    escalated = _maybe_escalate_observation_runtime_action(
        action_plan=action_plan,
        current_snapshot={"refs": {"e1": {"role": "button", "name": "Compose"}}},
        current_observation_context={"snapshotFormat": "ai", "scopeSelector": "", "frame": "", "targetId": "page_0"},
        structured_context={"dialogCount": 1, "overlayCount": 1},
    )

    assert escalated.step is not None
    assert escalated.step.target == {
        "snapshotFormat": "role",
        "observationMode": "interactive",
        "targetId": "page_0",
        "scopeSelector": '[role="dialog"]:has(:focus), [aria-modal="true"]:has(:focus), dialog:has(:focus), [role="dialog"]:has(input, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]), [aria-modal="true"]:has(input, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]), dialog:has(input, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]), .modal:has(:focus), [class*="modal"]:has(:focus), .drawer:has(:focus), [class*="drawer"]:has(:focus), .popup:has(:focus), [class*="popup"]:has(:focus), [role="dialog"], [aria-modal="true"], dialog, .modal, [class*="modal"], .drawer, [class*="drawer"], .popup, [class*="popup"]',
    }


def test_observation_runtime_action_escalates_scoped_role_snapshot_to_scoped_aria() -> None:
    scope = '[role="dialog"]:has(:focus), [aria-modal="true"]:has(:focus), dialog:has(:focus), [role="dialog"]:has(input, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]), [aria-modal="true"]:has(input, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]), dialog:has(input, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]), .modal:has(:focus), [class*="modal"]:has(:focus), .drawer:has(:focus), [class*="drawer"]:has(:focus), .popup:has(:focus), [class*="popup"]:has(:focus), [role="dialog"], [aria-modal="true"], dialog, .modal, [class*="modal"], .drawer, [class*="drawer"], .popup, [class*="popup"]'
    action_plan = RuntimeActionPlan(
        status="action",
        summary="Need a richer scoped observation.",
        step=AgentBrowserStep(
            command="snapshot",
            description="The compose dialog is visible but still incomplete in the current snapshot.",
            target={"snapshotFormat": "role", "observationMode": "interactive", "targetId": "page_0", "scopeSelector": scope},
        ),
        preferred_execution_mode="ref",
    )

    escalated = _maybe_escalate_observation_runtime_action(
        action_plan=action_plan,
        current_snapshot={"refs": {"e1": {"role": "button", "name": "Compose"}}},
        current_observation_context={"snapshotFormat": "role", "scopeSelector": scope, "frame": "", "targetId": "page_0"},
        structured_context={"dialogCount": 1},
    )

    assert escalated.step is not None
    assert escalated.step.target == {
        "snapshotFormat": "aria",
        "observationMode": "interactive",
        "targetId": "page_0",
        "scopeSelector": scope,
    }


def test_failure_observation_recovery_triggers_for_missing_ref() -> None:
    assert _should_attempt_failure_observation_recovery(
        step={"type": "browser", "command": "type", "target": "@e1"},
        error_message='Step 0 failed: {"success":false,"error":"Element "@e1" not found or not visible."}',
        incident=None,
    ) is True


def test_failure_observation_recovery_triggers_for_target_action_mismatch() -> None:
    assert _should_attempt_failure_observation_recovery(
        step={"type": "browser", "command": "type", "target": {"by": "text", "value": "To"}},
        error_message="Text target does not support action 'type' in agent-browser.",
        incident=None,
    ) is True


@pytest.mark.asyncio
async def test_visual_replan_now_returns_snapshot_observation() -> None:
    result = await _attempt_agent_browser_visual_replan(
        cdp_url="http://127.0.0.1:9222",
        step_intent="Open the visible compose dialog",
        completed_steps=[],
        page_registry={"page_0": {"url": "https://mail.google.com", "title": "Inbox"}},
        active_page_ref="page_0",
    )

    assert result is not None
    assert result.status == "action"
    assert result.step is not None
    assert result.step.command == "snapshot"
    assert result.summary == "Capture a fresh observation before the next interaction."


@pytest.mark.asyncio
async def test_runtime_failure_can_be_salvaged_by_live_terminal_verification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_capture_agent_browser_visual_context(**kwargs):
        _ = kwargs
        return (
            BrowserStateSnapshot(
                captured_at="2026-03-13T00:00:00+00:00",
                url="https://mail.google.com/mail/u/0/#inbox",
                title="Inbox - Gmail",
            ),
            {
                "url": "https://mail.google.com/mail/u/0/#inbox",
                "title": "Inbox - Gmail",
                "bodyText": "Message sent",
                "editableFields": [],
                "editableCount": 0,
                "dialogCount": 0,
                "buttons": [],
            },
        )

    monkeypatch.setattr(
        "oi_agent.automation.executor._capture_agent_browser_visual_context",
        fake_capture_agent_browser_visual_context,
    )

    resolved = await _runtime_failure_resolved_by_live_verification(
        run_id="run-1",
        cdp_url="http://127.0.0.1:9222",
        plan=AutomationPlan.model_validate(
            {
                "plan_id": "plan-1",
                "intent_id": "intent-1",
                "execution_mode": "immediate",
                "summary": "Send an email now.",
                "source_prompt": "Send an email now.",
                "targets": [],
                "steps": [],
                "requires_confirmation": False,
                "execution_contract": {
                    "contract_id": "contract-1",
                    "resolved_goal": "Send an email now.",
                    "target_app": "Gmail",
                    "target_entities": {
                        "recipient": "yandrapueshwar2000@gmail.com",
                        "subject": "hi",
                        "body": "how are you",
                        "message_text": "how are you",
                    },
                    "task_shape": {"operation_chain": ["send"]},
                },
            }
        ),
        page_registry={"page_0": {"url": "https://mail.google.com", "title": "Gmail"}},
        active_page_ref="page_0",
        runtime_observation={"url": "https://mail.google.com", "title": "Gmail"},
        runtime_text="The email has been sent successfully.",
        runtime_error="The email has been sent successfully.",
    )

    assert resolved is True


@pytest.mark.asyncio
async def test_agent_browser_snapshot_step_honors_snapshot_target_options(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    async def fake_run_node_json_command(*, args, stdin=None):
        _ = (args, stdin)
        return {"launched": True}

    async def fake_sync_page_registry_over_cdp(*, cdp_url, step, page_registry, active_page_ref):
        _ = (cdp_url, step)
        return page_registry, active_page_ref, []

    async def fake_capture_agent_browser_snapshot(*, session_name, page_registry, active_page_ref, snapshot_format="ai", scope_selector=None, frame=None):
        _ = (session_name, page_registry, active_page_ref)
        captured["snapshot_format"] = snapshot_format
        captured["scope_selector"] = scope_selector
        captured["frame"] = frame
        return {"snapshot": "", "refs": {}, "snapshot_id": "snap-1"}, "snap-1"

    monkeypatch.setattr("oi_agent.automation.executor._AGENT_BROWSER_CLI", _FakeAgentBrowserCli())
    monkeypatch.setattr("oi_agent.automation.executor._run_node_json_command", fake_run_node_json_command)
    monkeypatch.setattr("oi_agent.automation.executor._sync_page_registry_over_cdp", fake_sync_page_registry_over_cdp)
    monkeypatch.setattr("oi_agent.automation.executor._capture_agent_browser_snapshot", fake_capture_agent_browser_snapshot)

    result = await _execute_browser_steps_with_agent_browser(
        "http://127.0.0.1:9222",
        [
            {
                "type": "browser",
                "command": "snapshot",
                "description": "Observe the visible compose dialog.",
                "target": {
                    "snapshotFormat": "aria",
                    "scopeSelector": "[role='dialog']",
                    "frame": "iframe[name='composer']",
                },
            }
        ],
        page_registry={"page_0": {"url": "https://mail.google.com/", "title": "Inbox"}},
        active_page_ref="page_0",
    )

    assert result.success is True
    assert captured == {
        "snapshot_format": "aria",
        "scope_selector": "[role='dialog']",
        "frame": "iframe[name='composer']",
    }


@pytest.mark.asyncio
async def test_agent_browser_snapshot_step_honors_role_snapshot_target_options(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    async def fake_run_node_json_command(*, args, stdin=None):
        _ = (args, stdin)
        return {"launched": True}

    async def fake_sync_page_registry_over_cdp(*, cdp_url, step, page_registry, active_page_ref):
        _ = (cdp_url, step)
        return page_registry, active_page_ref, []

    async def fake_capture_agent_browser_snapshot(*, session_name, page_registry, active_page_ref, snapshot_format="ai", scope_selector=None, frame=None):
        _ = (session_name, page_registry, active_page_ref)
        captured["snapshot_format"] = snapshot_format
        captured["scope_selector"] = scope_selector
        captured["frame"] = frame
        return {"snapshot": "", "refs": {}, "snapshot_id": "snap-role"}, "snap-role"

    monkeypatch.setattr("oi_agent.automation.executor._AGENT_BROWSER_CLI", _FakeAgentBrowserCli())
    monkeypatch.setattr("oi_agent.automation.executor._run_node_json_command", fake_run_node_json_command)
    monkeypatch.setattr("oi_agent.automation.executor._sync_page_registry_over_cdp", fake_sync_page_registry_over_cdp)
    monkeypatch.setattr("oi_agent.automation.executor._capture_agent_browser_snapshot", fake_capture_agent_browser_snapshot)

    result = await _execute_browser_steps_with_agent_browser(
        "http://127.0.0.1:9222",
        [
            {
                "type": "browser",
                "command": "snapshot",
                "description": "Observe the open dialog with a role snapshot.",
                "target": {
                    "snapshotFormat": "role",
                    "scopeSelector": "[role='dialog']",
                },
            }
        ],
        page_registry={"page_0": {"url": "https://mail.google.com/", "title": "Inbox"}},
        active_page_ref="page_0",
    )

    assert result.success is True
    assert captured == {
        "snapshot_format": "role",
        "scope_selector": "[role='dialog']",
        "frame": None,
    }


@pytest.mark.asyncio
async def test_browser_step_engine_uses_automation_runtime_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    async def fake_runtime_execute(**kwargs):
        captured.update(kwargs)
        from oi_agent.services.tools.base import ToolResult

        return ToolResult(success=True, data=[{"status": "done"}], text="ok")

    monkeypatch.setattr("oi_agent.automation.executor.automation_runtime_enabled", lambda: True)
    monkeypatch.setattr("oi_agent.automation.executor.execute_browser_steps_via_runtime", fake_runtime_execute)

    result = await _execute_browser_steps_with_engine(
        automation_engine="agent_browser",
        cdp_url="http://127.0.0.1:9222",
        steps=[{"command": "snapshot", "description": "Observe"}],
        run_id="run-1",
        user_id="user-1",
        session_id="session-1",
        prompt="Send an email",
        page_registry={"page_0": {"url": "https://mail.google.com"}},
        active_page_ref="page_0",
    )

    assert result.success is True
    assert captured["run_id"] == "run-1"
    assert captured["user_id"] == "user-1"
    assert captured["prompt"] == "Send an email"


@pytest.mark.asyncio
async def test_agent_browser_executor_refresh_reuses_observation_context(monkeypatch: pytest.MonkeyPatch) -> None:
    captures: list[dict[str, object]] = []

    async def fake_run_node_json_command(*, args, stdin=None):
        _ = stdin
        if "connect" in args:
            return {"launched": True}
        if "click" in args:
            return {"clicked": True}
        if "get" in args and "title" in args:
            return {"title": "Inbox"}
        return {"ok": True}

    async def fake_sync_page_registry_over_cdp(*, cdp_url, step, page_registry, active_page_ref):
        _ = (cdp_url, step)
        return page_registry, active_page_ref, []

    async def fake_capture_agent_browser_snapshot(*, session_name, page_registry, active_page_ref, snapshot_format="ai", scope_selector=None, frame=None):
        _ = (session_name, page_registry, active_page_ref)
        captures.append(
            {
                "snapshot_format": snapshot_format,
                "scope_selector": scope_selector,
                "frame": frame,
            }
        )
        if len(captures) == 1:
            return {
                "origin": "https://mail.google.com/",
                "title": "Inbox",
                "snapshot": '- textbox "To" [ref=e11]',
                "refs": {"e11": {"role": "textbox", "name": "To"}},
                "snapshot_id": "snap-1",
                "snapshotFormat": snapshot_format,
                "scopeSelector": scope_selector,
                "frame": frame,
            }, "snap-1"
        return {
            "origin": "https://mail.google.com/",
            "title": "Inbox",
            "snapshot": '- button "Send" [ref=e22]',
            "refs": {"e22": {"role": "button", "name": "Send"}},
            "snapshot_id": "snap-2",
            "snapshotFormat": snapshot_format,
            "scopeSelector": scope_selector,
            "frame": frame,
        }, "snap-2"

    monkeypatch.setattr("oi_agent.automation.executor._AGENT_BROWSER_CLI", _FakeAgentBrowserCli())
    monkeypatch.setattr("oi_agent.automation.executor._run_node_json_command", fake_run_node_json_command)
    monkeypatch.setattr("oi_agent.automation.executor._sync_page_registry_over_cdp", fake_sync_page_registry_over_cdp)
    monkeypatch.setattr("oi_agent.automation.executor._capture_agent_browser_snapshot", fake_capture_agent_browser_snapshot)

    result = await _execute_browser_steps_with_agent_browser(
        "http://127.0.0.1:9222",
        [
            {
                "type": "browser",
                "command": "snapshot",
                "target": {
                    "snapshotFormat": "aria",
                    "scopeSelector": "[role='dialog']",
                    "frame": "iframe[name='composer']",
                },
            },
            {
                "type": "browser",
                "command": "click",
                "target": "@e22",
                "description": "Click Send",
            },
        ],
        page_registry={"page_0": {"url": "https://mail.google.com/", "title": "Inbox"}},
        active_page_ref="page_0",
    )

    assert result.success is True
    assert captures[:2] == [
        {
            "snapshot_format": "aria",
            "scope_selector": "[role='dialog']",
            "frame": "iframe[name='composer']",
        },
        {
            "snapshot_format": "aria",
            "scope_selector": "[role='dialog']",
            "frame": "iframe[name='composer']",
        },
    ]
    assert captures[-1] == {
        "snapshot_format": "aria",
        "scope_selector": "[role='dialog']",
        "frame": "iframe[name='composer']",
    }


@pytest.mark.asyncio
async def test_agent_browser_executor_post_step_snapshot_reuses_observation_context(monkeypatch: pytest.MonkeyPatch) -> None:
    captures: list[dict[str, object]] = []

    async def fake_run_node_json_command(*, args, stdin=None):
        _ = stdin
        if "connect" in args:
            return {"launched": True}
        if "click" in args:
            return {"clicked": True}
        if "get" in args and "title" in args:
            return {"title": "Inbox"}
        return {"ok": True}

    async def fake_sync_page_registry_over_cdp(*, cdp_url, step, page_registry, active_page_ref):
        _ = (cdp_url, step)
        return page_registry, active_page_ref, []

    async def fake_capture_agent_browser_snapshot(*, session_name, page_registry, active_page_ref, snapshot_format="ai", scope_selector=None, frame=None):
        _ = (session_name, page_registry, active_page_ref)
        captures.append(
            {
                "snapshot_format": snapshot_format,
                "scope_selector": scope_selector,
                "frame": frame,
            }
        )
        return {
            "origin": "https://mail.google.com/",
            "title": "Inbox",
            "snapshot": '- button "Send" [ref=e22]',
            "refs": {"e22": {"role": "button", "name": "Send"}},
            "snapshot_id": f"snap-{len(captures)}",
            "snapshotFormat": snapshot_format,
            "scopeSelector": scope_selector,
            "frame": frame,
        }, f"snap-{len(captures)}"

    monkeypatch.setattr("oi_agent.automation.executor._AGENT_BROWSER_CLI", _FakeAgentBrowserCli())
    monkeypatch.setattr("oi_agent.automation.executor._run_node_json_command", fake_run_node_json_command)
    monkeypatch.setattr("oi_agent.automation.executor._sync_page_registry_over_cdp", fake_sync_page_registry_over_cdp)
    monkeypatch.setattr("oi_agent.automation.executor._capture_agent_browser_snapshot", fake_capture_agent_browser_snapshot)

    result = await _execute_browser_steps_with_agent_browser(
        "http://127.0.0.1:9222",
        [
            {
                "type": "browser",
                "command": "snapshot",
                "target": {
                    "snapshotFormat": "aria",
                    "scopeSelector": "[role='dialog']",
                    "frame": "iframe[name='composer']",
                },
            },
            {
                "type": "browser",
                "command": "click",
                "target": "@e22",
                "description": "Click Send",
            },
        ],
        page_registry={"page_0": {"url": "https://mail.google.com/", "title": "Inbox"}},
        active_page_ref="page_0",
    )

    assert result.success is True
    assert captures[-1] == {
        "snapshot_format": "aria",
        "scope_selector": "[role='dialog']",
        "frame": "iframe[name='composer']",
    }


@pytest.mark.asyncio
async def test_sync_agent_browser_active_tab_prefers_saved_tab_index(monkeypatch: pytest.MonkeyPatch) -> None:
    commands: list[list[str]] = []
    page_registry = {
        "page_0": {
            "url": "https://example.com/inbox",
            "title": "Inbox",
            "tab_index": 2,
        }
    }

    async def fake_run_node_json_command(*, args, stdin=None):
        _ = stdin
        commands.append(list(args))
        if args[-1] == "tab":
            return {
                "tabs": [
                    {"index": 0, "url": "https://example.com/inbox", "title": "Inbox", "active": True},
                    {"index": 2, "url": "https://example.com/inbox", "title": "Inbox", "active": False},
                ]
            }
        return {"ok": True}

    monkeypatch.setattr("oi_agent.automation.executor._AGENT_BROWSER_CLI", _FakeAgentBrowserCli())
    monkeypatch.setattr("oi_agent.automation.executor._run_node_json_command", fake_run_node_json_command)

    await _sync_agent_browser_active_tab(
        session_name="session-1",
        page_registry=page_registry,
        active_page_ref="page_0",
    )

    assert any(command[-2:] == ["tab", "2"] for command in commands)
    assert page_registry["page_0"]["tab_index"] == 2


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

    async def fake_sync_page_registry_over_cdp(*, cdp_url, step, page_registry, active_page_ref):
        _ = (cdp_url, step)
        return page_registry, active_page_ref, []

    async def fake_sync_agent_browser_active_tab(*, session_name, page_registry, active_page_ref):
        _ = (session_name, page_registry, active_page_ref)
        return None

    monkeypatch.setattr("oi_agent.automation.executor._AGENT_BROWSER_CLI", _FakeAgentBrowserCli())
    monkeypatch.setattr("oi_agent.automation.executor._run_node_json_command", fake_run_node_json_command)
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
async def test_agent_browser_executor_supports_diagnostics_action(monkeypatch: pytest.MonkeyPatch) -> None:
    commands: list[list[str]] = []

    async def fake_run_node_json_command(*, args, stdin=None):
        _ = stdin
        commands.append(list(args))
        if "connect" in args:
            return {"launched": True}
        if args[-1] == "title":
            return {"title": "Inbox"}
        if args[-1] == "console":
            return {"items": [{"level": "error", "text": "boom"}]}
        if args[-1] == "errors":
            return {"items": [{"message": "uncaught"}]}
        if args[-2:] == ["network", "requests"]:
            return {"items": [{"url": "https://mail.google.com/api/send", "status": 500}]}
        if "eval" in args:
            return {"result": {"dialogCount": 1, "overlayCount": 0, "iframeCount": 0}}
        return {"ok": True}

    async def fake_sync_page_registry_over_cdp(*, cdp_url, step, page_registry, active_page_ref):
        _ = (cdp_url, step)
        return page_registry, active_page_ref, []

    monkeypatch.setattr("oi_agent.automation.executor._AGENT_BROWSER_CLI", _FakeAgentBrowserCli())
    monkeypatch.setattr("oi_agent.automation.executor._run_node_json_command", fake_run_node_json_command)
    monkeypatch.setattr("oi_agent.automation.executor._sync_page_registry_over_cdp", fake_sync_page_registry_over_cdp)

    result = await _execute_browser_steps_with_agent_browser(
        "http://127.0.0.1:9222",
        [
            {
                "type": "browser",
                "command": "diagnostics",
                "description": "Collect diagnostics before retrying.",
            }
        ],
        page_registry={"page_0": {"url": "https://mail.google.com/", "title": "Inbox"}},
        active_page_ref="page_0",
    )

    assert result.success is True
    assert result.data[0]["command"] == "diagnostics"
    assert result.data[0]["data"]["console"]["items"][0]["text"] == "boom"
    assert result.data[0]["data"]["errors"]["items"][0]["message"] == "uncaught"
    assert result.data[0]["data"]["network_requests"]["items"][0]["status"] == 500


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

    async def fake_sync_page_registry_over_cdp(*, cdp_url, step, page_registry, active_page_ref):
        _ = (cdp_url, step)
        return page_registry, active_page_ref, []

    async def fake_sync_agent_browser_active_tab(*, session_name, page_registry, active_page_ref):
        _ = (session_name, page_registry, active_page_ref)
        return None

    monkeypatch.setattr("oi_agent.automation.executor._AGENT_BROWSER_CLI", _FakeAgentBrowserCli())
    monkeypatch.setattr("oi_agent.automation.executor._run_node_json_command", fake_run_node_json_command)
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

    async def fake_sync_page_registry_over_cdp(*, cdp_url, step, page_registry, active_page_ref):
        _ = (cdp_url, step)
        return page_registry, active_page_ref, []

    async def fake_sync_agent_browser_active_tab(*, session_name, page_registry, active_page_ref):
        _ = (session_name, page_registry, active_page_ref)
        return None

    monkeypatch.setattr("oi_agent.automation.executor._AGENT_BROWSER_CLI", _FakeAgentBrowserCli())
    monkeypatch.setattr("oi_agent.automation.executor._run_node_json_command", fake_run_node_json_command)
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


@pytest.mark.asyncio
async def test_apply_runtime_step_event_appends_and_updates_runtime_generated_steps() -> None:
    await reset_store()
    plan = AutomationPlan.model_validate(
        {
            "plan_id": "plan-runtime",
            "intent_id": "intent-1",
            "execution_mode": "immediate",
            "summary": "Send an email",
            "steps": [],
        }
    )
    await save_plan(plan.plan_id, plan.model_dump(mode="json"))

    plan = await _apply_runtime_step_event(
        plan=plan,
        event={
            "type": "step.started",
            "payload": {
                "stepId": "runtime_s1",
                "command": "click",
                "description": "Open compose",
                "target": {"by": "role", "value": "button", "name": "Compose"},
            },
        },
    )
    plan = await _apply_runtime_step_event(
        plan=plan,
        event={
            "type": "step.completed",
            "payload": {
                "stepId": "runtime_s1",
                "command": "click",
                "description": "Open compose",
            },
        },
    )

    persisted = await get_plan("plan-runtime")
    assert persisted is not None
    assert len(plan.steps) == 1
    assert plan.steps[0].step_id == "runtime_s1"
    assert plan.steps[0].status == "completed"
    assert persisted["steps"][0]["command_payload"]["command"] == "click"


@pytest.mark.asyncio
async def test_execute_run_via_automation_runtime_completes_without_python_browser_planning(monkeypatch: pytest.MonkeyPatch) -> None:
    await reset_store()
    plan = AutomationPlan.model_validate(
        {
            "plan_id": "plan-runtime-2",
            "intent_id": "intent-2",
            "execution_mode": "immediate",
            "summary": "Send an email",
            "steps": [],
        }
    )
    run = AutomationRun.model_validate(
        {
            "run_id": "run-runtime-1",
            "plan_id": plan.plan_id,
            "session_id": "session-1",
            "state": "starting",
            "execution_mode": "immediate",
            "executor_mode": "local_runner",
            "automation_engine": "agent_browser",
            "browser_session_id": "browser-1",
            "total_steps": 0,
            "created_at": "2026-03-11T00:00:00+00:00",
            "updated_at": "2026-03-11T00:00:00+00:00",
        }
    )
    await save_plan(plan.plan_id, plan.model_dump(mode="json"))
    raw_run = run.model_dump(mode="json")
    raw_run["user_id"] = "user-1"
    await save_run(run.run_id, raw_run)

    async def fake_backend_directed(**kwargs):
        _ = kwargs
        latest_run = await get_run(run.run_id)
        assert latest_run is not None
        return AutomationRun.model_validate(latest_run), False

    async def fake_runtime_execute(**kwargs):
        on_event = kwargs["on_event"]
        await on_event(
            {
                "type": "step.started",
                "payload": {
                    "stepId": "runtime_s1",
                    "stepIndex": 0,
                    "command": "click",
                    "description": "Open compose",
                    "target": {"by": "role", "value": "button", "name": "Compose"},
                },
            }
        )
        await on_event(
            {
                "type": "step.completed",
                "payload": {
                    "stepId": "runtime_s1",
                    "stepIndex": 0,
                    "command": "click",
                    "description": "Open compose",
                },
            }
        )
        return {"result": {"rows": [{"command": "click"}]}, "error": "", "code": "", "runtime_events": []}

    monkeypatch.setattr("oi_agent.automation.executor.execute_browser_prompt_via_runtime", fake_runtime_execute)
    async def fake_verify_completion(**kwargs):  # type: ignore[no-untyped-def]
        _ = kwargs
        return None

    monkeypatch.setattr(
        "oi_agent.automation.executor._verify_runtime_completion_against_browser_state",
        fake_verify_completion,
    )
    monkeypatch.setattr("oi_agent.automation.executor._run_backend_directed_runtime_actions", fake_backend_directed)

    await _execute_run_via_automation_runtime(
        run_id=run.run_id,
        user_id="user-1",
        session_id=run.session_id,
        run=run,
        plan=plan,
        prompt=plan.summary,
        cdp_url="http://127.0.0.1:9222",
    )

    persisted_run = await get_run(run.run_id)
    persisted_plan = await get_plan(plan.plan_id)
    assert persisted_run is not None
    assert persisted_plan is not None
    assert persisted_run["state"] == "completed"
    assert persisted_plan["steps"] == []


@pytest.mark.asyncio
async def test_execute_run_via_automation_runtime_rejects_false_send_completion_when_compose_surface_remains(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await reset_store()
    plan = AutomationPlan.model_validate(
        {
            "plan_id": "plan-runtime-email",
            "intent_id": "intent-email",
            "execution_mode": "immediate",
            "summary": "Send an email",
            "execution_contract": {
                "contract_id": "contract-email",
                "resolved_goal": "Send an email now to yandrapueshwar2000@gmail.com subject hi email is how are you",
                "target_app": "Gmail",
                "target_entities": {
                    "recipient": "yandrapueshwar2000@gmail.com",
                    "subject": "hi",
                    "body": "how are you",
                },
                "task_shape": {"operation_chain": ["send"]},
            },
            "steps": [],
        }
    )
    run = AutomationRun.model_validate(
        {
            "run_id": "run-runtime-email",
            "plan_id": plan.plan_id,
            "session_id": "session-email",
            "state": "starting",
            "execution_mode": "immediate",
            "executor_mode": "local_runner",
            "automation_engine": "agent_browser",
            "browser_session_id": "browser-email",
            "active_page_ref": "page_0",
            "page_registry": {
                "page_0": {
                    "url": "https://mail.google.com/mail/u/0/#inbox?compose=new",
                    "title": "Compose - Gmail",
                }
            },
            "total_steps": 0,
            "created_at": "2026-03-11T00:00:00+00:00",
            "updated_at": "2026-03-11T00:00:00+00:00",
        }
    )
    await save_plan(plan.plan_id, plan.model_dump(mode="json"))
    raw_run = run.model_dump(mode="json")
    raw_run["user_id"] = "user-1"
    await save_run(run.run_id, raw_run)

    async def fake_backend_directed(**kwargs):
        _ = kwargs
        latest_run = await get_run(run.run_id)
        assert latest_run is not None
        return AutomationRun.model_validate(latest_run), False

    async def fake_runtime_execute(**kwargs):
        on_event = kwargs["on_event"]
        await on_event(
            {
                "type": "run.tool.finished",
                "payload": {
                    "toolName": "browser",
                    "args": {"action": "click", "ref": "send_button"},
                    "result": {
                        "details": {
                            "targetId": "page_0",
                            "url": "https://mail.google.com/mail/u/0/#inbox?compose=new",
                            "title": "Compose - Gmail",
                        }
                    },
                },
            }
        )
        return {"result": {"rows": [{"text": "The email has been sent."}]}, "error": "", "code": "", "runtime_events": []}

    async def fake_capture_visual_context(**kwargs):
        _ = kwargs
        return None, {
            "url": "https://mail.google.com/mail/u/0/#inbox?compose=new",
            "title": "Compose - Gmail",
            "bodyText": "Compose To yandrapueshwar2000@gmail.com Subject hi how are you",
            "editableFields": [
                {"ariaLabel": "To", "value": "yandrapueshwar2000@gmail.com"},
                {"ariaLabel": "Subject", "value": "hi"},
                {"ariaLabel": "Message Body", "value": "how are you"},
            ],
            "editableCount": 3,
            "dialogCount": 1,
        }

    async def fake_prepare_runtime_browser_surface(*args, **kwargs):
        _ = (args, kwargs)
        return None

    monkeypatch.setattr("oi_agent.automation.executor.execute_browser_prompt_via_runtime", fake_runtime_execute)
    monkeypatch.setattr("oi_agent.automation.executor._capture_agent_browser_visual_context", fake_capture_visual_context)
    monkeypatch.setattr("oi_agent.automation.executor._prepare_runtime_browser_surface", fake_prepare_runtime_browser_surface)
    monkeypatch.setattr("oi_agent.automation.executor._run_backend_directed_runtime_actions", fake_backend_directed)

    await _execute_run_via_automation_runtime(
        run_id=run.run_id,
        user_id="user-1",
        session_id=run.session_id,
        run=run,
        plan=plan,
        prompt=plan.summary,
        cdp_url="http://127.0.0.1:9222",
    )

    persisted_run = await get_run(run.run_id)
    assert persisted_run is not None
    assert persisted_run["state"] == "failed"
    assert persisted_run["last_error"]["code"] == "TERMINAL_COMPLETION_UNVERIFIED"


@pytest.mark.asyncio
async def test_execute_runtime_completion_clears_stale_runtime_incident(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await reset_store()
    plan = AutomationPlan.model_validate(
        {
            "plan_id": "plan-runtime-completed-clean",
            "intent_id": "intent-runtime-completed-clean",
            "execution_mode": "immediate",
            "summary": "Send an email",
            "execution_contract": {
                "contract_id": "contract-runtime-completed-clean",
                "resolved_goal": "Send the drafted email",
                "target_app": "Gmail",
                "target_entities": {
                    "recipient": "yandrapueshwar2000@gmail.com",
                    "subject": "hi",
                    "message_text": "how are you",
                },
                "task_shape": {"operation_chain": ["send"]},
            },
            "steps": [],
        }
    )
    await save_plan(plan.plan_id, plan.model_dump(mode="json"))
    run = AutomationRun.model_validate(
        {
            "run_id": "run-runtime-completed-clean",
            "user_id": "user-1",
            "intent_id": plan.intent_id,
            "session_id": "session-runtime-completed-clean",
            "plan_id": plan.plan_id,
            "state": "running",
            "execution_mode": "immediate",
            "executor_mode": "local_runner",
            "automation_engine": "agent_browser",
            "browser_session_id": "browser-session-1",
            "page_registry": {
                "page_0": {
                    "url": "https://mail.google.com/mail/u/0/#inbox",
                    "title": "Inbox - Gmail",
                }
            },
            "active_page_ref": "page_0",
            "runtime_incident": {
                "incident_id": "incident-stale",
                "category": "ambiguity",
                "severity": "warning",
                "code": "RUNTIME_AMBIGUOUS_ACTION",
                "summary": "Old ambiguity warning",
                "created_at": "2026-03-15T00:00:00+00:00",
            },
            "execution_progress": {
                "current_runtime_action": {
                    "action": "click",
                    "description": "Click the current page control",
                },
                "status_summary": "Still trying",
            },
            "created_at": "2026-03-15T00:00:00+00:00",
            "updated_at": "2026-03-15T00:00:00+00:00",
        }
    )
    await save_run(run.run_id, run.model_dump(mode="json"))

    async def fake_backend_directed(**kwargs):
        _ = kwargs
        latest_run = await get_run(run.run_id)
        assert latest_run is not None
        return AutomationRun.model_validate(latest_run), False

    async def fake_runtime_execute(**kwargs):
        on_event = kwargs["on_event"]
        await on_event(
            {
                "type": "run.runtime_incident",
                "payload": {
                    "code": "RUNTIME_AMBIGUOUS_ACTION",
                    "message": "The agent is circling through vague browser actions instead of locking onto a concrete target.",
                },
            }
        )
        await on_event(
            {
                "type": "run.browser.snapshot",
                "payload": {
                    "url": "https://mail.google.com/mail/u/0/#inbox",
                    "title": "Inbox - Gmail",
                    "snapshot": "Message sent Undo View message Inbox",
                    "targetId": "page_0",
                },
            }
        )
        return {
            "result": {
                "rows": [
                    {
                        "text": 'The email has been sent to yandrapueshwar2000@gmail.com with the subject "hi" and the message "how are you".'
                    }
                ]
            },
            "error": "",
            "code": "",
            "runtime_events": [],
        }

    async def fake_verify_completion(**kwargs):
        _ = kwargs
        return None

    async def fake_prepare_runtime_browser_surface(*args, **kwargs):
        _ = (args, kwargs)
        return None

    monkeypatch.setattr("oi_agent.automation.executor.execute_browser_prompt_via_runtime", fake_runtime_execute)
    monkeypatch.setattr("oi_agent.automation.executor._verify_runtime_completion_against_browser_state", fake_verify_completion)
    monkeypatch.setattr("oi_agent.automation.executor._prepare_runtime_browser_surface", fake_prepare_runtime_browser_surface)
    monkeypatch.setattr("oi_agent.automation.executor._run_backend_directed_runtime_actions", fake_backend_directed)

    await _execute_run_via_automation_runtime(
        run_id=run.run_id,
        user_id="user-1",
        session_id=run.session_id,
        run=run,
        plan=plan,
        prompt=plan.summary,
        cdp_url="http://127.0.0.1:9222",
    )

    persisted_run = await get_run(run.run_id)
    assert persisted_run is not None
    assert persisted_run["state"] == "completed"
    assert persisted_run["runtime_incident"] is None
    assert persisted_run["last_error"] is None
    assert persisted_run["execution_progress"]["current_runtime_action"] is None


@pytest.mark.asyncio
async def test_execute_run_via_automation_runtime_uses_backend_directed_actions_before_runtime_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await reset_store()
    plan = AutomationPlan.model_validate(
        {
            "plan_id": "plan-runtime-backend-directed",
            "intent_id": "intent-runtime-backend-directed",
            "execution_mode": "immediate",
            "summary": "Pick the first matching shirt result",
            "steps": [],
        }
    )
    run = AutomationRun.model_validate(
        {
            "run_id": "run-runtime-backend-directed",
            "plan_id": plan.plan_id,
            "session_id": "session-runtime-backend-directed",
            "state": "starting",
            "execution_mode": "immediate",
            "executor_mode": "server_runner",
            "automation_engine": "agent_browser",
            "browser_session_id": "browser-runtime-directed",
            "active_page_ref": "page_0",
            "page_registry": {
                "page_0": {
                    "url": "https://www.flipkart.com/search?q=maroon+shirt",
                    "title": "Flipkart Search",
                }
            },
            "total_steps": 0,
            "created_at": "2026-03-11T00:00:00+00:00",
            "updated_at": "2026-03-11T00:00:00+00:00",
        }
    )
    await save_plan(plan.plan_id, plan.model_dump(mode="json"))
    raw_run = run.model_dump(mode="json")
    raw_run["user_id"] = "user-1"
    await save_run(run.run_id, raw_run)

    async def fake_prepare_runtime_browser_surface(*args, **kwargs):
        _ = (args, kwargs)
        return None

    async def fake_backend_directed(**kwargs):
        _ = kwargs
        await save_run(
            run.run_id,
            {
                **raw_run,
                "user_id": "user-1",
                "state": "completed",
                "updated_at": "2026-03-11T00:01:00+00:00",
            },
        )
        latest_run = await get_run(run.run_id)
        assert latest_run is not None
        return AutomationRun.model_validate(latest_run), True

    async def fail_runtime_execute(**kwargs):
        _ = kwargs
        raise AssertionError("generic runtime prompt should not execute when backend-directed actions terminate the run")

    monkeypatch.setattr("oi_agent.automation.executor._prepare_runtime_browser_surface", fake_prepare_runtime_browser_surface)
    monkeypatch.setattr("oi_agent.automation.executor._run_backend_directed_runtime_actions", fake_backend_directed)
    monkeypatch.setattr("oi_agent.automation.executor.execute_browser_prompt_via_runtime", fail_runtime_execute)

    await _execute_run_via_automation_runtime(
        run_id=run.run_id,
        user_id="user-1",
        session_id=run.session_id,
        run=run,
        plan=plan,
        prompt=plan.summary,
        cdp_url="http://127.0.0.1:9222",
    )

    persisted_run = await get_run(run.run_id)
    assert persisted_run is not None
    assert persisted_run["state"] == "completed"


@pytest.mark.asyncio
async def test_verify_runtime_completion_uses_fresh_visual_state_over_stale_compose_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = AutomationPlan.model_validate(
        {
            "plan_id": "plan-runtime-email-verify",
            "intent_id": "intent-email-verify",
            "execution_mode": "immediate",
            "summary": "Send an email",
            "execution_contract": {
                "contract_id": "contract-email-verify",
                "resolved_goal": "Send an email now to yandrapueshwar2000@gmail.com subject hi email is how are you",
                "target_app": "Gmail",
                "target_entities": {
                    "recipient": "yandrapueshwar2000@gmail.com",
                    "subject": "hi",
                    "body": "how are you",
                },
                "task_shape": {"operation_chain": ["send"]},
            },
            "steps": [],
        }
    )

    async def fake_capture_visual_context(**kwargs):
        _ = kwargs
        return None, {
            "url": "https://mail.google.com/mail/u/0/#inbox",
            "title": "Inbox - Gmail",
            "bodyText": "Inbox View message hi how are you Sent",
            "editableFields": [],
            "editableCount": 0,
            "dialogCount": 0,
            "buttons": [
                {"text": "Compose", "ariaLabel": "", "name": ""},
            ],
            "activeElement": {"tag": "body", "role": "", "ariaLabel": "", "placeholder": "", "editable": False},
        }

    monkeypatch.setattr("oi_agent.automation.executor._capture_agent_browser_visual_context", fake_capture_visual_context)

    result = await _verify_runtime_completion_against_browser_state(
        cdp_url="http://127.0.0.1:9222",
        plan=plan,
        page_registry={"page_0": {"url": "https://mail.google.com/mail/u/0/#inbox", "title": "Inbox - Gmail"}},
        active_page_ref="page_0",
        runtime_observation={
            "url": "https://mail.google.com/mail/u/0/#inbox?compose=new",
            "title": "Compose - Gmail",
            "snapshot_text": "Compose New Message To Subject Message Body Send yandrapueshwar2000@gmail.com hi how are you",
        },
        runtime_text="Compose New Message To Subject Message Body Send yandrapueshwar2000@gmail.com hi how are you",
    )

    assert result is None


@pytest.mark.asyncio
async def test_verify_runtime_completion_requires_expected_state_change_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = AutomationPlan.model_validate(
        {
            "plan_id": "plan-runtime-verify-state",
            "intent_id": "intent-verify-state",
            "execution_mode": "immediate",
            "summary": "Archive the issue",
            "execution_contract": {
                "contract_id": "contract-verify-state",
                "resolved_goal": "Archive the issue from the inbox",
                "target_app": "Linear",
                "target_entities": {
                    "target": "Issue 123",
                },
                "task_shape": {"operation_chain": ["archive"]},
                "verification_evidence": {
                    "checks": ["archived"],
                    "expected_state_change": "item no longer appears in inbox",
                },
                "completion_criteria": ["item no longer appears in inbox"],
            },
            "steps": [],
        }
    )

    async def fake_capture_visual_context(**kwargs):
        _ = kwargs
        return None, {
            "url": "https://linear.app/inbox",
            "title": "Inbox - Linear",
            "bodyText": "Issue 123 still visible in inbox",
            "editableFields": [],
            "editableCount": 0,
            "dialogCount": 0,
            "buttons": [{"text": "Archive", "ariaLabel": "", "name": ""}],
            "activeElement": {"tag": "body", "role": "", "ariaLabel": "", "placeholder": "", "editable": False},
        }

    monkeypatch.setattr("oi_agent.automation.executor._capture_agent_browser_visual_context", fake_capture_visual_context)

    result = await _verify_runtime_completion_against_browser_state(
        cdp_url="http://127.0.0.1:9222",
        plan=plan,
        page_registry={"page_0": {"url": "https://linear.app/inbox", "title": "Inbox - Linear"}},
        active_page_ref="page_0",
        runtime_observation={
            "url": "https://linear.app/inbox",
            "title": "Inbox - Linear",
            "snapshot_text": "Issue 123 archive",
        },
        runtime_text="Completed successfully",
    )

    assert result is not None
    error, incident = result
    assert error.code == "TERMINAL_COMPLETION_UNVERIFIED"
    assert incident["code"] == "TERMINAL_COMPLETION_UNVERIFIED"


@pytest.mark.asyncio
async def test_verify_runtime_completion_prefers_fresh_runtime_success_observation_over_stale_visual_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = AutomationPlan.model_validate(
        {
            "plan_id": "plan-runtime-verify-fresh-success",
            "intent_id": "intent-verify-fresh-success",
            "execution_mode": "immediate",
            "summary": "Send the email",
            "execution_contract": {
                "contract_id": "contract-verify-fresh-success",
                "resolved_goal": "Send the drafted email",
                "target_app": "Gmail",
                "target_entities": {
                    "recipient": "yandrapueshwar2000@gmail.com",
                    "subject": "hi",
                    "message_text": "how are you",
                },
                "task_shape": {"operation_chain": ["send"]},
            },
            "steps": [],
        }
    )

    async def fake_capture_visual_context(**kwargs):
        _ = kwargs
        return None, {
            "url": "https://en.wikipedia.org/wiki/Alan_Turing",
            "title": "Alan Turing - Wikipedia",
            "bodyText": "Alan Turing article body",
            "editableFields": [],
            "editableCount": 0,
            "dialogCount": 0,
            "buttons": [],
            "activeElement": {"tag": "body", "role": "", "ariaLabel": "", "placeholder": "", "editable": False},
        }

    monkeypatch.setattr("oi_agent.automation.executor._capture_agent_browser_visual_context", fake_capture_visual_context)

    result = await _verify_runtime_completion_against_browser_state(
        cdp_url="http://127.0.0.1:9222",
        plan=plan,
        page_registry={"page_0": {"url": "https://en.wikipedia.org/wiki/Alan_Turing", "title": "Alan Turing - Wikipedia"}},
        active_page_ref="page_0",
        runtime_observation={
            "url": "https://mail.google.com/mail/u/0/#inbox",
            "title": "Inbox - Gmail",
            "snapshot_text": "Message sent Undo View message Inbox hi how are you Sent",
        },
        runtime_text='The email has been sent to yandrapueshwar2000@gmail.com with the subject "hi" and the message "how are you".',
    )

    assert result is None


def test_runtime_code_to_run_error_preserves_terminal_incident_codes() -> None:
    assert _runtime_code_to_run_error("AUTH_REQUIRED", "Login needed").code == "AUTH_REQUIRED"
    assert _runtime_code_to_run_error("OBSERVATION_EXHAUSTED", "No progress").retryable is True


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

    async def fake_sync_page_registry_over_cdp(*, cdp_url, step, page_registry, active_page_ref):
        _ = (cdp_url, step)
        return page_registry, active_page_ref, []

    async def fake_sync_agent_browser_active_tab(*, session_name, page_registry, active_page_ref):
        _ = (session_name, page_registry, active_page_ref)
        return None

    monkeypatch.setattr("oi_agent.automation.executor._AGENT_BROWSER_CLI", _FakeAgentBrowserCli())
    monkeypatch.setattr("oi_agent.automation.executor._run_node_json_command", fake_run_node_json_command)
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
