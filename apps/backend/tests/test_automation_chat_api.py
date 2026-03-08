from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from oi_agent.automation.events import reset_events
from oi_agent.automation.executor import reset_execution_tasks
from oi_agent.automation.schedule_service import reset_automation_schedules
from oi_agent.automation.store import reset_store
from oi_agent.auth.firebase_auth import get_current_user
from oi_agent.main import app


@pytest.fixture(autouse=True)
def _reset_state() -> None:
    import asyncio

    asyncio.run(reset_store())
    asyncio.run(reset_events())
    asyncio.run(reset_execution_tasks())
    asyncio.run(reset_automation_schedules())


@pytest_asyncio.fixture
async def client() -> AsyncClient:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


class _FakeSessionPage:
    def __init__(self, url: str = "https://example.com", title: str = "Example") -> None:
        self.url = url
        self._title = title

    async def title(self) -> str:
        return self._title

    async def evaluate(self, script: str):
        _ = script
        return {
            "url": self.url,
            "title": self._title,
            "elements": [],
            "viewport": {"w": 1280, "h": 720},
            "scrollY": 0,
        }


class _FakeSessionBrowser:
    async def close(self) -> None:
        return None


class _FakeSessionPlaywright:
    async def stop(self) -> None:
        return None


async def _create_browser_session(client: AsyncClient, *, runner_id: str) -> str:
    response = await client.post(
        "/browser/sessions",
        json={
            "origin": "local_runner",
            "runner_id": runner_id,
            "runner_label": runner_id,
            "metadata": {"cdp_url": "http://127.0.0.1:9222"},
        },
    )
    assert response.status_code == 200
    return response.json()["session"]["session_id"]


async def _fake_connect_browser_session(cdp_url: str):
    _ = cdp_url
    return _FakeSessionPlaywright(), _FakeSessionBrowser(), _FakeSessionPage()


