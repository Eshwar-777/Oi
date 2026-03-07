from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from oi_agent.automation.events import reset_events
from oi_agent.automation.executor import reset_execution_tasks
from oi_agent.automation.schedule_service import reset_automation_schedules
from oi_agent.automation.store import reset_store
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
    from oi_agent.services.tools.browser_automation import BrowserAutomationTool

    async def fake_fetch_page_snapshot(device_id: str, tab_id: int | None, run_id: str):
        _ = (device_id, tab_id, run_id)
        return {"url": "https://example.com", "title": "Example"}

    async def fake_rewrite_user_prompt(*, user_prompt: str, current_url: str = "", current_page_title: str = "", timeout_seconds: float = 8.0):
        _ = (current_url, current_page_title, timeout_seconds)
        return user_prompt

    async def fake_plan_browser_steps(**kwargs):
        _ = kwargs
        return {
            "steps": [
                {"type": "browser", "id": "s1", "action": "navigate", "description": "Open target application"},
                {"type": "browser", "id": "s2", "action": "click", "description": "Perform the requested action"},
            ]
        }

    async def fake_execute(self, context, input_data):
        steps = input_data[0]["steps"]
        for idx, step in enumerate(steps):
            await context.action_config["before_step"](idx, step)
            await context.action_config["after_step"](
                idx,
                step,
                {"status": "done", "data": "ok", "screenshot": f"data:image/png;base64,shot-{idx}"},
            )
        return ToolResult(
            success=True,
            data=[],
            text="Completed 2 browser steps",
            metadata={"last_screenshot": "data:image/png;base64,final"},
        )

    monkeypatch.setattr(executor_module, "fetch_page_snapshot", fake_fetch_page_snapshot)
    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(executor_module, "resolve_device_and_tab_for_prompt", lambda **kwargs: ("device-1", 11))
    monkeypatch.setattr(BrowserAutomationTool, "execute", fake_execute)

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
async def test_interrupt_endpoint_pauses_run_and_emits_interruption_event(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import executor as executor_module
    from oi_agent.api.websocket import connection_manager
    from oi_agent.services.tools.base import ToolResult
    from oi_agent.services.tools.browser_automation import BrowserAutomationTool

    sent_controls: list[dict[str, object]] = []

    async def fake_send_to_device(device_id: str, data: dict[str, object]) -> bool:
        sent_controls.append({"device_id": device_id, **data})
        return True

    async def fake_fetch_page_snapshot(device_id: str, tab_id: int | None, run_id: str):
        _ = (device_id, tab_id, run_id)
        return {"url": "https://example.com", "title": "Example"}

    async def fake_rewrite_user_prompt(*, user_prompt: str, current_url: str = "", current_page_title: str = "", timeout_seconds: float = 8.0):
        _ = (current_url, current_page_title, timeout_seconds)
        return user_prompt

    async def fake_plan_browser_steps(**kwargs):
        _ = kwargs
        return {"steps": [{"type": "browser", "id": "s1", "action": "click", "description": "Click button"}]}

    release = asyncio.Event()

    async def fake_execute(self, context, input_data):
        step = input_data[0]["steps"][0]
        await context.action_config["before_step"](0, step)
        await release.wait()
        await context.action_config["after_step"](
            0, step, {"status": "done", "data": "ok", "screenshot": "data:image/png;base64,shot"}
        )
        return ToolResult(success=True, text="done", metadata={"last_screenshot": "data:image/png;base64,final"})

    monkeypatch.setattr(connection_manager, "send_to_device", fake_send_to_device)
    monkeypatch.setattr(executor_module, "fetch_page_snapshot", fake_fetch_page_snapshot)
    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(executor_module, "resolve_device_and_tab_for_prompt", lambda **kwargs: ("device-9", 99))
    monkeypatch.setattr(BrowserAutomationTool, "execute", fake_execute)

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
    assert any(item["type"] == "yield_control" for item in sent_controls)

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
    from oi_agent.services.tools.browser_automation import BrowserAutomationTool

    async def fake_fetch_page_snapshot(device_id: str, tab_id: int | None, run_id: str):
        _ = (device_id, tab_id, run_id)
        return {"url": "https://example.com", "title": "Example"}

    async def fake_rewrite_user_prompt(*, user_prompt: str, current_url: str = "", current_page_title: str = "", timeout_seconds: float = 8.0):
        _ = (current_url, current_page_title, timeout_seconds)
        return user_prompt

    async def fake_plan_browser_steps(**kwargs):
        _ = kwargs
        return {"steps": [{"type": "browser", "id": "s1", "action": "click", "description": "Click login"}]}

    async def fake_execute(self, context, input_data):
        _ = (context, input_data)
        return ToolResult(success=False, error="Manual intervention required (security_gate): captcha")

    monkeypatch.setattr(executor_module, "fetch_page_snapshot", fake_fetch_page_snapshot)
    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(executor_module, "resolve_device_and_tab_for_prompt", lambda **kwargs: ("device-2", 12))
    monkeypatch.setattr(BrowserAutomationTool, "execute", fake_execute)

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
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )
    run_id = resolve_response.json()["run"]["run_id"]

    import asyncio

    for _ in range(20):
        run_response = await client.get(f"/api/runs/{run_id}")
        if run_response.json()["run"]["state"] == "waiting_for_user_action":
            break
        await asyncio.sleep(0.01)

    assert run_response.json()["run"]["state"] == "waiting_for_user_action"
    events_response = await client.get("/api/events", params={"session_id": "sess-8", "run_id": run_id})
    event_types = [item["type"] for item in events_response.json()["items"]]
    assert "run.waiting_for_user_action" in event_types


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
    from oi_agent.automation.schedule_service import create_automation_schedule
    from oi_agent.automation.models import AutomationScheduleCreateRequest, ResolveExecutionSchedule

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