@pytest.mark.asyncio
async def test_chat_prime_returns_short_lived_prepare_token(client: AsyncClient) -> None:
    response = await client.post(
        "/api/chat/prime",
        json={
            "session_id": "sess-prime-1",
            "partial_inputs": [{"type": "text", "text": "send a message to dippa"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["session_id"] == "sess-prime-1"
    assert isinstance(body["prepare_token"], str)
    assert body["prepare_token"]
    assert isinstance(body["expires_at"], str)


@pytest.mark.asyncio
async def test_chat_turn_requests_clarification_for_missing_message_text(client: AsyncClient) -> None:
    response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-1",
            "inputs": [{"type": "text", "text": "Send a message to John on WhatsApp"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["intent_draft"]["decision"] == "ASK_CLARIFICATION"
    assert "message_text" in body["intent_draft"]["missing_fields"]
    assert body["suggested_next_actions"][0]["type"] == "reply_text"


@pytest.mark.asyncio
async def test_chat_turn_requests_execution_mode_when_timing_is_missing(client: AsyncClient) -> None:
    response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-2",
            "inputs": [{"type": "text", "text": 'Open Gmail and search for "invoice from acme"'}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["intent_draft"]["decision"] == "ASK_EXECUTION_MODE"
    assert body["suggested_next_actions"][0]["type"] == "select_execution_mode"


@pytest.mark.asyncio
async def test_list_gemini_models_returns_fallback_items(client: AsyncClient) -> None:
    response = await client.get("/api/models/gemini")

    assert response.status_code == 200
    body = response.json()
    assert body["items"]
    assert any(item["id"].startswith("gemini") for item in body["items"])


@pytest.mark.asyncio
async def test_chat_turn_treats_greeting_as_general_chat(client: AsyncClient) -> None:
    response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-hi",
            "inputs": [{"type": "text", "text": "hi"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["intent_draft"]["goal_type"] == "general_chat"
    assert body["intent_draft"]["decision"] == "GENERAL_CHAT"
    assert body["intent_draft"]["user_goal"] == "hi"
    assert body["assistant_message"]["text"] == "Hi. I can help you automate something or answer a question."
    assert body["suggested_next_actions"] == []


@pytest.mark.asyncio
async def test_chat_turn_extracts_lowercase_recipient_and_asks_for_app(client: AsyncClient) -> None:
    response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-lowercase-send",
            "inputs": [{"type": "text", "text": "send hi to jacob"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["intent_draft"]["entities"]["recipient"] == "jacob"
    assert body["intent_draft"]["entities"]["message_text"] == "hi"
    assert body["intent_draft"]["missing_fields"] == ["app"]
    assert body["intent_draft"]["decision"] == "ASK_CLARIFICATION"
    assert body["assistant_message"]["text"] == "I can help with that. Which app should I use to message Jacob?"


@pytest.mark.asyncio
async def test_chat_turn_uses_previous_clarification_context_for_follow_up(client: AsyncClient) -> None:
    first = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-follow-up",
            "inputs": [{"type": "text", "text": "send a message to dippa on whatsapp"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    assert first.status_code == 200
    first_body = first.json()
    assert first_body["intent_draft"]["missing_fields"] == ["message_text"]

    follow_up = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-follow-up",
            "inputs": [{"type": "text", "text": "send hi ra"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )

    assert follow_up.status_code == 200
    body = follow_up.json()
    assert body["intent_draft"]["entities"]["recipient"] == "dippa"
    assert body["intent_draft"]["entities"]["app"] == "Whatsapp"
    assert body["intent_draft"]["entities"]["message_text"] == "hi ra"
    assert body["intent_draft"]["missing_fields"] == []
    assert body["intent_draft"]["decision"] == "ASK_EXECUTION_MODE"
    assert "run it now" in body["assistant_message"]["text"].lower()


@pytest.mark.asyncio
async def test_chat_turn_updates_active_intent_timing_from_follow_up(client: AsyncClient) -> None:
    await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-timing-follow-up",
            "inputs": [{"type": "text", "text": "send a message to dippa on whatsapp"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-timing-follow-up",
            "inputs": [{"type": "text", "text": "hi ra"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )

    response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-timing-follow-up",
            "inputs": [{"type": "text", "text": "tomorrow at 4pm"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["intent_draft"]["entities"]["recipient"] == "dippa"
    assert body["intent_draft"]["entities"]["app"] == "Whatsapp"
    assert body["intent_draft"]["entities"]["message_text"] == "hi ra"
    assert body["intent_draft"]["timing_mode"] == "once"
    assert body["intent_draft"]["decision"] == "REQUIRES_CONFIRMATION"
    assert "confirm" in body["assistant_message"]["text"].lower()


@pytest.mark.asyncio
async def test_resolve_execution_immediate_creates_confirmation_run_for_sensitive_task(
    client: AsyncClient,
) -> None:
    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-3",
            "inputs": [{"type": "text", "text": 'Send the message "done" to John on WhatsApp now'}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    intent_id = turn_response.json()["intent_draft"]["intent_id"]

    response = await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-3",
            "intent_id": intent_id,
            "execution_mode": "immediate",
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "awaiting_confirmation"
    assert body["run"]["state"] == "awaiting_confirmation"
    assert body["plan"]["requires_confirmation"] is True


@pytest.mark.asyncio
async def test_confirm_and_control_run_lifecycle(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import run_service as run_service_module

    async def fake_start_execution(run_id: str) -> None:
        _ = run_id

    monkeypatch.setattr(run_service_module, "start_execution", fake_start_execution)

    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-4",
            "inputs": [{"type": "text", "text": "Open Notion immediately"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    intent_id = turn_response.json()["intent_draft"]["intent_id"]

    resolve_response = await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-4",
            "intent_id": intent_id,
            "execution_mode": "immediate",
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )
    run_id = resolve_response.json()["run"]["run_id"]
    assert resolve_response.json()["run"]["state"] == "queued"

    get_response = await client.get(f"/api/runs/{run_id}")
    assert get_response.status_code == 200
    assert get_response.json()["run"]["run_id"] == run_id

    pause_response = await client.post(f"/api/runs/{run_id}/pause")
    assert pause_response.status_code == 200
    assert pause_response.json()["run"]["state"] == "paused"

    resume_response = await client.post(f"/api/runs/{run_id}/resume")
    assert resume_response.status_code == 200
    assert resume_response.json()["run"]["state"] == "queued"

    stop_response = await client.post(f"/api/runs/{run_id}/stop")
    assert stop_response.status_code == 200
    assert stop_response.json()["run"]["state"] == "cancelled"


@pytest.mark.asyncio
async def test_run_details_are_not_visible_to_other_users(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import run_service as run_service_module

    async def fake_start_execution(run_id: str) -> None:
        _ = run_id

    async def other_user():
        return {"uid": "other-user", "email": "other@example.com"}

    monkeypatch.setattr(run_service_module, "start_execution", fake_start_execution)

    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-cross-user-run",
            "inputs": [{"type": "text", "text": "Open Notion immediately"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    intent_id = turn_response.json()["intent_draft"]["intent_id"]
    resolve_response = await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-cross-user-run",
            "intent_id": intent_id,
            "execution_mode": "immediate",
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )
    run_id = resolve_response.json()["run"]["run_id"]

    app.dependency_overrides[get_current_user] = other_user
    try:
        get_response = await client.get(f"/api/runs/{run_id}")
        assert get_response.status_code == 404

        pause_response = await client.post(f"/api/runs/{run_id}/pause")
        assert pause_response.status_code == 404
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.asyncio
async def test_events_are_filtered_by_authenticated_user(client: AsyncClient) -> None:
    async def other_user():
        return {"uid": "other-user", "email": "other@example.com"}

    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-cross-user-events",
            "inputs": [{"type": "text", "text": "send hi to jacob on whatsapp"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    assert turn_response.status_code == 200

    app.dependency_overrides[get_current_user] = other_user
    try:
        events_response = await client.get("/api/events", params={"session_id": "sess-cross-user-events"})
        assert events_response.status_code == 200
        assert events_response.json()["items"] == []
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.asyncio
async def test_confirm_endpoint_moves_sensitive_run_to_queued(client: AsyncClient) -> None:
    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-5",
            "inputs": [{"type": "text", "text": 'Send the message "hello" to John on WhatsApp now'}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    intent_id = turn_response.json()["intent_draft"]["intent_id"]

    await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-5",
            "intent_id": intent_id,
            "execution_mode": "immediate",
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )

    confirm_response = await client.post(
        "/api/chat/confirm",
        json={"session_id": "sess-5", "intent_id": intent_id, "confirmed": True},
    )
    assert confirm_response.status_code == 200
    assert confirm_response.json()["run"]["state"] == "queued"


@pytest.mark.asyncio
async def test_immediate_execution_publishes_events_and_artifacts(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import executor as executor_module
    from oi_agent.services.tools.base import ToolResult

    async def fake_rewrite_user_prompt(
        *,
        user_prompt: str,
        current_url: str = "",
        current_page_title: str = "",
        playbook_context=None,
        timeout_seconds: float = 8.0,
        model_override: str | None = None,
    ):
        _ = (current_url, current_page_title, playbook_context, timeout_seconds, model_override)
        return user_prompt

    async def fake_plan_browser_steps(**kwargs):
        _ = kwargs
        return {
            "steps": [
                {"type": "browser", "id": "s1", "action": "navigate", "description": "Open target application"},
                {"type": "browser", "id": "s2", "action": "click", "description": "Perform the requested action"},
            ]
        }

    async def fake_execute_browser_steps_over_cdp(cdp_url: str, steps: list[dict[str, object]], **kwargs):
        _ = (cdp_url, kwargs)
        return ToolResult(
            success=True,
            data=[
                {"status": "done", "data": "ok", "screenshot": "data:image/png;base64,shot-0"},
                {"status": "done", "data": "ok", "screenshot": "data:image/png;base64,shot-1"},
            ],
            text="Completed 2 browser steps",
            metadata={"last_screenshot": "data:image/png;base64,final"},
        )

    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(
        executor_module,
        "_connect_browser_session",
        _fake_connect_browser_session,
    )
    monkeypatch.setattr(executor_module, "_execute_browser_steps_over_cdp", fake_execute_browser_steps_over_cdp)

    browser_session_id = await _create_browser_session(client, runner_id="runner-immediate")

    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-6",
            "inputs": [{"type": "text", "text": "Open Notion now"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    intent_id = turn_response.json()["intent_draft"]["intent_id"]

    resolve_response = await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-6",
            "intent_id": intent_id,
            "execution_mode": "immediate",
            "executor_mode": "local_runner",
            "browser_session_id": browser_session_id,
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )
    run_id = resolve_response.json()["run"]["run_id"]

    for _ in range(20):
        run_response = await client.get(f"/api/runs/{run_id}")
        if run_response.json()["run"]["state"] == "completed":
            break
        import asyncio

        await asyncio.sleep(0.01)

    run_body = run_response.json()
    assert run_body["run"]["state"] == "completed"
    assert len(run_body["artifacts"]) >= 2

    events_response = await client.get("/api/events", params={"session_id": "sess-6", "run_id": run_id})
    assert events_response.status_code == 200
    event_types = [item["type"] for item in events_response.json()["items"]]
    assert "run.created" in event_types
    assert "run.queued" in event_types
    assert "run.started" in event_types
    assert "step.started" in event_types
    assert "step.completed" in event_types
    assert "run.completed" in event_types


@pytest.mark.asyncio
async def test_selected_model_flows_into_rewrite_and_planner(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import executor as executor_module
    from oi_agent.services.tools.base import ToolResult

    seen_models: dict[str, str | None] = {"rewrite": None, "planner": None}

    async def fake_rewrite_user_prompt(
        *,
        user_prompt: str,
        current_url: str = "",
        current_page_title: str = "",
        playbook_context=None,
        timeout_seconds: float = 8.0,
        model_override: str | None = None,
    ):
        _ = (current_url, current_page_title, playbook_context, timeout_seconds)
        seen_models["rewrite"] = model_override
        return user_prompt

    async def fake_plan_browser_steps(**kwargs):
        seen_models["planner"] = kwargs.get("model_override")
        return {
            "steps": [
                {"type": "browser", "id": "s1", "action": "navigate", "description": "Open target application"},
            ]
        }

    async def fake_execute_browser_steps_over_cdp(cdp_url: str, steps: list[dict[str, object]], **kwargs):
        _ = (cdp_url, steps, kwargs)
        return ToolResult(
            success=True,
            data=[],
            text="Completed 1 browser step",
            metadata={"last_screenshot": "data:image/png;base64,final"},
        )

    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(
        executor_module,
        "_connect_browser_session",
        _fake_connect_browser_session,
    )
    monkeypatch.setattr(executor_module, "_execute_browser_steps_over_cdp", fake_execute_browser_steps_over_cdp)

    browser_session_id = await _create_browser_session(client, runner_id="runner-model")

    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-model-flow",
            "inputs": [{"type": "text", "text": "Open Notion now"}],
            "client_context": {
                "timezone": "Asia/Kolkata",
                "locale": "en-IN",
                "model": "gemini-3-flash-preview",
            },
        },
    )
    intent_id = turn_response.json()["intent_draft"]["intent_id"]

    resolve_response = await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-model-flow",
            "intent_id": intent_id,
            "execution_mode": "immediate",
            "executor_mode": "local_runner",
            "browser_session_id": browser_session_id,
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )

    assert resolve_response.status_code == 200
    assert seen_models["rewrite"] == "gemini-3-flash-preview"
    assert seen_models["planner"] == "gemini-3-flash-preview"


@pytest.mark.asyncio
async def test_interrupt_endpoint_pauses_run_and_emits_interruption_event(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import executor as executor_module
    from oi_agent.services.tools.base import ToolResult

    async def fake_rewrite_user_prompt(
        *,
        user_prompt: str,
        current_url: str = "",
        current_page_title: str = "",
        playbook_context=None,
        timeout_seconds: float = 8.0,
        model_override: str | None = None,
    ):
        _ = (current_url, current_page_title, playbook_context, timeout_seconds, model_override)
        return user_prompt

    async def fake_plan_browser_steps(**kwargs):
        _ = kwargs
        return {"steps": [{"type": "browser", "id": "s1", "action": "click", "description": "Click button"}]}

    release = asyncio.Event()

    async def fake_execute_browser_steps_over_cdp(cdp_url: str, steps: list[dict[str, object]], **kwargs):
        _ = (cdp_url, steps, kwargs)
        await release.wait()
        return ToolResult(
            success=True,
            data=[{"status": "done", "data": "ok", "screenshot": "data:image/png;base64,shot"}],
            text="done",
            metadata={"last_screenshot": "data:image/png;base64,final"},
        )

    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(
        executor_module,
        "_connect_browser_session",
        _fake_connect_browser_session,
    )
    monkeypatch.setattr(executor_module, "_execute_browser_steps_over_cdp", fake_execute_browser_steps_over_cdp)

    browser_session_id = await _create_browser_session(client, runner_id="runner-interrupt")

    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-7",
            "inputs": [{"type": "text", "text": "Open Notion now"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    intent_id = turn_response.json()["intent_draft"]["intent_id"]
    resolve_response = await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-7",
            "intent_id": intent_id,
            "execution_mode": "immediate",
            "executor_mode": "local_runner",
            "browser_session_id": browser_session_id,
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )
    run_id = resolve_response.json()["run"]["run_id"]

    interrupt_response = await client.post(
        f"/api/runs/{run_id}/interrupt",
        json={"reason": "I noticed activity on the page, so I paused to avoid conflicting actions.", "source": "user"},
    )
    assert interrupt_response.status_code == 200
    assert interrupt_response.json()["run"]["state"] == "paused"

    events_response = await client.get("/api/events", params={"session_id": "sess-7", "run_id": run_id})
    event_types = [item["type"] for item in events_response.json()["items"]]
    assert "run.interrupted_by_user" in event_types

    release.set()


@pytest.mark.asyncio
async def test_waiting_for_user_action_state_on_manual_intervention_error(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import executor as executor_module
    from oi_agent.services.tools.base import ToolResult

    async def fake_rewrite_user_prompt(
        *,
        user_prompt: str,
        current_url: str = "",
        current_page_title: str = "",
        playbook_context=None,
        timeout_seconds: float = 8.0,
        model_override: str | None = None,
    ):
        _ = (current_url, current_page_title, playbook_context, timeout_seconds, model_override)
        return user_prompt

    async def fake_plan_browser_steps(**kwargs):
        _ = kwargs
        return {"steps": [{"type": "browser", "id": "s1", "action": "click", "description": "Click login"}]}

    async def fake_execute_browser_steps_over_cdp(cdp_url: str, steps: list[dict[str, object]], **kwargs):
        _ = (cdp_url, steps, kwargs)
        return ToolResult(success=False, error="Manual intervention required (security_gate): captcha")

    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(
        executor_module,
        "_connect_browser_session",
        _fake_connect_browser_session,
    )
    monkeypatch.setattr(executor_module, "_execute_browser_steps_over_cdp", fake_execute_browser_steps_over_cdp)

    browser_session_id = await _create_browser_session(client, runner_id="runner-sensitive")

    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-8",
            "inputs": [{"type": "text", "text": "Open Gmail now"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    intent_id = turn_response.json()["intent_draft"]["intent_id"]
    resolve_response = await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-8",
            "intent_id": intent_id,
            "execution_mode": "immediate",
            "executor_mode": "local_runner",
            "browser_session_id": browser_session_id,
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )
    run_id = resolve_response.json()["run"]["run_id"]

    import asyncio

    for _ in range(20):
        run_response = await client.get(f"/api/runs/{run_id}")
        if run_response.json()["run"]["state"] == "waiting_for_human":
            break
        await asyncio.sleep(0.01)

    assert run_response.json()["run"]["state"] == "waiting_for_human"
    events_response = await client.get("/api/events", params={"session_id": "sess-8", "run_id": run_id})
    event_types = [item["type"] for item in events_response.json()["items"]]
    assert "run.waiting_for_human" in event_types


@pytest.mark.asyncio
async def test_invalid_transition_rejects_pause_after_completion(client: AsyncClient) -> None:
    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-9",
            "inputs": [{"type": "text", "text": "Open Notion now"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    intent_id = turn_response.json()["intent_draft"]["intent_id"]
    resolve_response = await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-9",
            "intent_id": intent_id,
            "execution_mode": "once",
            "schedule": {"run_at": ["2026-03-07T18:00:00Z"], "timezone": "Asia/Kolkata"},
        },
    )
    run_id = resolve_response.json()["run"]["run_id"]

    from oi_agent.automation.store import update_run

    await update_run(run_id, {"state": "completed"})
    pause_response = await client.post(f"/api/runs/{run_id}/pause")
    assert pause_response.status_code == 409


@pytest.mark.asyncio
async def test_schedule_runner_creates_persisted_run_and_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.api.browser import schedule_runner
    from oi_agent.automation import schedule_service as schedule_service_module
    from oi_agent.automation.events import list_events
    from oi_agent.automation.models import AutomationScheduleCreateRequest, ResolveExecutionSchedule
    from oi_agent.automation.schedule_service import create_automation_schedule
    from oi_agent.automation.store import get_run

    created_run_id: str | None = None

    async def fake_execute_run(run_id: str) -> None:
        nonlocal created_run_id
        created_run_id = run_id

    monkeypatch.setattr(schedule_runner, "execute_run", fake_execute_run)

    schedule = await create_automation_schedule(
        user_id="user-1",
        payload=AutomationScheduleCreateRequest(
            session_id="sess-sched-1",
            prompt="Open Gmail later",
            execution_mode="once",
            schedule=ResolveExecutionSchedule(run_at=["2026-03-07T18:00:00Z"], timezone="Asia/Kolkata"),
            device_id="device-1",
            tab_id=10,
        ),
    )
    schedule_service_module._memory_schedules[schedule.schedule_id]["next_run_at"] = "2026-03-07T00:00:00Z"
    await schedule_runner._run_one_automation_schedule(schedule.model_dump(mode="json"))

    assert created_run_id is not None
    run_row = await get_run(created_run_id)
    assert run_row is not None
    assert run_row["session_id"] == f"schedule:{schedule.schedule_id}"
    events = await list_events(session_id=f"schedule:{schedule.schedule_id}", run_id=created_run_id)
    event_types = [item["type"] for item in events]
    assert "run.created" in event_types
    assert "schedule.created" in event_types


@pytest.mark.asyncio
async def test_new_schedule_api_create_list_delete(client: AsyncClient) -> None:
    create_response = await client.post(
        "/api/schedules",
        json={
            "session_id": "sess-10",
            "prompt": "Open Gmail at 6 PM",
            "execution_mode": "once",
            "schedule": {"run_at": ["2026-03-07T18:00:00Z"], "timezone": "Asia/Kolkata"},
            "device_id": "device-10",
            "tab_id": 10,
        },
    )
    assert create_response.status_code == 200
    schedule_id = create_response.json()["schedule"]["schedule_id"]

    list_response = await client.get("/api/schedules")
    assert list_response.status_code == 200
    ids = [item["schedule_id"] for item in list_response.json()["items"]]
    assert schedule_id in ids

    delete_response = await client.delete(f"/api/schedules/{schedule_id}")
    assert delete_response.status_code == 200
    assert delete_response.json()["ok"] is True


@pytest.mark.asyncio
async def test_scheduler_claims_new_automation_schedule_and_dispatches_run(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.api.browser import schedule_runner
    from oi_agent.automation.models import AutomationScheduleCreateRequest, ResolveExecutionSchedule
    from oi_agent.automation.schedule_service import create_automation_schedule

    dispatched: list[str] = []

    async def fake_execute_run(run_id: str) -> None:
        dispatched.append(run_id)

    monkeypatch.setattr(schedule_runner, "execute_run", fake_execute_run)

    from oi_agent.automation import schedule_service as schedule_service_module

    schedule = await create_automation_schedule(
        user_id="dev-user",
        payload=AutomationScheduleCreateRequest(
            session_id="sess-11",
            prompt="Open Notion later",
            execution_mode="once",
            schedule=ResolveExecutionSchedule(run_at=["2026-03-07T18:00:00Z"], timezone="Asia/Kolkata"),
            device_id="device-11",
            tab_id=11,
        ),
    )
    schedule_service_module._memory_schedules[schedule.schedule_id]["next_run_at"] = "2026-03-07T00:00:00Z"

    due = await schedule_runner.list_due_automation_schedules(limit=10)
    assert any(item.schedule_id == schedule.schedule_id for item in due)

    await schedule_runner._run_one_automation_schedule(schedule.model_dump(mode="json"))
    assert len(dispatched) == 1

    events_response = await client.get("/api/events", params={"session_id": f"schedule:{schedule.schedule_id}"})
    event_types = [item["type"] for item in events_response.json()["items"]]
    assert "run.created" in event_types


@pytest.mark.asyncio
async def test_browser_session_lifecycle_endpoints(client: AsyncClient) -> None:
    create_response = await client.post(
        "/browser/sessions",
        json={
            "origin": "local_runner",
            "browser_session_id": "ab-session-1",
            "runner_id": "desktop-runner-1",
            "runner_label": "Yash Desktop",
            "page_id": "page-1",
            "browser_version": "Chrome 123",
            "viewport": {"width": 1440, "height": 900, "dpr": 2},
            "metadata": {"cdp_url": "http://127.0.0.1:9222"},
        },
    )

    assert create_response.status_code == 200
    created = create_response.json()["session"]
    assert created["origin"] == "local_runner"
    assert created["metadata"]["cdp_url"] == "http://127.0.0.1:9222"

    session_id = created["session_id"]
    get_response = await client.get(f"/browser/sessions/{session_id}")
    assert get_response.status_code == 200
    fetched = get_response.json()["session"]
    assert fetched["session_id"] == session_id

    update_response = await client.post(
        f"/browser/sessions/{session_id}",
        json={
            "status": "ready",
            "pages": [
                {
                    "page_id": "page-1",
                    "url": "https://example.com",
                    "title": "Example",
                    "is_active": True,
                }
            ],
        },
    )
    assert update_response.status_code == 200
    updated = update_response.json()["session"]
    assert updated["status"] == "ready"
    assert updated["pages"][0]["title"] == "Example"

    list_response = await client.get("/browser/sessions")
    assert list_response.status_code == 200
    items = list_response.json()["items"]
    assert len(items) == 1
    assert items[0]["session_id"] == session_id


@pytest.mark.asyncio
async def test_run_transitions_persist_for_create_and_confirm(client: AsyncClient) -> None:
    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-transitions",
            "inputs": [{"type": "text", "text": 'Send the message "done" to John on WhatsApp now'}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    assert turn_response.status_code == 200
    intent_id = turn_response.json()["intent_draft"]["intent_id"]

    resolve_response = await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-transitions",
            "intent_id": intent_id,
            "execution_mode": "immediate",
            "executor_mode": "local_runner",
            "browser_session_id": "browser-session-1",
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )
    assert resolve_response.status_code == 200
    run_id = resolve_response.json()["run"]["run_id"]

    initial_transitions = await client.get(f"/api/runs/{run_id}/transitions")
    assert initial_transitions.status_code == 200
    initial_items = initial_transitions.json()["items"]
    assert len(initial_items) == 1
    assert initial_items[0]["reason_code"] == "RUN_CREATED"
    assert initial_items[0]["to_state"] == "awaiting_confirmation"

    confirm_response = await client.post(
        "/api/chat/confirm",
        json={
            "session_id": "sess-transitions",
            "intent_id": intent_id,
            "confirmed": True,
        },
    )
    assert confirm_response.status_code == 200

    final_transitions = await client.get(f"/api/runs/{run_id}/transitions")
    assert final_transitions.status_code == 200
    final_items = final_transitions.json()["items"]
    reason_codes = [item["reason_code"] for item in final_items]
    assert reason_codes[:2] == ["RUN_CREATED", "INTENT_CONFIRMED"]
    assert "STATE_STARTING" in reason_codes


@pytest.mark.asyncio
async def test_runner_register_and_heartbeat_flow(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.config import settings

    monkeypatch.setattr(settings, "runner_shared_secret", "runner-secret")

    register_response = await client.post(
        "/browser/runners/register",
        headers={"x-oi-runner-secret": "runner-secret"},
        json={
            "user_id": "dev-user",
            "origin": "local_runner",
            "runner_id": "desktop-runner-1",
            "runner_label": "Desktop",
            "metadata": {"cdp_url": "http://127.0.0.1:9222"},
        },
    )
    assert register_response.status_code == 200
    session = register_response.json()["session"]
    assert session["runner_id"] == "desktop-runner-1"
    assert session["metadata"]["cdp_url"] == "http://127.0.0.1:9222"

    heartbeat_response = await client.post(
        "/browser/runners/heartbeat",
        headers={"x-oi-runner-secret": "runner-secret"},
        json={
            "runner_id": "desktop-runner-1",
            "session_id": session["session_id"],
            "status": "ready",
            "pages": [
                {
                    "page_id": "page-1",
                    "url": "https://example.com",
                    "title": "Example",
                    "is_active": True,
                }
            ],
        },
    )
    assert heartbeat_response.status_code == 200
    updated = heartbeat_response.json()["session"]
    assert updated["status"] == "ready"
    assert updated["pages"][0]["url"] == "https://example.com"


@pytest.mark.asyncio
async def test_browser_session_controller_lock_and_input_flow(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.api.websocket import connection_manager
    from oi_agent.automation import run_service as run_service_module

    sent_frames: list[dict[str, object]] = []
    resumed_runs: list[str] = []

    async def fake_send_to_runner(runner_id: str, payload: dict[str, object]) -> bool:
        sent_frames.append({"runner_id": runner_id, **payload})
        return True

    async def fake_start_execution(run_id: str) -> None:
        resumed_runs.append(run_id)

    monkeypatch.setattr(connection_manager, "get_runner_for_session", lambda session_id: "desktop-runner-1")
    monkeypatch.setattr(connection_manager, "send_to_runner", fake_send_to_runner)
    monkeypatch.setattr(run_service_module, "start_execution", fake_start_execution)

    create_response = await client.post(
        "/browser/sessions",
        json={
            "origin": "local_runner",
            "runner_id": "desktop-runner-1",
            "runner_label": "Desktop",
            "metadata": {"cdp_url": "http://127.0.0.1:9222"},
        },
    )
    assert create_response.status_code == 200
    session_id = create_response.json()["session"]["session_id"]

    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-session-control",
            "inputs": [{"type": "text", "text": "Open Notion immediately"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    assert turn_response.status_code == 200
    intent_id = turn_response.json()["intent_draft"]["intent_id"]

    resolve_response = await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-session-control",
            "intent_id": intent_id,
            "execution_mode": "immediate",
            "executor_mode": "local_runner",
            "browser_session_id": session_id,
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )
    assert resolve_response.status_code == 200
    run_id = resolve_response.json()["run"]["run_id"]

    acquire_response = await client.post(
        f"/browser/sessions/{session_id}/controller/acquire",
        json={
            "actor_id": "web-test-controller",
            "actor_type": "web",
            "priority": 100,
            "ttl_seconds": 300,
        },
    )
    assert acquire_response.status_code == 200
    acquired = acquire_response.json()["session"]
    assert acquired["controller_lock"]["actor_id"] == "web-test-controller"

    run_response = await client.get(f"/api/runs/{run_id}")
    assert run_response.status_code == 200
    assert run_response.json()["run"]["state"] == "human_controlling"

    input_response = await client.post(
        f"/browser/sessions/{session_id}/input",
        json={
            "actor_id": "web-test-controller",
            "input_type": "click",
            "x": 640,
            "y": 360,
        },
    )
    assert input_response.status_code == 200
    assert sent_frames
    assert sent_frames[0]["runner_id"] == "desktop-runner-1"
    payload = sent_frames[0]["payload"]
    assert isinstance(payload, dict)
    assert payload["action"] == "input"
    assert payload["input_type"] == "click"

    release_response = await client.post(
        f"/browser/sessions/{session_id}/controller/release",
        json={"actor_id": "web-test-controller"},
    )
    assert release_response.status_code == 200
    assert release_response.json()["session"]["controller_lock"] is None
    assert resumed_runs == [run_id, run_id]

    released_run_response = await client.get(f"/api/runs/{run_id}")
    assert released_run_response.status_code == 200
    assert released_run_response.json()["run"]["state"] == "queued"

    audit_response = await client.get(f"/browser/sessions/{session_id}/audit")
    assert audit_response.status_code == 200
    audit_actions = [item["action"] for item in audit_response.json()["items"]]
    assert "acquire" in audit_actions
    assert "input" in audit_actions
    assert "release" in audit_actions


@pytest.mark.asyncio
async def test_approve_sensitive_action_requeues_waiting_run(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import run_service as run_service_module
    from oi_agent.automation.store import update_run

    started_runs: list[str] = []

    async def fake_start_execution(run_id: str) -> None:
        started_runs.append(run_id)

    monkeypatch.setattr(run_service_module, "start_execution", fake_start_execution)

    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-sensitive-approve",
            "inputs": [{"type": "text", "text": "Open the billing page immediately"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    assert turn_response.status_code == 200
    intent_id = turn_response.json()["intent_draft"]["intent_id"]

    resolve_response = await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-sensitive-approve",
            "intent_id": intent_id,
            "execution_mode": "immediate",
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )
    assert resolve_response.status_code == 200
    run_id = resolve_response.json()["run"]["run_id"]

    await update_run(
        run_id,
        {
            "state": "waiting_for_human",
            "last_error": {
                "code": "SENSITIVE_ACTION_BLOCKED",
                "message": "A login or payment page requires approval.",
                "retryable": True,
            },
        },
    )

    approve_response = await client.post(f"/api/runs/{run_id}/approve-sensitive-action")
    assert approve_response.status_code == 200
    assert approve_response.json()["run"]["state"] == "queued"
    assert started_runs == [run_id, run_id]


@pytest.mark.asyncio
async def test_browser_session_controller_priority_conflict_and_preemption(
    client: AsyncClient,
) -> None:
    create_response = await client.post(
        "/browser/sessions",
        json={
            "origin": "local_runner",
            "runner_id": "desktop-runner-2",
            "runner_label": "Desktop",
        },
    )
    assert create_response.status_code == 200
    session_id = create_response.json()["session"]["session_id"]

    first_lock = await client.post(
        f"/browser/sessions/{session_id}/controller/acquire",
        json={
            "actor_id": "desktop-controller",
            "actor_type": "desktop",
            "priority": 200,
            "ttl_seconds": 300,
        },
    )
    assert first_lock.status_code == 200
    assert first_lock.json()["session"]["controller_lock"]["actor_id"] == "desktop-controller"

    blocked_lock = await client.post(
        f"/browser/sessions/{session_id}/controller/acquire",
        json={
            "actor_id": "web-controller",
            "actor_type": "web",
            "priority": 100,
            "ttl_seconds": 300,
        },
    )
    assert blocked_lock.status_code == 409

    preempt_lock = await client.post(
        f"/browser/sessions/{session_id}/controller/acquire",
        json={
            "actor_id": "system-controller",
            "actor_type": "system",
            "priority": 300,
            "ttl_seconds": 300,
        },
    )
    assert preempt_lock.status_code == 200
    assert preempt_lock.json()["session"]["controller_lock"]["actor_id"] == "system-controller"
