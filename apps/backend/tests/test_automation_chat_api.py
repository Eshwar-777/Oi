from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from oi_agent.automation.events import reset_events
from oi_agent.automation.executor import reset_execution_tasks
from oi_agent.automation.intent_extractor import IntentExtraction
from oi_agent.automation.schedule_service import reset_automation_schedules
from oi_agent.automation.store import reset_store, save_run, save_run_transition
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


class _FakeCDPPage:
    def __init__(self, url: str = "https://example.com", title: str = "Example") -> None:
        self.url = url
        self._title = title

    async def title(self) -> str:
        return self._title


class _FakeCDPContext:
    def __init__(self, pages: list[_FakeCDPPage] | None = None) -> None:
        self.pages = list(pages or [])

    async def new_page(self) -> _FakeCDPPage:
        page = _FakeCDPPage(url="about:blank", title="New Tab")
        self.pages.append(page)
        return page


class _FakeCDPBrowser:
    def __init__(self, context: _FakeCDPContext) -> None:
        self.contexts = [context]


class _FakeStuckAnalysis:
    def __init__(
        self,
        *,
        is_stuck: bool = True,
        reason: str | None = None,
        stuck_type: str | None = None,
        confidence: float = 0.95,
        suggested_action: str | None = None,
    ) -> None:
        self.is_stuck = is_stuck
        self.reason = reason
        self.stuck_type = stuck_type
        self.confidence = confidence
        self.suggested_action = suggested_action


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
async def test_automation_engine_analytics_aggregates_runs(client: AsyncClient) -> None:
    await save_run(
        "run-agent-1",
        {
            "run_id": "run-agent-1",
            "plan_id": "plan-1",
            "session_id": "sess-analytics",
            "state": "completed",
            "execution_mode": "immediate",
            "executor_mode": "server_runner",
            "automation_engine": "agent_browser",
            "browser_session_id": "browser-1",
            "current_step_index": 1,
            "total_steps": 2,
            "created_at": "2026-03-08T10:00:00+00:00",
            "updated_at": "2026-03-08T10:00:20+00:00",
            "last_error": None,
        },
    )
    await save_run(
        "run-agent-2",
        {
            "run_id": "run-agent-2",
            "plan_id": "plan-2",
            "session_id": "sess-analytics",
            "state": "failed",
            "execution_mode": "immediate",
            "executor_mode": "local_runner",
            "automation_engine": "agent_browser",
            "browser_session_id": "browser-2",
            "current_step_index": 0,
            "total_steps": 2,
            "created_at": "2026-03-08T11:00:00+00:00",
            "updated_at": "2026-03-08T11:00:10+00:00",
            "last_error": {"code": "EXECUTION_FAILED", "message": "boom", "retryable": True},
        },
    )
    await save_run(
        "run-agent-3",
        {
            "run_id": "run-agent-3",
            "plan_id": "plan-3",
            "session_id": "sess-analytics",
            "state": "waiting_for_human",
            "execution_mode": "immediate",
            "executor_mode": "server_runner",
            "automation_engine": "agent_browser",
            "browser_session_id": "browser-3",
            "current_step_index": 0,
            "total_steps": 2,
            "created_at": "2026-03-08T12:00:00+00:00",
            "updated_at": "2026-03-08T12:00:15+00:00",
            "last_error": {"code": "SENSITIVE_ACTION_BLOCKED", "message": "approval required", "retryable": True},
        },
    )
    await save_run_transition(
        "transition-agent-1",
        {
            "transition_id": "transition-agent-1",
            "run_id": "run-agent-3",
            "from_state": "running",
            "to_state": "waiting_for_human",
            "reason_code": "STATE_WAITING_FOR_HUMAN",
            "reason_text": "approval required",
            "actor_type": "system",
            "created_at": "2026-03-08T12:00:15+00:00",
        },
    )

    response = await client.get("/api/analytics/automation-engines")

    assert response.status_code == 200
    body = response.json()
    assert [item["automation_engine"] for item in body["items"]] == ["agent_browser"]
    agent_browser = body["items"][0]
    assert agent_browser["total_runs"] == 3
    assert agent_browser["completed_runs"] == 1
    assert agent_browser["failed_runs"] == 1
    assert agent_browser["human_paused_runs"] == 1
    assert agent_browser["success_rate"] == pytest.approx(1 / 3, rel=1e-3)
    assert agent_browser["failure_rate"] == pytest.approx(1 / 3, rel=1e-3)
    assert agent_browser["human_pause_rate"] == pytest.approx(1 / 3, rel=1e-3)
    assert agent_browser["server_runner_runs"] == 2
    assert agent_browser["local_runner_runs"] == 1
    assert agent_browser["avg_duration_seconds"] == 15.0


@pytest.mark.asyncio
async def test_runtime_incident_analytics_aggregates_by_code_site_and_engine(client: AsyncClient) -> None:
    await save_run(
        "run-incident-auth-1",
        {
            "run_id": "run-incident-auth-1",
            "plan_id": "plan-incident-1",
            "session_id": "sess-incident-analytics",
            "state": "waiting_for_human",
            "execution_mode": "immediate",
            "executor_mode": "server_runner",
            "automation_engine": "agent_browser",
            "browser_session_id": "browser-incident-1",
            "current_step_index": 0,
            "total_steps": 1,
            "created_at": "2026-03-08T10:00:00+00:00",
            "updated_at": "2026-03-08T10:00:10+00:00",
            "runtime_incident": {
                "incident_id": "incident-auth-1",
                "category": "auth",
                "severity": "critical",
                "code": "POPUP_AUTH_FLOW",
                "summary": "Login popup opened.",
                "browser_snapshot": {
                    "captured_at": "2026-03-08T10:00:10+00:00",
                    "url": "https://auth.example.com/login",
                    "title": "Sign in",
                },
                "created_at": "2026-03-08T10:00:10+00:00",
            },
        },
    )
    await save_run(
        "run-incident-auth-2",
        {
            "run_id": "run-incident-auth-2",
            "plan_id": "plan-incident-2",
            "session_id": "sess-incident-analytics",
            "state": "reconciling",
            "execution_mode": "immediate",
            "executor_mode": "local_runner",
            "automation_engine": "agent_browser",
            "browser_session_id": "browser-incident-2",
            "current_step_index": 1,
            "total_steps": 2,
            "created_at": "2026-03-08T11:00:00+00:00",
            "updated_at": "2026-03-08T11:00:20+00:00",
            "runtime_incident": {
                "incident_id": "incident-auth-2",
                "category": "auth",
                "severity": "critical",
                "code": "POPUP_AUTH_FLOW",
                "summary": "Login popup opened.",
                "browser_snapshot": {
                    "captured_at": "2026-03-08T11:00:20+00:00",
                    "url": "https://auth.example.com/login",
                    "title": "Sign in",
                },
                "created_at": "2026-03-08T11:00:20+00:00",
            },
        },
    )

    response = await client.get("/api/analytics/runtime-incidents")

    assert response.status_code == 200
    body = response.json()
    assert len(body["items"]) == 1
    item = body["items"][0]
    assert item["incident_code"] == "POPUP_AUTH_FLOW"
    assert item["category"] == "auth"
    assert item["site"] == "auth.example.com"
    assert item["total_runs"] == 2
    assert item["waiting_for_human_runs"] == 1
    assert item["reconciliation_runs"] == 1
    assert item["engines"] == {"agent_browser": 2}


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
async def test_chat_turn_uses_llm_workflow_interpretation_for_broad_browser_task(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_extract_with_ai(text: str, requested_model: str | None = None) -> IntentExtraction | None:
        _ = (text, requested_model)
        return IntentExtraction(
            user_goal="Play a music video on YouTube, copy the first comment, and send it to Younus on WhatsApp",
            goal_type="ui_automation",
            workflow_outline=[
                "Open YouTube and play a music video",
                "Copy the first visible comment",
                "Open WhatsApp and send the copied comment to Younus",
            ],
            entities={
                "source_app": "YouTube",
                "target_app": "WhatsApp",
                "recipient": "Younus",
                "message_text": "first visible comment from the selected video",
            },
            timing_mode="unknown",
            timing_candidates=[],
            can_automate=True,
            confidence=0.95,
            risk_flags=["MESSAGE_SEND"],
            missing_fields=[],
        )

    monkeypatch.setattr("oi_agent.automation.intent_extractor._extract_with_ai", fake_extract_with_ai)

    response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-broad-workflow",
            "inputs": [
                {
                    "type": "text",
                    "text": "play a music video on youtube, copy the first comment that you see and send it to my friend named younus on whatsapp",
                }
            ],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["intent_draft"]["decision"] == "ASK_EXECUTION_MODE"
    assert body["intent_draft"]["missing_fields"] == []
    assert body["intent_draft"]["interpretation"]["task_kind"] == "browser_automation"
    assert body["intent_draft"]["interpretation"]["execution_intent"] == "unspecified"
    assert body["intent_draft"]["workflow_outline"] == [
        "Open YouTube and play a music video",
        "Copy the first visible comment",
        "Open WhatsApp and send the copied comment to Younus",
    ]


@pytest.mark.asyncio
async def test_chat_turn_routes_recurring_schedule_from_task_interpretation(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_extract_with_ai(text: str, requested_model: str | None = None) -> IntentExtraction | None:
        _ = (text, requested_model)
        return IntentExtraction(
            user_goal="Open Gmail every weekday morning and check for invoices",
            goal_type="ui_automation",
            task_kind="browser_automation",
            execution_intent="recurring",
            workflow_outline=[
                "Open Gmail",
                "Search for invoices",
                "Review unread invoice emails",
            ],
            entities={"app": "Gmail"},
            timing_mode="interval",
            timing_candidates=["weekday_morning"],
            can_automate=True,
            confidence=0.96,
            risk_flags=[],
            missing_fields=[],
        )

    monkeypatch.setattr("oi_agent.automation.intent_extractor._extract_with_ai", fake_extract_with_ai)

    response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-recurring-interpretation",
            "inputs": [{"type": "text", "text": "every weekday morning open gmail and check for invoices"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["intent_draft"]["interpretation"]["execution_intent"] == "recurring"
    assert body["intent_draft"]["decision"] == "READY_TO_SCHEDULE"
    assert body["intent_draft"]["timing_mode"] == "interval"


@pytest.mark.asyncio
async def test_chat_turn_uses_interpretation_clarification_hint_for_workflow_gap(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_extract_with_ai(text: str, requested_model: str | None = None) -> IntentExtraction | None:
        _ = (text, requested_model)
        return IntentExtraction(
            user_goal="Open LinkedIn, find a candidate profile, and send them a note",
            goal_type="ui_automation",
            task_kind="browser_automation",
            execution_intent="unspecified",
            workflow_outline=[
                "Open LinkedIn",
                "Find the target candidate profile",
                "Send a note to the candidate",
            ],
            clarification_hints=["I can continue with this LinkedIn workflow, but I still need who the candidate is."],
            entities={"app": "LinkedIn"},
            timing_mode="unknown",
            timing_candidates=[],
            can_automate=True,
            confidence=0.92,
            risk_flags=["MESSAGE_SEND"],
            missing_fields=["candidate"],
        )

    monkeypatch.setattr("oi_agent.automation.intent_extractor._extract_with_ai", fake_extract_with_ai)

    response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-clarification-hint",
            "inputs": [{"type": "text", "text": "open linkedin and send them a note"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["intent_draft"]["decision"] == "ASK_CLARIFICATION"
    assert body["assistant_message"]["text"] == "I can continue with this LinkedIn workflow, but I still need who the candidate is."


@pytest.mark.asyncio
async def test_resolve_execution_seeds_plan_from_workflow_outline(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_extract_with_ai(text: str, requested_model: str | None = None) -> IntentExtraction | None:
        _ = (text, requested_model)
        return IntentExtraction(
            user_goal="Play a music video on YouTube, copy the first comment, and send it to Younus on WhatsApp",
            goal_type="ui_automation",
            task_kind="browser_automation",
            execution_intent="immediate",
            workflow_outline=[
                "Open YouTube and play a music video",
                "Copy the first visible comment",
                "Open WhatsApp and send the copied comment to Younus",
            ],
            entities={
                "source_app": "YouTube",
                "target_app": "WhatsApp",
                "recipient": "Younus",
            },
            timing_mode="immediate",
            timing_candidates=["explicit_immediate"],
            can_automate=True,
            confidence=0.95,
            risk_flags=["MESSAGE_SEND"],
            missing_fields=[],
        )

    monkeypatch.setattr("oi_agent.automation.intent_extractor._extract_with_ai", fake_extract_with_ai)

    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-outline-plan",
            "inputs": [
                {
                    "type": "text",
                    "text": "play a music video on youtube, copy the first comment and send it to younus on whatsapp now",
                }
            ],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    assert turn_response.status_code == 200
    intent_id = turn_response.json()["intent_draft"]["intent_id"]

    resolve_response = await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-outline-plan",
            "intent_id": intent_id,
            "execution_mode": "immediate",
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )

    assert resolve_response.status_code == 200
    plan = resolve_response.json()["plan"]
    labels = [step["label"] for step in plan["steps"]]
    kinds = [step["kind"] for step in plan["steps"]]
    assert labels[:3] == [
        "Open YouTube and play a music video",
        "Copy the first visible comment",
        "Open WhatsApp and send the copied comment to Younus",
    ]
    assert kinds[:3] == ["navigate", "extract", "type"]
    assert plan["targets"][0]["app_name"] == "WhatsApp"
    assert plan["steps"][0]["page_hint"] == "YouTube"
    assert plan["steps"][0]["page_ref"] == "page_youtube"
    assert plan["steps"][1]["output_key"] == "comment_text"
    assert plan["steps"][2]["page_hint"] == "WhatsApp"
    assert plan["steps"][2]["page_ref"] == "page_whatsapp"
    assert plan["steps"][2]["consumes_keys"] == ["comment_text"]


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
async def test_chat_turn_keeps_previous_context_for_same_task_follow_up(client: AsyncClient) -> None:
    first = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-same-task-follow-up",
            "inputs": [{"type": "text", "text": "send a message to dippa on whatsapp"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    assert first.status_code == 200
    assert first.json()["intent_draft"]["decision"] == "ASK_CLARIFICATION"

    second = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-same-task-follow-up",
            "inputs": [{"type": "text", "text": "send hi ra"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    assert second.status_code == 200
    assert second.json()["intent_draft"]["entities"]["message_text"] == "hi ra"

    follow_up = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-same-task-follow-up",
            "inputs": [{"type": "text", "text": "send the same message to tortoise on whatsapp"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )

    assert follow_up.status_code == 200
    body = follow_up.json()
    assert body["intent_draft"]["entities"]["recipient"] == "tortoise"
    assert body["intent_draft"]["entities"]["app"] == "Whatsapp"
    assert body["intent_draft"]["entities"]["message_text"] == "hi ra"
    assert body["intent_draft"]["decision"] == "ASK_EXECUTION_MODE"


@pytest.mark.asyncio
async def test_chat_turn_does_not_merge_fully_specified_new_task_with_previous_context(client: AsyncClient) -> None:
    first = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-new-task-isolation",
            "inputs": [{"type": "text", "text": "send a message to dippa on whatsapp"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    assert first.status_code == 200

    second = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-new-task-isolation",
            "inputs": [{"type": "text", "text": "send hi ra"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    assert second.status_code == 200

    new_task = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-new-task-isolation",
            "inputs": [{"type": "text", "text": 'send the message "hi pruthvi, please ignore this message, its automated" to tortoise on whatsapp'}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )

    assert new_task.status_code == 200
    body = new_task.json()
    assert body["intent_draft"]["entities"]["recipient"] == "tortoise"
    assert body["intent_draft"]["entities"]["app"] == "Whatsapp"
    assert "dippa" not in str(body["intent_draft"]["user_goal"]).lower()
    assert "hi pruthvi" in str(body["intent_draft"]["entities"].get("message_text", "")).lower()


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
    from oi_agent.api.websocket import connection_manager

    async def fake_start_execution(run_id: str) -> None:
        _ = run_id

    monkeypatch.setattr(run_service_module, "start_execution", fake_start_execution)
    monkeypatch.setattr(
        connection_manager,
        "get_latest_session_frame",
        lambda session_id: {
            "session_id": session_id,
            "current_url": "https://www.notion.so",
            "page_title": "Notion",
            "page_id": "page-1",
            "screenshot": "data:image/png;base64,abc",
        },
    )

    browser_session_id = await _create_browser_session(client, runner_id="resume-runner-1")

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
            "executor_mode": "local_runner",
            "browser_session_id": browser_session_id,
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
    assert resume_response.json()["run"]["state"] == "reconciling"
    assert resume_response.json()["run"]["resume_context"]["browser_snapshot"]["url"] == "https://www.notion.so"

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
    monkeypatch.setattr(executor_module, "_execute_browser_steps_with_agent_browser", fake_execute_browser_steps_over_cdp)

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
async def test_immediate_execution_materializes_known_variables_from_extract_steps(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import executor as executor_module
    from oi_agent.services.tools.base import ToolResult

    async def fake_extract_with_ai(text: str, requested_model: str | None = None) -> IntentExtraction | None:
        _ = (text, requested_model)
        return IntentExtraction(
            user_goal="Play a music video on YouTube, copy the first comment, and send it to Younus on WhatsApp now",
            goal_type="ui_automation",
            task_kind="browser_automation",
            execution_intent="immediate",
            workflow_outline=[
                "Open YouTube and play a music video",
                "Copy the first visible comment",
                "Open WhatsApp and send the copied comment to Younus",
            ],
            entities={
                "source_app": "YouTube",
                "target_app": "WhatsApp",
                "recipient": "Younus",
            },
            timing_mode="immediate",
            timing_candidates=["explicit_immediate"],
            can_automate=True,
            confidence=0.95,
            risk_flags=["MESSAGE_SEND"],
            missing_fields=[],
        )

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
                {"type": "browser", "id": "s1", "action": "navigate", "description": "Open YouTube and play a music video"},
                {"type": "browser", "id": "s2", "action": "extract", "description": "Copy the first visible comment"},
                {"type": "browser", "id": "s3", "action": "type", "description": "Open WhatsApp and send the copied comment to Younus"},
            ]
        }

    async def fake_execute_browser_steps_over_cdp(cdp_url: str, steps: list[dict[str, object]], **kwargs):
        _ = (cdp_url, kwargs)
        assert len(steps) == 1
        action = steps[0].get("action")
        if action == "extract":
            return ToolResult(
                success=True,
                data=[{"status": "done", "data": {"text": "This song is fire"}, "screenshot": "data:image/png;base64,shot-1"}],
                text="Extracted comment",
                metadata={"last_screenshot": "data:image/png;base64,shot-1"},
            )
        if action == "type":
            return ToolResult(
                success=True,
                data=[{"status": "done", "data": "sent", "screenshot": "data:image/png;base64,shot-2"}],
                text="Sent message",
                metadata={"last_screenshot": "data:image/png;base64,shot-2"},
            )
        return ToolResult(
            success=True,
            data=[{"status": "done", "data": "ok", "screenshot": "data:image/png;base64,shot-0"}],
            text="Completed step",
            metadata={"last_screenshot": "data:image/png;base64,shot-0"},
        )

    monkeypatch.setattr("oi_agent.automation.intent_extractor._extract_with_ai", fake_extract_with_ai)
    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(executor_module, "_connect_browser_session", _fake_connect_browser_session)
    monkeypatch.setattr(executor_module, "_execute_browser_steps_with_agent_browser", fake_execute_browser_steps_over_cdp)

    browser_session_id = await _create_browser_session(client, runner_id="runner-known-variables")

    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-known-variables",
            "inputs": [
                {
                    "type": "text",
                    "text": "play a music video on youtube, copy the first comment and send it to younus on whatsapp now",
                }
            ],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    assert turn_response.status_code == 200
    intent_id = turn_response.json()["intent_draft"]["intent_id"]

    resolve_response = await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-known-variables",
            "intent_id": intent_id,
            "execution_mode": "immediate",
            "executor_mode": "local_runner",
            "browser_session_id": browser_session_id,
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )
    assert resolve_response.status_code == 200
    assert resolve_response.json()["run"]["state"] == "awaiting_confirmation"

    confirm_response = await client.post(
        "/api/chat/confirm",
        json={
            "session_id": "sess-known-variables",
            "intent_id": intent_id,
            "confirmed": True,
        },
    )
    assert confirm_response.status_code == 200
    run_id = confirm_response.json()["run"]["run_id"]

    for _ in range(20):
        run_response = await client.get(f"/api/runs/{run_id}")
        if run_response.json()["run"]["state"] == "completed":
            break
        await asyncio.sleep(0.01)

    run_body = run_response.json()
    assert run_body["run"]["state"] == "completed"
    assert run_body["run"]["known_variables"]["comment_text"] == "This song is fire"
    assert run_body["plan"]["steps"][1]["output_key"] == "comment_text"
    assert run_body["plan"]["steps"][2]["consumes_keys"] == ["comment_text"]


@pytest.mark.asyncio
async def test_immediate_execution_substitutes_known_variables_into_later_steps(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import executor as executor_module
    from oi_agent.services.tools.base import ToolResult

    seen_step_values: list[object] = []

    async def fake_extract_with_ai(text: str, requested_model: str | None = None) -> IntentExtraction | None:
        _ = (text, requested_model)
        return IntentExtraction(
            user_goal="Play a music video on YouTube, copy the first comment, and send it to Younus on WhatsApp now",
            goal_type="ui_automation",
            task_kind="browser_automation",
            execution_intent="immediate",
            workflow_outline=[
                "Open YouTube and play a music video",
                "Copy the first visible comment",
                "Open WhatsApp and send the copied comment to Younus",
            ],
            entities={
                "source_app": "YouTube",
                "target_app": "WhatsApp",
                "recipient": "Younus",
            },
            timing_mode="immediate",
            timing_candidates=["explicit_immediate"],
            can_automate=True,
            confidence=0.95,
            risk_flags=["MESSAGE_SEND"],
            missing_fields=[],
        )

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
                {"type": "browser", "id": "s1", "action": "navigate", "description": "Open YouTube and play a music video"},
                {"type": "browser", "id": "s2", "action": "extract", "description": "Copy the first visible comment"},
                {"type": "browser", "id": "s3", "action": "type", "description": "Open WhatsApp and send the copied comment to Younus"},
            ]
        }

    async def fake_execute_browser_steps_over_cdp(cdp_url: str, steps: list[dict[str, object]], **kwargs):
        _ = (cdp_url, kwargs)
        assert len(steps) == 1
        step = steps[0]
        seen_step_values.append(step.get("value"))
        action = step.get("action")
        if action == "extract":
            return ToolResult(
                success=True,
                data=[{"status": "done", "data": {"text": "This song is fire"}, "screenshot": "data:image/png;base64,shot-1"}],
                text="Extracted comment",
                metadata={"last_screenshot": "data:image/png;base64,shot-1"},
            )
        return ToolResult(
            success=True,
            data=[{"status": "done", "data": "ok", "screenshot": "data:image/png;base64,shot"}],
            text="ok",
            metadata={"last_screenshot": "data:image/png;base64,shot"},
        )

    monkeypatch.setattr("oi_agent.automation.intent_extractor._extract_with_ai", fake_extract_with_ai)
    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(executor_module, "_connect_browser_session", _fake_connect_browser_session)
    monkeypatch.setattr(executor_module, "_execute_browser_steps_with_agent_browser", fake_execute_browser_steps_over_cdp)

    browser_session_id = await _create_browser_session(client, runner_id="runner-variable-substitution")

    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-variable-substitution",
            "inputs": [
                {
                    "type": "text",
                    "text": "play a music video on youtube, copy the first comment and send it to younus on whatsapp now",
                }
            ],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    assert turn_response.status_code == 200
    intent_id = turn_response.json()["intent_draft"]["intent_id"]

    resolve_response = await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-variable-substitution",
            "intent_id": intent_id,
            "execution_mode": "immediate",
            "executor_mode": "local_runner",
            "browser_session_id": browser_session_id,
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )
    assert resolve_response.status_code == 200

    confirm_response = await client.post(
        "/api/chat/confirm",
        json={
            "session_id": "sess-variable-substitution",
            "intent_id": intent_id,
            "confirmed": True,
        },
    )
    assert confirm_response.status_code == 200
    run_id = confirm_response.json()["run"]["run_id"]

    for _ in range(20):
        run_response = await client.get(f"/api/runs/{run_id}")
        if run_response.json()["run"]["state"] == "completed":
            break
        await asyncio.sleep(0.01)

    run_body = run_response.json()
    assert run_body["run"]["state"] == "completed"
    assert seen_step_values == [None, None, "This song is fire"]


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
    monkeypatch.setattr(executor_module, "_execute_browser_steps_with_agent_browser", fake_execute_browser_steps_over_cdp)

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
    monkeypatch.setattr(executor_module, "_execute_browser_steps_with_agent_browser", fake_execute_browser_steps_over_cdp)

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
    monkeypatch.setattr(executor_module, "_execute_browser_steps_with_agent_browser", fake_execute_browser_steps_over_cdp)

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
async def test_schedule_claim_lease_expires_and_allows_reclaim() -> None:
    from oi_agent.automation import schedule_service as schedule_service_module
    from oi_agent.automation.models import AutomationScheduleCreateRequest, ResolveExecutionSchedule
    from oi_agent.automation.schedule_service import (
        claim_automation_schedule,
        create_automation_schedule,
        list_due_automation_schedules,
    )

    schedule = await create_automation_schedule(
        user_id="dev-user",
        payload=AutomationScheduleCreateRequest(
            session_id="sess-lease-1",
            prompt="Open docs later",
            execution_mode="once",
            schedule=ResolveExecutionSchedule(run_at=["2026-03-07T18:00:00Z"], timezone="Asia/Kolkata"),
        ),
    )
    schedule_service_module._memory_schedules[schedule.schedule_id]["next_run_at"] = "2026-03-07T00:00:00Z"

    claimed = await claim_automation_schedule(schedule_id=schedule.schedule_id, worker_id="worker-a")
    assert claimed is not None
    assert claimed.claimed_by == "worker-a"
    assert claimed.claim_expires_at is not None

    due_while_claimed = await list_due_automation_schedules(limit=10)
    assert all(item.schedule_id != schedule.schedule_id for item in due_while_claimed)

    schedule_service_module._memory_schedules[schedule.schedule_id]["claim_expires_at"] = "2026-03-07T00:00:00Z"
    due_after_expiry = await list_due_automation_schedules(limit=10)
    assert any(item.schedule_id == schedule.schedule_id for item in due_after_expiry)

    reclaimed = await claim_automation_schedule(schedule_id=schedule.schedule_id, worker_id="worker-b")
    assert reclaimed is not None
    assert reclaimed.claimed_by == "worker-b"


@pytest.mark.asyncio
async def test_event_store_supports_cursor_replay() -> None:
    from oi_agent.automation.store import get_event, list_events_since, save_event

    await save_event(
        "evt-1",
        {
            "event_id": "evt-1",
            "session_id": "sess-cursor",
            "run_id": "run-cursor",
            "type": "run.created",
            "timestamp": "2026-03-08T10:00:00+00:00",
            "payload": {},
        },
    )
    await save_event(
        "evt-2",
        {
            "event_id": "evt-2",
            "session_id": "sess-cursor",
            "run_id": "run-cursor",
            "type": "run.started",
            "timestamp": "2026-03-08T10:00:01+00:00",
            "payload": {},
        },
    )

    fetched = await get_event("evt-1")
    assert fetched is not None
    assert fetched["type"] == "run.created"

    replay = await list_events_since(
        after_timestamp="2026-03-08T10:00:00+00:00",
        session_id="sess-cursor",
        run_id="run-cursor",
    )
    assert [item["event_id"] for item in replay] == ["evt-1", "evt-2"]


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
    monkeypatch.setattr(
        connection_manager,
        "get_latest_session_frame",
        lambda session_id: {
            "session_id": session_id,
            "current_url": "https://notion.so/workspace",
            "page_title": "Workspace",
            "page_id": "page-1",
            "screenshot": "data:image/png;base64,frame",
        },
    )

    session_id = await _create_browser_session(client, runner_id="billing-runner-1")
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
    assert released_run_response.json()["run"]["state"] == "reconciling"
    assert released_run_response.json()["run"]["resume_context"]["trigger"] == "human_control_released"
    assert released_run_response.json()["run"]["resume_context"]["browser_snapshot"]["title"] == "Workspace"

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
    from oi_agent.api.websocket import connection_manager

    started_runs: list[str] = []

    async def fake_start_execution(run_id: str) -> None:
        started_runs.append(run_id)

    monkeypatch.setattr(run_service_module, "start_execution", fake_start_execution)
    monkeypatch.setattr(
        connection_manager,
        "get_latest_session_frame",
        lambda session_id: {
            "session_id": session_id,
            "current_url": "https://billing.example.com",
            "page_title": "Billing",
            "page_id": "page-2",
            "screenshot": "data:image/png;base64,billing",
        },
    )
    session_id = await _create_browser_session(client, runner_id="billing-runner-1")

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
            "executor_mode": "local_runner",
            "browser_session_id": session_id,
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
    assert approve_response.json()["run"]["state"] == "reconciling"
    assert approve_response.json()["run"]["resume_context"]["trigger"] == "sensitive_action_approved"
    assert started_runs == [run_id, run_id]


@pytest.mark.asyncio
async def test_executor_reconciliation_replans_remaining_steps(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation.executor import _apply_resume_reconciliation
    from oi_agent.automation.models import AutomationPlan, AutomationRun, AutomationStep
    from oi_agent.automation.store import get_plan, get_run, save_plan, save_run

    plan = AutomationPlan(
        plan_id="plan-reconcile-1",
        intent_id="intent-reconcile-1",
        execution_mode="immediate",
        summary="Open YouTube, copy the first comment, and send it on WhatsApp",
        steps=[
            AutomationStep(step_id="s1", kind="navigate", label="Open YouTube", page_hint="YouTube", status="completed"),
            AutomationStep(step_id="s2", kind="extract", label="Copy first comment", output_key="comment_text", page_hint="YouTube", status="completed"),
            AutomationStep(step_id="s3", kind="type", label="Send on WhatsApp", page_hint="WhatsApp", consumes_keys=["comment_text"], status="pending"),
        ],
    )
    await save_plan(plan.plan_id, plan.model_dump(mode="json"))
    run = AutomationRun(
        run_id="run-reconcile-1",
        plan_id=plan.plan_id,
        session_id="sess-reconcile-1",
        state="reconciling",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-reconcile-1",
        current_step_index=2,
        total_steps=3,
        created_at="2026-03-08T10:00:00+00:00",
        updated_at="2026-03-08T10:00:00+00:00",
    )
    await save_run(run.run_id, run.model_dump(mode="json"))

    async def fake_connect_browser_session(cdp_url: str):
        _ = cdp_url
        return _FakeSessionPlaywright(), _FakeSessionBrowser(), _FakeSessionPage(
            url="https://www.youtube.com/watch?v=abc",
            title="Video",
        )

    async def fake_rewrite_user_prompt(**kwargs):
        return kwargs["user_prompt"]

    async def fake_plan_browser_steps(**kwargs):
        _ = kwargs
        return {
            "steps": [
                {
                    "type": "browser",
                    "id": "s-new-1",
                    "action": "click",
                    "description": "Open the first visible comment",
                },
                {
                    "type": "browser",
                    "id": "s-new-2",
                    "action": "type",
                    "description": "Send the copied comment in WhatsApp",
                },
            ]
        }

    async def fake_browser_session_metadata(browser_session_id: str):
        _ = browser_session_id
        return {"metadata": {"cdp_url": "http://127.0.0.1:9222"}}

    monkeypatch.setattr("oi_agent.automation.executor._connect_browser_session", fake_connect_browser_session)
    monkeypatch.setattr("oi_agent.automation.executor.rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr("oi_agent.automation.executor.plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr("oi_agent.automation.executor._browser_session_metadata", fake_browser_session_metadata)

    await _apply_resume_reconciliation(run.run_id)

    updated_run = await get_run(run.run_id)
    assert updated_run is not None
    assert updated_run["state"] == "running"
    assert updated_run["resume_decision"]["status"] == "replace_remaining_steps"
    assert updated_run["resume_decision"]["skipped_step_ids"] == ["s3"]
    assert updated_run["resume_context"]["known_variables"]["comment_text"] == "from_step:s2"

    updated_plan = await get_plan(plan.plan_id)
    assert updated_plan is not None
    step_ids = [step["step_id"] for step in updated_plan["steps"]]
    assert step_ids == ["s1", "s2", "s-new-1", "s-new-2"]


@pytest.mark.asyncio
async def test_reconciliation_prompt_includes_trigger_incident_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation.executor import _apply_resume_reconciliation
    from oi_agent.automation.models import AutomationPlan, AutomationRun, AutomationStep
    from oi_agent.automation.store import save_plan, save_run

    captured: dict[str, str] = {}

    plan = AutomationPlan(
        plan_id="plan-reconcile-incident-1",
        intent_id="intent-reconcile-incident-1",
        execution_mode="immediate",
        summary="Continue after login popup",
        steps=[
            AutomationStep(step_id="s1", kind="navigate", label="Open app", page_ref="page_primary", status="completed"),
            AutomationStep(step_id="s2", kind="click", label="Continue after login", page_ref="page_primary", status="pending"),
        ],
    )
    await save_plan(plan.plan_id, plan.model_dump(mode="json"))
    run = AutomationRun(
        run_id="run-reconcile-incident-1",
        plan_id=plan.plan_id,
        session_id="sess-reconcile-incident",
        state="reconciling",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-reconcile-incident-1",
        current_step_index=1,
        total_steps=2,
        created_at="2026-03-08T10:00:00+00:00",
        updated_at="2026-03-08T10:00:00+00:00",
        page_registry={
            "page_primary": {"url": "https://example.com", "title": "Example"},
            "page_login": {"url": "https://auth.example.com/login", "title": "Sign in"},
        },
        active_page_ref="page_login",
        resume_context={
            "resume_id": "resume-incident-1",
            "trigger": "manual_resume",
            "previous_state": "waiting_for_human",
            "current_step_index": 1,
            "current_plan_summary": "Continue after login popup",
            "browser_snapshot": {
                "captured_at": "2026-03-08T10:00:00+00:00",
                "url": "https://auth.example.com/login",
                "title": "Sign in",
                "page_id": "page_login",
                "metadata": {"page_ref": "page_login"},
            },
            "trigger_incident": {
                "incident_id": "incident-popup-auth-1",
                "category": "auth",
                "severity": "critical",
                "code": "POPUP_AUTH_FLOW",
                "summary": "The automation opened an authentication page in a new tab.",
                "details": "Sign in popup opened.",
                "visible_signals": ["login", "sign in"],
                "requires_human": True,
                "replannable": True,
                "user_visible": True,
                "browser_snapshot": {
                    "captured_at": "2026-03-08T10:00:00+00:00",
                    "url": "https://auth.example.com/login",
                    "title": "Sign in",
                    "page_id": "page_login",
                    "metadata": {"page_ref": "page_login"},
                },
                "created_at": "2026-03-08T10:00:00+00:00",
            },
            "known_variables": {},
            "recent_human_actions": [],
            "incident_id": "incident-popup-auth-1",
            "created_at": "2026-03-08T10:00:00+00:00",
        },
    )
    await save_run(run.run_id, run.model_dump(mode="json"))

    async def fake_connect_browser_session(cdp_url: str):
        _ = cdp_url
        return _FakeSessionPlaywright(), _FakeSessionBrowser(), _FakeSessionPage(
            url="https://auth.example.com/login",
            title="Sign in",
        )

    async def fake_rewrite_user_prompt(**kwargs):
        captured["prompt"] = kwargs["user_prompt"]
        return kwargs["user_prompt"]

    async def fake_plan_browser_steps(**kwargs):
        _ = kwargs
        return {
            "steps": [
                {"type": "browser", "id": "s-new-1", "action": "click", "description": "Continue from the authenticated state"},
            ]
        }

    async def fake_browser_session_metadata(browser_session_id: str):
        _ = browser_session_id
        return {"metadata": {"cdp_url": "http://127.0.0.1:9222"}}

    monkeypatch.setattr("oi_agent.automation.executor._connect_browser_session", fake_connect_browser_session)
    monkeypatch.setattr("oi_agent.automation.executor.rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr("oi_agent.automation.executor.plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr("oi_agent.automation.executor._browser_session_metadata", fake_browser_session_metadata)

    await _apply_resume_reconciliation(run.run_id)

    prompt = captured["prompt"]
    assert "Incident code: POPUP_AUTH_FLOW" in prompt
    assert "Incident category: auth" in prompt
    assert "page_login" in prompt
    assert "Known page refs in the run:" in prompt


@pytest.mark.asyncio
async def test_cdp_page_resolution_creates_and_reuses_page_refs() -> None:
    from oi_agent.automation.executor import _resolve_cdp_page_for_step

    first_page = _FakeCDPPage(url="https://www.youtube.com", title="YouTube")
    context = _FakeCDPContext([first_page])
    browser = _FakeCDPBrowser(context)

    page, page_registry, active_page_ref = await _resolve_cdp_page_for_step(
        browser=browser,
        fallback_page=first_page,
        step={"action": "navigate", "page_ref": "page_youtube"},
        page_registry={},
        active_page_ref=None,
    )

    assert page is first_page
    assert active_page_ref == "page_youtube"
    assert page_registry["page_youtube"]["url"] == "https://www.youtube.com"

    second_page, page_registry, active_page_ref = await _resolve_cdp_page_for_step(
        browser=browser,
        fallback_page=first_page,
        step={"action": "navigate", "page_ref": "page_whatsapp"},
        page_registry=page_registry,
        active_page_ref=active_page_ref,
    )

    second_page.url = "https://web.whatsapp.com"
    second_page._title = "WhatsApp"
    page_registry["page_whatsapp"]["url"] = second_page.url
    page_registry["page_whatsapp"]["title"] = second_page._title

    assert second_page is not first_page
    assert len(context.pages) == 2
    assert active_page_ref == "page_whatsapp"

    reused_page, reused_registry, reused_active_page_ref = await _resolve_cdp_page_for_step(
        browser=browser,
        fallback_page=first_page,
        step={"action": "type", "page_ref": "page_whatsapp"},
        page_registry=page_registry,
        active_page_ref="page_youtube",
    )

    assert reused_page is second_page
    assert reused_active_page_ref == "page_whatsapp"
    assert reused_registry["page_whatsapp"]["url"] == "https://web.whatsapp.com"


@pytest.mark.asyncio
async def test_engine_wrapper_forwards_page_registry_to_agent_browser(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation.executor import _execute_browser_steps_with_engine
    from oi_agent.services.tools.base import ToolResult

    seen: dict[str, object] = {}

    async def fake_agent_browser(cdp_url: str, steps: list[dict[str, object]], *, page_registry=None, active_page_ref=None):
        seen["agent_browser"] = {
            "cdp_url": cdp_url,
            "steps": steps,
            "page_registry": page_registry,
            "active_page_ref": active_page_ref,
        }
        return ToolResult(success=True, data=[{"status": "done", "data": "ok"}], metadata={})

    monkeypatch.setattr("oi_agent.automation.executor._execute_browser_steps_with_agent_browser", fake_agent_browser)

    await _execute_browser_steps_with_engine(
        automation_engine="agent_browser",
        cdp_url="http://127.0.0.1:9222",
        steps=[{"action": "navigate", "page_ref": "page_youtube"}],
        run_id="run-1",
        session_id="sess-1",
        page_registry={"page_youtube": {"url": "https://www.youtube.com"}},
        active_page_ref="page_youtube",
    )

    assert seen["agent_browser"] == {
        "cdp_url": "http://127.0.0.1:9222",
        "steps": [{"action": "navigate", "page_ref": "page_youtube"}],
        "page_registry": {"page_youtube": {"url": "https://www.youtube.com"}},
        "active_page_ref": "page_youtube",
    }


@pytest.mark.asyncio
async def test_immediate_execution_publishes_page_opened_event_for_new_tabs(
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
                {"type": "browser", "id": "s1", "action": "navigate", "description": "Open Notion"},
            ]
        }

    async def fake_execute_browser_steps_over_cdp(cdp_url: str, steps: list[dict[str, object]], **kwargs):
        _ = (cdp_url, steps, kwargs)
        return ToolResult(
            success=True,
            data=[{"status": "done", "data": "ok", "screenshot": "data:image/png;base64,shot"}],
            text="Completed 1 browser step",
            metadata={
                "last_screenshot": "data:image/png;base64,shot",
                "page_registry": {
                    "page_notion": {"url": "https://www.notion.so", "title": "Notion"},
                    "page_oauth": {"url": "https://accounts.example.com/oauth", "title": "OAuth Login", "auto_detected": True},
                },
                "active_page_ref": "page_notion",
                "new_page_refs": [
                    {
                        "page_ref": "page_oauth",
                        "url": "https://accounts.example.com/oauth",
                        "title": "OAuth Login",
                    }
                ],
            },
        )

    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(executor_module, "_connect_browser_session", _fake_connect_browser_session)
    monkeypatch.setattr(executor_module, "_execute_browser_steps_with_agent_browser", fake_execute_browser_steps_over_cdp)

    browser_session_id = await _create_browser_session(client, runner_id="runner-page-opened")

    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-page-opened",
            "inputs": [{"type": "text", "text": "Open Notion now"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    assert turn_response.status_code == 200
    intent_id = turn_response.json()["intent_draft"]["intent_id"]

    resolve_response = await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-page-opened",
            "intent_id": intent_id,
            "execution_mode": "immediate",
            "executor_mode": "local_runner",
            "browser_session_id": browser_session_id,
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )
    assert resolve_response.status_code == 200
    run_id = resolve_response.json()["run"]["run_id"]

    for _ in range(20):
        run_response = await client.get(f"/api/runs/{run_id}")
        if run_response.json()["run"]["state"] == "completed":
            break
        await asyncio.sleep(0.01)

    events_response = await client.get("/api/events", params={"session_id": "sess-page-opened", "run_id": run_id})
    assert events_response.status_code == 200
    page_opened = [item for item in events_response.json()["items"] if item["type"] == "run.page_opened"]
    assert len(page_opened) == 1
    assert page_opened[0]["payload"]["page_ref"] == "page_oauth"
    assert page_opened[0]["payload"]["title"] == "OAuth Login"


@pytest.mark.asyncio
async def test_immediate_execution_pauses_for_material_popup_incident(
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
            ]
        }

    async def fake_execute_browser_steps_over_cdp(cdp_url: str, steps: list[dict[str, object]], **kwargs):
        _ = (cdp_url, steps, kwargs)
        return ToolResult(
            success=True,
            data=[{"status": "done", "data": "ok", "screenshot": "data:image/png;base64,shot"}],
            text="Completed 1 browser step",
            metadata={
                "last_screenshot": "data:image/png;base64,shot",
                "page_registry": {
                    "page_primary": {"url": "https://example.com", "title": "Example"},
                    "page_login": {"url": "https://auth.example.com/login", "title": "Sign in", "auto_detected": True},
                },
                "active_page_ref": "page_primary",
                "new_page_refs": [
                    {
                        "page_ref": "page_login",
                        "url": "https://auth.example.com/login",
                        "title": "Sign in",
                    }
                ],
            },
        )

    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(executor_module, "_connect_browser_session", _fake_connect_browser_session)
    monkeypatch.setattr(executor_module, "_execute_browser_steps_with_agent_browser", fake_execute_browser_steps_over_cdp)

    browser_session_id = await _create_browser_session(client, runner_id="runner-popup-incident")

    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-popup-incident",
            "inputs": [{"type": "text", "text": "Open Example now"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    assert turn_response.status_code == 200
    intent_id = turn_response.json()["intent_draft"]["intent_id"]

    resolve_response = await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-popup-incident",
            "intent_id": intent_id,
            "execution_mode": "immediate",
            "executor_mode": "local_runner",
            "browser_session_id": browser_session_id,
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )
    assert resolve_response.status_code == 200
    run_id = resolve_response.json()["run"]["run_id"]

    for _ in range(20):
        run_response = await client.get(f"/api/runs/{run_id}")
        if run_response.json()["run"]["state"] == "waiting_for_human":
            break
        await asyncio.sleep(0.01)

    run_body = run_response.json()
    assert run_body["run"]["state"] == "waiting_for_human"
    assert run_body["run"]["runtime_incident"]["category"] == "auth"
    assert run_body["run"]["runtime_incident"]["code"] == "POPUP_AUTH_FLOW"

    events_response = await client.get("/api/events", params={"session_id": "sess-popup-incident", "run_id": run_id})
    assert events_response.status_code == 200
    event_types = [item["type"] for item in events_response.json()["items"]]
    assert "run.page_opened" in event_types
    assert "run.runtime_incident" in event_types
    assert "run.waiting_for_human" in event_types


@pytest.mark.asyncio
async def test_immediate_execution_pauses_for_stuck_screen_incident(
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
                {"type": "browser", "id": "s1", "action": "click", "description": "Continue to the next page"},
            ]
        }

    async def fake_execute_browser_steps_over_cdp(cdp_url: str, steps: list[dict[str, object]], **kwargs):
        _ = (cdp_url, steps, kwargs)
        return ToolResult(
            success=False,
            data=[{"status": "error", "data": "Click timed out", "screenshot": "data:image/png;base64,shot", "page_ref": "page_primary"}],
            error="Click timed out",
            metadata={
                "last_screenshot": "data:image/png;base64,shot",
                "page_registry": {"page_primary": {"url": "https://example.com", "title": "Example"}},
                "active_page_ref": "page_primary",
            },
        )

    async def fake_check_if_stuck(screenshot_base64: str, threshold: float = 0.7):
        _ = (screenshot_base64, threshold)
        return _FakeStuckAnalysis(
            reason="A CAPTCHA challenge is blocking the workflow.",
            stuck_type="captcha",
            suggested_action="Take over and solve the challenge.",
        )

    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(executor_module, "_connect_browser_session", _fake_connect_browser_session)
    monkeypatch.setattr(executor_module, "_execute_browser_steps_with_agent_browser", fake_execute_browser_steps_over_cdp)
    monkeypatch.setattr(executor_module, "check_if_stuck", fake_check_if_stuck)

    browser_session_id = await _create_browser_session(client, runner_id="runner-stuck-incident")

    turn_response = await client.post(
        "/api/chat/turn",
        json={
            "session_id": "sess-stuck-incident",
            "inputs": [{"type": "text", "text": "Open Example now"}],
            "client_context": {"timezone": "Asia/Kolkata", "locale": "en-IN"},
        },
    )
    assert turn_response.status_code == 200
    intent_id = turn_response.json()["intent_draft"]["intent_id"]

    resolve_response = await client.post(
        "/api/chat/resolve-execution",
        json={
            "session_id": "sess-stuck-incident",
            "intent_id": intent_id,
            "execution_mode": "immediate",
            "executor_mode": "local_runner",
            "browser_session_id": browser_session_id,
            "schedule": {"run_at": [], "timezone": "Asia/Kolkata"},
        },
    )
    assert resolve_response.status_code == 200
    run_id = resolve_response.json()["run"]["run_id"]

    for _ in range(20):
        run_response = await client.get(f"/api/runs/{run_id}")
        if run_response.json()["run"]["state"] == "waiting_for_human":
            break
        await asyncio.sleep(0.01)

    run_body = run_response.json()
    assert run_body["run"]["state"] == "waiting_for_human"
    assert run_body["run"]["runtime_incident"]["code"] == "RUNTIME_AUTH_SCREEN"
    assert run_body["run"]["runtime_incident"]["category"] == "auth"
    assert any(artifact["step_id"] == "incident:runtime_auth_screen" for artifact in run_body["artifacts"])


@pytest.mark.asyncio
async def test_immediate_execution_reconciles_on_navigation_mismatch_incident(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import executor as executor_module
    from oi_agent.automation.executor import execute_run
    from oi_agent.automation.models import AutomationPlan, AutomationRun, AutomationStep
    from oi_agent.automation.store import get_run, save_plan, save_run
    from oi_agent.services.tools.base import ToolResult

    started_reconciliation: list[str] = []

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
                {"type": "browser", "id": "s1", "action": "click", "description": "Continue in the main tab"},
            ]
        }

    async def fake_execute_browser_steps_over_cdp(cdp_url: str, steps: list[dict[str, object]], **kwargs):
        _ = (cdp_url, steps, kwargs)
        return ToolResult(
            success=False,
            data=[{"status": "error", "data": "Focus moved to another page", "screenshot": "data:image/png;base64,shot", "page_ref": "page_popup"}],
            error="Focus moved to another page",
            metadata={
                "last_screenshot": "data:image/png;base64,shot",
                "page_registry": {
                    "page_primary": {"url": "https://example.com", "title": "Example"},
                    "page_popup": {"url": "https://example.com/help", "title": "Help"},
                },
                "active_page_ref": "page_popup",
            },
        )

    async def fake_check_if_stuck(screenshot_base64: str, threshold: float = 0.7):
        _ = (screenshot_base64, threshold)
        return None

    async def fake_run_node_json_command(*, args, stdin=None):
        _ = stdin
        command = args[-1]
        if command == "connect":
            return {"launched": True}
        if command == "title":
            return {"title": "Upload"}
        return {}

    async def fake_capture_agent_browser_snapshot(*, session_name, page_registry, active_page_ref):
        _ = (session_name, page_registry, active_page_ref)
        return (
            {
                "origin": "https://example.com/upload",
                "title": "Upload",
                "snapshot": '- button "Upload file" [ref=e11]',
                "refs": {"e11": {"role": "button", "name": "Upload file"}},
            },
            "snap-upload",
        )

    async def fake_apply_resume_reconciliation(run_id: str) -> None:
        started_reconciliation.append(run_id)

    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(executor_module, "_connect_browser_session", _fake_connect_browser_session)
    monkeypatch.setattr(executor_module, "_execute_browser_steps_with_agent_browser", fake_execute_browser_steps_over_cdp)
    monkeypatch.setattr(executor_module, "check_if_stuck", fake_check_if_stuck)
    monkeypatch.setattr(executor_module, "_apply_resume_reconciliation", fake_apply_resume_reconciliation)

    browser_session_id = await _create_browser_session(client, runner_id="runner-navigation-incident")
    plan = AutomationPlan(
        plan_id="plan-navigation-incident-1",
        intent_id="intent-navigation-incident-1",
        execution_mode="immediate",
        summary="Continue in the main tab",
        steps=[
            AutomationStep(step_id="s1", kind="click", label="Continue in the main tab", page_ref="page_primary", status="pending"),
        ],
    )
    await save_plan(plan.plan_id, plan.model_dump(mode="json"))
    run = AutomationRun(
        run_id="run-navigation-incident-1",
        plan_id=plan.plan_id,
        session_id="sess-navigation-incident",
        state="queued",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id=browser_session_id,
        current_step_index=0,
        total_steps=1,
        created_at="2026-03-08T10:00:00+00:00",
        updated_at="2026-03-08T10:00:00+00:00",
        page_registry={"page_primary": {"url": "https://example.com", "title": "Example"}},
        active_page_ref="page_primary",
    )
    await save_run(run.run_id, run.model_dump(mode="json"))

    await execute_run(run.run_id)

    raw_run = await get_run(run.run_id)
    assert raw_run is not None
    assert raw_run["state"] == "reconciling"
    assert raw_run["runtime_incident"]["code"] == "RUNTIME_NAVIGATION_MISMATCH"
    assert started_reconciliation == [run.run_id]


@pytest.mark.asyncio
async def test_immediate_execution_reconciles_on_no_progress_incident(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import executor as executor_module
    from oi_agent.automation.executor import execute_run
    from oi_agent.automation.models import AutomationPlan, AutomationRun, AutomationStep
    from oi_agent.automation.store import get_run, save_plan, save_run
    from oi_agent.services.tools.base import ToolResult

    started_reconciliation: list[str] = []

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
                {"type": "browser", "id": "s1", "action": "click", "description": "Try action one"},
                {"type": "browser", "id": "s2", "action": "click", "description": "Try action two"},
                {"type": "browser", "id": "s3", "action": "click", "description": "Try action three"},
            ]
        }

    async def fake_execute_browser_steps_over_cdp(cdp_url: str, steps: list[dict[str, object]], **kwargs):
        _ = (cdp_url, steps, kwargs)
        return ToolResult(
            success=True,
            data=[{"status": "done", "data": "ok", "screenshot": "data:image/png;base64,stuck-screen", "page_ref": "page_primary"}],
            text="Completed step",
            metadata={
                "last_screenshot": "data:image/png;base64,stuck-screen",
                "page_registry": {"page_primary": {"url": "https://example.com", "title": "Example"}},
                "active_page_ref": "page_primary",
            },
        )

    async def fake_apply_resume_reconciliation(run_id: str) -> None:
        started_reconciliation.append(run_id)

    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(executor_module, "_connect_browser_session", _fake_connect_browser_session)
    monkeypatch.setattr(executor_module, "_execute_browser_steps_with_agent_browser", fake_execute_browser_steps_over_cdp)
    monkeypatch.setattr(executor_module, "_apply_resume_reconciliation", fake_apply_resume_reconciliation)

    plan = AutomationPlan(
        plan_id="plan-no-progress-1",
        intent_id="intent-no-progress-1",
        execution_mode="immediate",
        summary="Try repeated actions",
        steps=[
            AutomationStep(step_id="s1", kind="click", label="Try action one", page_ref="page_primary", status="pending"),
            AutomationStep(step_id="s2", kind="click", label="Try action two", page_ref="page_primary", status="pending"),
            AutomationStep(step_id="s3", kind="click", label="Try action three", page_ref="page_primary", status="pending"),
        ],
    )
    await save_plan(plan.plan_id, plan.model_dump(mode="json"))
    run = AutomationRun(
        run_id="run-no-progress-1",
        plan_id=plan.plan_id,
        session_id="sess-no-progress",
        state="queued",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-no-progress-1",
        current_step_index=0,
        total_steps=3,
        created_at="2026-03-08T10:00:00+00:00",
        updated_at="2026-03-08T10:00:00+00:00",
        page_registry={"page_primary": {"url": "https://example.com", "title": "Example"}},
        active_page_ref="page_primary",
    )
    await save_run(run.run_id, run.model_dump(mode="json"))

    async def fake_browser_session_metadata(browser_session_id: str):
        _ = browser_session_id
        return {"metadata": {"cdp_url": "http://127.0.0.1:9222"}}

    monkeypatch.setattr(executor_module, "_browser_session_metadata", fake_browser_session_metadata)

    await execute_run(run.run_id)

    raw_run = await get_run(run.run_id)
    assert raw_run is not None
    assert raw_run["state"] == "reconciling"
    assert raw_run["runtime_incident"]["code"] == "RUNTIME_NO_PROGRESS"
    assert started_reconciliation == [run.run_id]


@pytest.mark.asyncio
async def test_immediate_execution_pauses_for_verification_widget_incident(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import executor as executor_module
    from oi_agent.automation.executor import execute_run
    from oi_agent.automation.models import AutomationPlan, AutomationRun, AutomationStep
    from oi_agent.automation.store import get_run, save_plan, save_run
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
                {"type": "browser", "id": "s1", "action": "click", "description": "Continue through the embedded challenge"},
            ]
        }

    async def fake_execute_browser_steps_over_cdp(cdp_url: str, steps: list[dict[str, object]], **kwargs):
        _ = (cdp_url, steps, kwargs)
        return ToolResult(
            success=False,
            data=[
                {
                    "status": "error",
                    "data": "Cross-origin iframe verification widget blocked interaction",
                    "screenshot": "data:image/png;base64,widget-shot",
                    "page_ref": "page_primary",
                }
            ],
            error="Cross-origin iframe verification widget blocked interaction",
            metadata={
                "last_screenshot": "data:image/png;base64,widget-shot",
                "page_registry": {"page_primary": {"url": "https://example.com", "title": "Example"}},
                "active_page_ref": "page_primary",
            },
        )

    async def fake_check_if_stuck(screenshot_base64: str, threshold: float = 0.7):
        _ = (screenshot_base64, threshold)
        return None

    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(executor_module, "_connect_browser_session", _fake_connect_browser_session)
    monkeypatch.setattr(executor_module, "_execute_browser_steps_with_agent_browser", fake_execute_browser_steps_over_cdp)
    monkeypatch.setattr(executor_module, "check_if_stuck", fake_check_if_stuck)

    plan = AutomationPlan(
        plan_id="plan-verification-widget-1",
        intent_id="intent-verification-widget-1",
        execution_mode="immediate",
        summary="Continue through the embedded challenge",
        steps=[
            AutomationStep(step_id="s1", kind="click", label="Continue through the embedded challenge", page_ref="page_primary", status="pending"),
        ],
    )
    await save_plan(plan.plan_id, plan.model_dump(mode="json"))
    run = AutomationRun(
        run_id="run-verification-widget-1",
        plan_id=plan.plan_id,
        session_id="sess-verification-widget",
        state="queued",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-session-verification-widget",
        current_step_index=0,
        total_steps=1,
        created_at="2026-03-08T10:00:00+00:00",
        updated_at="2026-03-08T10:00:00+00:00",
        page_registry={"page_primary": {"url": "https://example.com", "title": "Example"}},
        active_page_ref="page_primary",
    )
    await save_run(run.run_id, run.model_dump(mode="json"))
    monkeypatch.setattr(executor_module, "_browser_session_metadata", AsyncMock(return_value={"metadata": {"cdp_url": "http://127.0.0.1:9222"}}))

    await execute_run(run.run_id)

    raw_run = await get_run(run.run_id)
    assert raw_run is not None
    assert raw_run["state"] == "waiting_for_human"
    assert raw_run["runtime_incident"]["code"] == "RUNTIME_VERIFICATION_WIDGET"


@pytest.mark.asyncio
async def test_immediate_execution_reconciles_on_repeated_step_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import executor as executor_module
    from oi_agent.automation.executor import execute_run
    from oi_agent.automation.models import AutomationPlan, AutomationRun, AutomationStep
    from oi_agent.automation.store import get_run, save_plan, save_run
    from oi_agent.services.tools.base import ToolResult

    started_reconciliation: list[str] = []

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
                {"type": "browser", "id": "s1", "action": "click", "description": "Open the same menu again"},
            ]
        }

    async def fake_execute_browser_steps_over_cdp(cdp_url: str, steps: list[dict[str, object]], **kwargs):
        _ = (cdp_url, steps, kwargs)
        return ToolResult(
            success=False,
            data=[
                {
                    "status": "error",
                    "data": "Menu item was not clickable",
                    "screenshot": "data:image/png;base64,repeat-shot",
                    "page_ref": "page_primary",
                }
            ],
            error="Menu item was not clickable",
            metadata={
                "last_screenshot": "data:image/png;base64,repeat-shot",
                "page_registry": {"page_primary": {"url": "https://example.com", "title": "Example"}},
                "active_page_ref": "page_primary",
            },
        )

    async def fake_check_if_stuck(screenshot_base64: str, threshold: float = 0.7):
        _ = (screenshot_base64, threshold)
        return None

    async def fake_run_node_json_command(*, args, stdin=None):
        _ = stdin
        command = args[-1]
        if command == "connect":
            return {"launched": True}
        if command == "title":
            return {"title": "Report"}
        return {}

    async def fake_capture_agent_browser_snapshot(*, session_name, page_registry, active_page_ref):
        _ = (session_name, page_registry, active_page_ref)
        return (
            {
                "origin": "https://example.com/report",
                "title": "Report",
                "snapshot": '- button "Download report" [ref=e11]',
                "refs": {"e11": {"role": "button", "name": "Download report"}},
            },
            "snap-download",
        )

    async def fake_apply_resume_reconciliation(run_id: str) -> None:
        started_reconciliation.append(run_id)

    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(executor_module, "_connect_browser_session", _fake_connect_browser_session)
    monkeypatch.setattr(executor_module, "_execute_browser_steps_with_agent_browser", fake_execute_browser_steps_over_cdp)
    monkeypatch.setattr(executor_module, "check_if_stuck", fake_check_if_stuck)
    monkeypatch.setattr(executor_module, "_apply_resume_reconciliation", fake_apply_resume_reconciliation)
    monkeypatch.setattr(executor_module, "_run_node_json_command", fake_run_node_json_command)
    monkeypatch.setattr(executor_module, "_capture_agent_browser_snapshot", fake_capture_agent_browser_snapshot)
    monkeypatch.setattr(executor_module, "_browser_session_metadata", AsyncMock(return_value={"metadata": {"cdp_url": "http://127.0.0.1:9222"}}))

    plan = AutomationPlan(
        plan_id="plan-repeated-step-failure-1",
        intent_id="intent-repeated-step-failure-1",
        execution_mode="immediate",
        summary="Open the same menu again",
        steps=[
            AutomationStep(step_id="s1", kind="click", label="Open the same menu again", page_ref="page_primary", status="pending"),
        ],
    )
    await save_plan(plan.plan_id, plan.model_dump(mode="json"))
    run = AutomationRun(
        run_id="run-repeated-step-failure-1",
        plan_id=plan.plan_id,
        session_id="sess-repeated-step-failure",
        state="queued",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-session-repeated-step-failure",
        current_step_index=0,
        total_steps=1,
        created_at="2026-03-08T10:00:00+00:00",
        updated_at="2026-03-08T10:00:00+00:00",
        page_registry={"page_primary": {"url": "https://example.com", "title": "Example"}},
        active_page_ref="page_primary",
        progress_tracker={
            "last_failed_step_id": "s1",
            "last_failure_signature": hashlib.sha1("s1|click|menu item was not clickable".encode("utf-8")).hexdigest()[:16],
            "repeated_failed_step_count": 0,
        },
    )
    await save_run(run.run_id, run.model_dump(mode="json"))

    await execute_run(run.run_id)

    raw_run = await get_run(run.run_id)
    assert raw_run is not None
    assert raw_run["state"] == "reconciling"
    assert raw_run["runtime_incident"]["code"] == "RUNTIME_REPEATED_STEP_FAILURE"
    assert started_reconciliation == [run.run_id]


@pytest.mark.asyncio
async def test_immediate_execution_fails_when_planner_returns_no_browser_steps(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import executor as executor_module
    from oi_agent.automation.executor import execute_run
    from oi_agent.automation.models import AutomationPlan, AutomationRun
    from oi_agent.automation.store import get_run, list_events, save_plan, save_run

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
            "steps": [{"type": "consult", "reason": "planner_output_invalid", "description": "Need clarification"}],
            "status": "NEEDS_INPUT",
            "summary": "Planner could not produce deterministic browser steps.",
            "next_action": "await_user_input",
        }

    async def fake_run_node_json_command(*, args, stdin=None):
        _ = stdin
        command = args[-1]
        if command == "connect":
            return {"launched": True}
        if command == "title":
            return {"title": "WhatsApp"}
        return {}

    async def fake_capture_agent_browser_snapshot(*, session_name, page_registry, active_page_ref):
        _ = (session_name, page_registry, active_page_ref)
        return (
            {
                "origin": "https://web.whatsapp.com/",
                "title": "WhatsApp",
                "snapshot": '- textbox "Search or start a new chat" [ref=e11]',
                "refs": {"e11": {"role": "textbox", "name": "Search or start a new chat"}},
            },
            "snap-123",
        )

    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(executor_module, "_browser_session_metadata", AsyncMock(return_value={"metadata": {"cdp_url": "http://127.0.0.1:9222"}}))
    monkeypatch.setattr(executor_module, "_connect_browser_session", _fake_connect_browser_session)
    monkeypatch.setattr(executor_module, "_run_node_json_command", fake_run_node_json_command)
    monkeypatch.setattr(executor_module, "_capture_agent_browser_snapshot", fake_capture_agent_browser_snapshot)

    plan = AutomationPlan(
        plan_id="plan-empty-browser-steps-1",
        intent_id="intent-empty-browser-steps-1",
        execution_mode="immediate",
        summary="Message dippa on WhatsApp",
        steps=[],
    )
    await save_plan(plan.plan_id, plan.model_dump(mode="json"))
    run = AutomationRun(
        run_id="run-empty-browser-steps-1",
        plan_id=plan.plan_id,
        session_id="sess-empty-browser-steps",
        state="queued",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-empty-browser-steps-1",
        current_step_index=0,
        total_steps=0,
        created_at="2026-03-08T10:00:00+00:00",
        updated_at="2026-03-08T10:00:00+00:00",
    )
    await save_run(run.run_id, run.model_dump(mode="json"))

    await execute_run(run.run_id)

    raw_run = await get_run(run.run_id)
    assert raw_run is not None
    assert raw_run["state"] == "awaiting_clarification"
    assert raw_run["last_error"]["code"] == "MODEL_UNCERTAIN"

    event_types = [event["type"] for event in await list_events(run_id=run.run_id)]
    assert "run.failed" in event_types
    assert "run.completed" not in event_types


@pytest.mark.asyncio
async def test_immediate_execution_reconciles_for_file_upload_incident(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import executor as executor_module
    from oi_agent.automation.executor import execute_run
    from oi_agent.automation.models import AutomationPlan, AutomationRun, AutomationStep
    from oi_agent.automation.store import get_run, save_plan, save_run
    from oi_agent.services.tools.base import ToolResult

    started_reconciliation: list[str] = []

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
        return {"steps": [{"type": "browser", "id": "s1", "command": "click", "description": "Upload the selected file"}]}

    async def fake_execute_browser_steps_over_cdp(cdp_url: str, steps: list[dict[str, object]], **kwargs):
        _ = (cdp_url, steps, kwargs)
        return ToolResult(
            success=False,
            data=[
                {
                    "status": "error",
                    "data": "File chooser opened and no file selected for input type=file",
                    "screenshot": "data:image/png;base64,upload-shot",
                    "page_ref": "page_primary",
                }
            ],
            error="File chooser opened and no file selected for input type=file",
            metadata={
                "last_screenshot": "data:image/png;base64,upload-shot",
                "page_registry": {"page_primary": {"url": "https://example.com/upload", "title": "Upload"}},
                "active_page_ref": "page_primary",
            },
        )

    async def fake_check_if_stuck(screenshot_base64: str, threshold: float = 0.7):
        _ = (screenshot_base64, threshold)
        return None

    async def fake_run_node_json_command(*, args, stdin=None):
        _ = stdin
        command = args[-1]
        if command == "connect":
            return {"launched": True}
        if command == "title":
            return {"title": "Upload"}
        return {}

    async def fake_capture_agent_browser_snapshot(*, session_name, page_registry, active_page_ref):
        _ = (session_name, page_registry, active_page_ref)
        return (
            {
                "origin": "https://example.com/upload",
                "title": "Upload",
                "snapshot": '- button "Upload file" [ref=e11]',
                "refs": {"e11": {"role": "button", "name": "Upload file"}},
            },
            "snap-upload",
        )

    async def fake_apply_resume_reconciliation(run_id: str) -> None:
        started_reconciliation.append(run_id)

    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(executor_module, "_connect_browser_session", _fake_connect_browser_session)
    monkeypatch.setattr(executor_module, "_execute_browser_steps_with_agent_browser", fake_execute_browser_steps_over_cdp)
    monkeypatch.setattr(executor_module, "check_if_stuck", fake_check_if_stuck)
    monkeypatch.setattr(executor_module, "_apply_resume_reconciliation", fake_apply_resume_reconciliation)
    monkeypatch.setattr(executor_module, "_run_node_json_command", fake_run_node_json_command)
    monkeypatch.setattr(executor_module, "_capture_agent_browser_snapshot", fake_capture_agent_browser_snapshot)
    monkeypatch.setattr(executor_module, "_browser_session_metadata", AsyncMock(return_value={"metadata": {"cdp_url": "http://127.0.0.1:9222"}}))

    plan = AutomationPlan(
        plan_id="plan-file-upload-incident-1",
        intent_id="intent-file-upload-incident-1",
        execution_mode="immediate",
        summary="Upload the selected file",
        steps=[AutomationStep(step_id="s1", kind="click", label="Upload the selected file", page_ref="page_primary", status="pending")],
    )
    await save_plan(plan.plan_id, plan.model_dump(mode="json"))
    run = AutomationRun(
        run_id="run-file-upload-incident-1",
        plan_id=plan.plan_id,
        session_id="sess-file-upload-incident",
        state="queued",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-session-file-upload-incident",
        current_step_index=0,
        total_steps=1,
        created_at="2026-03-08T10:00:00+00:00",
        updated_at="2026-03-08T10:00:00+00:00",
        page_registry={"page_primary": {"url": "https://example.com/upload", "title": "Upload"}},
        active_page_ref="page_primary",
    )
    await save_run(run.run_id, run.model_dump(mode="json"))

    await execute_run(run.run_id)

    raw_run = await get_run(run.run_id)
    assert raw_run is not None
    assert raw_run["state"] == "reconciling"
    assert raw_run["runtime_incident"]["code"] == "RUNTIME_FILE_UPLOAD_REQUIRED"
    assert started_reconciliation == [run.run_id]


@pytest.mark.asyncio
async def test_immediate_execution_reconciles_on_download_prompt_incident(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import executor as executor_module
    from oi_agent.automation.executor import execute_run
    from oi_agent.automation.models import AutomationPlan, AutomationRun, AutomationStep
    from oi_agent.automation.store import get_run, save_plan, save_run
    from oi_agent.services.tools.base import ToolResult

    started_reconciliation: list[str] = []

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
        return {"steps": [{"type": "browser", "id": "s1", "command": "click", "description": "Download the report"}]}

    async def fake_execute_browser_steps_over_cdp(cdp_url: str, steps: list[dict[str, object]], **kwargs):
        _ = (cdp_url, steps, kwargs)
        return ToolResult(
            success=False,
            data=[
                {
                    "status": "error",
                    "data": "Download prompt blocked the browser and needs permission to download multiple files",
                    "screenshot": "data:image/png;base64,download-shot",
                    "page_ref": "page_primary",
                }
            ],
            error="Download prompt blocked the browser and needs permission to download multiple files",
            metadata={
                "last_screenshot": "data:image/png;base64,download-shot",
                "page_registry": {"page_primary": {"url": "https://example.com/report", "title": "Report"}},
                "active_page_ref": "page_primary",
            },
        )

    async def fake_check_if_stuck(screenshot_base64: str, threshold: float = 0.7):
        _ = (screenshot_base64, threshold)
        return None

    async def fake_run_node_json_command(*, args, stdin=None):
        _ = stdin
        command = args[-1]
        if command == "connect":
            return {"launched": True}
        if command == "title":
            return {"title": "Widget"}
        return {}

    async def fake_capture_agent_browser_snapshot(*, session_name, page_registry, active_page_ref):
        _ = (session_name, page_registry, active_page_ref)
        return (
            {
                "origin": "https://example.com/widget",
                "title": "Widget",
                "snapshot": '- button "Open widget" [ref=e11]',
                "refs": {"e11": {"role": "button", "name": "Open widget"}},
            },
            "snap-widget",
        )

    async def fake_apply_resume_reconciliation(run_id: str) -> None:
        started_reconciliation.append(run_id)

    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(executor_module, "_connect_browser_session", _fake_connect_browser_session)
    monkeypatch.setattr(executor_module, "_execute_browser_steps_with_agent_browser", fake_execute_browser_steps_over_cdp)
    monkeypatch.setattr(executor_module, "check_if_stuck", fake_check_if_stuck)
    monkeypatch.setattr(executor_module, "_apply_resume_reconciliation", fake_apply_resume_reconciliation)
    monkeypatch.setattr(executor_module, "_run_node_json_command", fake_run_node_json_command)
    monkeypatch.setattr(executor_module, "_capture_agent_browser_snapshot", fake_capture_agent_browser_snapshot)
    monkeypatch.setattr(executor_module, "_browser_session_metadata", AsyncMock(return_value={"metadata": {"cdp_url": "http://127.0.0.1:9222"}}))

    plan = AutomationPlan(
        plan_id="plan-download-prompt-incident-1",
        intent_id="intent-download-prompt-incident-1",
        execution_mode="immediate",
        summary="Download the report",
        steps=[AutomationStep(step_id="s1", kind="click", label="Download the report", page_ref="page_primary", status="pending")],
    )
    await save_plan(plan.plan_id, plan.model_dump(mode="json"))
    run = AutomationRun(
        run_id="run-download-prompt-incident-1",
        plan_id=plan.plan_id,
        session_id="sess-download-prompt-incident",
        state="queued",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-session-download-prompt-incident",
        current_step_index=0,
        total_steps=1,
        created_at="2026-03-08T10:00:00+00:00",
        updated_at="2026-03-08T10:00:00+00:00",
        page_registry={"page_primary": {"url": "https://example.com/report", "title": "Report"}},
        active_page_ref="page_primary",
    )
    await save_run(run.run_id, run.model_dump(mode="json"))

    await execute_run(run.run_id)

    raw_run = await get_run(run.run_id)
    assert raw_run is not None
    assert raw_run["state"] == "reconciling"
    assert raw_run["runtime_incident"]["code"] == "RUNTIME_DOWNLOAD_PROMPT"
    assert started_reconciliation == [run.run_id]


@pytest.mark.asyncio
async def test_immediate_execution_reconciles_on_unsupported_widget_incident(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation import executor as executor_module
    from oi_agent.automation.executor import execute_run
    from oi_agent.automation.models import AutomationPlan, AutomationRun, AutomationStep
    from oi_agent.automation.store import get_run, save_plan, save_run
    from oi_agent.services.tools.base import ToolResult

    started_reconciliation: list[str] = []

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
        return {"steps": [{"type": "browser", "id": "s1", "command": "click", "description": "Open the custom widget"}]}

    async def fake_execute_browser_steps_over_cdp(cdp_url: str, steps: list[dict[str, object]], **kwargs):
        _ = (cdp_url, steps, kwargs)
        return ToolResult(
            success=False,
            data=[
                {
                    "status": "error",
                    "data": "Custom widget blocked interaction because the element is inside closed shadow root",
                    "screenshot": "data:image/png;base64,widget-shadow-shot",
                    "page_ref": "page_primary",
                }
            ],
            error="Custom widget blocked interaction because the element is inside closed shadow root",
            metadata={
                "last_screenshot": "data:image/png;base64,widget-shadow-shot",
                "page_registry": {"page_primary": {"url": "https://example.com/widget", "title": "Widget"}},
                "active_page_ref": "page_primary",
            },
        )

    async def fake_check_if_stuck(screenshot_base64: str, threshold: float = 0.7):
        _ = (screenshot_base64, threshold)
        return None

    async def fake_run_node_json_command(*, args, stdin=None):
        _ = stdin
        command = args[-1]
        if command == "connect":
            return {"launched": True}
        if command == "title":
            return {"title": "Widget"}
        return {}

    async def fake_capture_agent_browser_snapshot(*, session_name, page_registry, active_page_ref):
        _ = (session_name, page_registry, active_page_ref)
        return (
            {
                "origin": "https://example.com/widget",
                "title": "Widget",
                "snapshot": '- button "Open widget" [ref=e11]',
                "refs": {"e11": {"role": "button", "name": "Open widget"}},
            },
            "snap-widget",
        )

    async def fake_apply_resume_reconciliation(run_id: str) -> None:
        started_reconciliation.append(run_id)

    monkeypatch.setattr(executor_module, "rewrite_user_prompt", fake_rewrite_user_prompt)
    monkeypatch.setattr(executor_module, "plan_browser_steps", fake_plan_browser_steps)
    monkeypatch.setattr(executor_module, "_connect_browser_session", _fake_connect_browser_session)
    monkeypatch.setattr(executor_module, "_execute_browser_steps_with_agent_browser", fake_execute_browser_steps_over_cdp)
    monkeypatch.setattr(executor_module, "check_if_stuck", fake_check_if_stuck)
    monkeypatch.setattr(executor_module, "_apply_resume_reconciliation", fake_apply_resume_reconciliation)
    monkeypatch.setattr(executor_module, "_run_node_json_command", fake_run_node_json_command)
    monkeypatch.setattr(executor_module, "_capture_agent_browser_snapshot", fake_capture_agent_browser_snapshot)
    monkeypatch.setattr(executor_module, "_browser_session_metadata", AsyncMock(return_value={"metadata": {"cdp_url": "http://127.0.0.1:9222"}}))

    plan = AutomationPlan(
        plan_id="plan-unsupported-widget-incident-1",
        intent_id="intent-unsupported-widget-incident-1",
        execution_mode="immediate",
        summary="Open the custom widget",
        steps=[AutomationStep(step_id="s1", kind="click", label="Open the custom widget", page_ref="page_primary", status="pending")],
    )
    await save_plan(plan.plan_id, plan.model_dump(mode="json"))
    run = AutomationRun(
        run_id="run-unsupported-widget-incident-1",
        plan_id=plan.plan_id,
        session_id="sess-unsupported-widget-incident",
        state="queued",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-session-unsupported-widget-incident",
        current_step_index=0,
        total_steps=1,
        created_at="2026-03-08T10:00:00+00:00",
        updated_at="2026-03-08T10:00:00+00:00",
        page_registry={"page_primary": {"url": "https://example.com/widget", "title": "Widget"}},
        active_page_ref="page_primary",
    )
    await save_run(run.run_id, run.model_dump(mode="json"))

    await execute_run(run.run_id)

    raw_run = await get_run(run.run_id)
    assert raw_run is not None
    assert raw_run["state"] == "reconciling"
    assert raw_run["runtime_incident"]["code"] == "RUNTIME_UNSUPPORTED_WIDGET"
    assert started_reconciliation == [run.run_id]


@pytest.mark.asyncio
async def test_notification_fanout_for_waiting_for_human_uses_session_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation.notification_fanout import fanout_automation_notification

    broadcast = AsyncMock()
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout._broadcaster.broadcast_user_notification",
        broadcast,
    )
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout.get_run",
        AsyncMock(return_value={"run_id": "run-1", "browser_session_id": "session-1"}),
    )
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout.get_browser_session",
        AsyncMock(return_value={"session_id": "session-1", "user_id": "user-1"}),
    )

    await fanout_automation_notification(
        {
            "type": "run.waiting_for_human",
            "run_id": "run-1",
            "payload": {"reason": "Approval required", "reason_code": "SENSITIVE_ACTION"},
        }
    )

    broadcast.assert_awaited_once()
    kwargs = broadcast.await_args.kwargs
    assert kwargs["user_id"] == "user-1"
    assert kwargs["high_priority"] is True
    assert kwargs["suppress_push_if_connected"] is False
    assert kwargs["data"]["route"] == "/sessions?session_id=session-1&run_id=run-1"


@pytest.mark.asyncio
async def test_notification_fanout_skips_human_runtime_incident_duplicates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation.notification_fanout import fanout_automation_notification

    broadcast = AsyncMock()
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout._broadcaster.broadcast_user_notification",
        broadcast,
    )
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout.get_run",
        AsyncMock(return_value={"run_id": "run-1", "browser_session_id": "session-1"}),
    )
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout.get_browser_session",
        AsyncMock(return_value={"session_id": "session-1", "user_id": "user-1"}),
    )

    await fanout_automation_notification(
        {
            "type": "run.runtime_incident",
            "run_id": "run-1",
            "payload": {"incident": {"code": "RUNTIME_VERIFICATION_WIDGET", "summary": "Blocked", "requires_human": True}},
        }
    )

    broadcast.assert_not_awaited()


@pytest.mark.asyncio
async def test_notification_fanout_for_reconciliation_uses_chat_fallback_without_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation.notification_fanout import fanout_automation_notification

    broadcast = AsyncMock()
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout._broadcaster.broadcast_user_notification",
        broadcast,
    )
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout.get_run",
        AsyncMock(return_value={"run_id": "run-1", "browser_session_id": "session-1"}),
    )
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout.get_browser_session",
        AsyncMock(return_value={"session_id": "session-1", "user_id": "user-1"}),
    )

    await fanout_automation_notification(
        {
            "type": "run.reconciliation_requested",
            "run_id": "run-1",
            "payload": {"reason": "Page changed", "reason_code": "RUNTIME_NO_PROGRESS"},
        }
    )

    broadcast.assert_awaited_once()
    kwargs = broadcast.await_args.kwargs
    assert kwargs["title"] == "Automation is replanning"
    assert kwargs["suppress_push_if_connected"] is True
    assert kwargs["data"]["route"] == "/sessions?session_id=session-1&run_id=run-1"


@pytest.mark.asyncio
async def test_notification_fanout_for_runtime_incident_suppresses_push_when_connected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation.notification_fanout import fanout_automation_notification

    broadcast = AsyncMock()
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout._broadcaster.broadcast_user_notification",
        broadcast,
    )
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout.get_run",
        AsyncMock(return_value={"run_id": "run-2", "browser_session_id": "session-2"}),
    )
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout.get_browser_session",
        AsyncMock(return_value={"session_id": "session-2", "user_id": "user-2"}),
    )

    await fanout_automation_notification(
        {
            "type": "run.runtime_incident",
            "run_id": "run-2",
            "payload": {
                "incident": {
                    "code": "RUNTIME_NO_PROGRESS",
                    "summary": "No visible progress detected.",
                    "requires_human": False,
                }
            },
        }
    )

    broadcast.assert_awaited_once()
    kwargs = broadcast.await_args.kwargs
    assert kwargs["title"] == "RUNTIME NO PROGRESS"
    assert kwargs["suppress_push_if_connected"] is True


@pytest.mark.asyncio
async def test_notification_fanout_respects_none_urgency_preference(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation.notification_fanout import fanout_automation_notification

    broadcast = AsyncMock()
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout._broadcaster.broadcast_user_notification",
        broadcast,
    )
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout.get_run",
        AsyncMock(return_value={"run_id": "run-3", "browser_session_id": "session-3"}),
    )
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout.get_browser_session",
        AsyncMock(return_value={"session_id": "session-3", "user_id": "user-3"}),
    )
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout.get_user_notification_preferences",
        AsyncMock(
            return_value=type(
                "Prefs",
                (),
                {
                    "desktop_enabled": True,
                    "browser_enabled": True,
                    "mobile_push_enabled": True,
                    "connected_device_only_for_noncritical": True,
                    "urgency_mode": "none",
                },
            )()
        ),
    )

    await fanout_automation_notification(
        {
            "type": "run.waiting_for_human",
            "run_id": "run-3",
            "payload": {"reason": "Approval required", "reason_code": "SENSITIVE_ACTION"},
        }
    )

    broadcast.assert_not_awaited()


@pytest.mark.asyncio
async def test_notification_fanout_respects_channel_preferences(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from oi_agent.automation.notification_fanout import fanout_automation_notification

    broadcast = AsyncMock()
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout._broadcaster.broadcast_user_notification",
        broadcast,
    )
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout.get_run",
        AsyncMock(return_value={"run_id": "run-4", "browser_session_id": "session-4"}),
    )
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout.get_browser_session",
        AsyncMock(return_value={"session_id": "session-4", "user_id": "user-4"}),
    )
    monkeypatch.setattr(
        "oi_agent.automation.notification_fanout.get_user_notification_preferences",
        AsyncMock(
            return_value=type(
                "Prefs",
                (),
                {
                    "desktop_enabled": False,
                    "browser_enabled": True,
                    "mobile_push_enabled": False,
                    "connected_device_only_for_noncritical": True,
                    "urgency_mode": "all",
                },
            )()
        ),
    )

    await fanout_automation_notification(
        {
            "type": "run.reconciliation_requested",
            "run_id": "run-4",
            "payload": {"reason": "Page changed", "reason_code": "RUNTIME_NAVIGATION_MISMATCH"},
        }
    )

    broadcast.assert_awaited_once()
    kwargs = broadcast.await_args.kwargs
    assert kwargs["desktop_enabled"] is False
    assert kwargs["browser_enabled"] is True
    assert kwargs["mobile_push_enabled"] is False


@pytest.mark.asyncio
async def test_list_devices_marks_stale_desktop_device_offline(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stale_seen = (datetime.now(UTC) - timedelta(minutes=10)).isoformat()

    async def fake_get_user_devices(self, user_id: str):
        _ = user_id
        return [
            {
                "device_id": "desktop-1",
                "device_type": "desktop",
                "device_name": "Office Desktop",
                "is_online": True,
                "last_seen": stale_seen,
            }
        ]

    monkeypatch.setattr("oi_agent.mesh.device_registry.DeviceRegistry.get_user_devices", fake_get_user_devices)
    monkeypatch.setattr("oi_agent.api.websocket.connection_manager.get_connected_device_ids_for_user", lambda user_id: [])

    response = await client.get("/devices")

    assert response.status_code == 200
    body = response.json()
    assert body[0]["device_id"] == "desktop-1"
    assert body[0]["connected"] is False
    assert body[0]["is_online"] is False


@pytest.mark.asyncio
async def test_list_devices_marks_connected_desktop_device_online_even_if_stale(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stale_seen = (datetime.now(UTC) - timedelta(minutes=10)).isoformat()

    async def fake_get_user_devices(self, user_id: str):
        _ = user_id
        return [
            {
                "device_id": "desktop-2",
                "device_type": "desktop",
                "device_name": "Home Desktop",
                "is_online": True,
                "last_seen": stale_seen,
            }
        ]

    monkeypatch.setattr("oi_agent.mesh.device_registry.DeviceRegistry.get_user_devices", fake_get_user_devices)
    monkeypatch.setattr(
        "oi_agent.api.websocket.connection_manager.get_connected_device_ids_for_user",
        lambda user_id: ["desktop-2"],
    )

    response = await client.get("/devices")

    assert response.status_code == 200
    body = response.json()
    assert body[0]["device_id"] == "desktop-2"
    assert body[0]["connected"] is True
    assert body[0]["is_online"] is True


@pytest.mark.asyncio
async def test_resume_preserves_trigger_incident_for_reconciliation(
    client: AsyncClient,
) -> None:
    from oi_agent.automation.models import AutomationPlan, AutomationRun, AutomationStep
    from oi_agent.automation.store import save_plan, save_run

    plan = AutomationPlan(
        plan_id="plan-resume-incident-1",
        intent_id="intent-resume-incident-1",
        execution_mode="immediate",
        summary="Continue after popup auth flow",
        steps=[
            AutomationStep(step_id="s1", kind="navigate", label="Open app", page_ref="page_primary", status="completed"),
            AutomationStep(step_id="s2", kind="click", label="Continue", page_ref="page_primary", status="pending"),
        ],
    )
    await save_plan(plan.plan_id, plan.model_dump(mode="json"))
    run = AutomationRun(
        run_id="run-resume-incident-1",
        plan_id=plan.plan_id,
        session_id="sess-resume-incident",
        state="waiting_for_human",
        execution_mode="immediate",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id="browser-resume-incident-1",
        current_step_index=1,
        total_steps=2,
        created_at="2026-03-08T10:00:00+00:00",
        updated_at="2026-03-08T10:00:00+00:00",
        runtime_incident={
            "incident_id": "incident-popup-auth-1",
            "category": "auth",
            "severity": "critical",
            "code": "POPUP_AUTH_FLOW",
            "summary": "The automation opened an authentication page in a new tab.",
            "details": "Sign in popup opened.",
            "visible_signals": ["login", "sign in"],
            "requires_human": True,
            "replannable": True,
            "user_visible": True,
            "browser_snapshot": {
                "captured_at": "2026-03-08T10:00:00+00:00",
                "url": "https://auth.example.com/login",
                "title": "Sign in",
                "page_id": "page_login",
                "metadata": {"page_ref": "page_login"},
            },
            "created_at": "2026-03-08T10:00:00+00:00",
        },
        page_registry={
            "page_primary": {"url": "https://example.com", "title": "Example"},
            "page_login": {"url": "https://auth.example.com/login", "title": "Sign in"},
        },
        active_page_ref="page_login",
    )
    await save_run(run.run_id, run.model_dump(mode="json"))

    response = await client.post(f"/api/runs/{run.run_id}/resume")

    assert response.status_code == 200
    body = response.json()
    assert body["run"]["state"] == "reconciling"
    assert body["run"]["resume_context"]["trigger_incident"]["code"] == "POPUP_AUTH_FLOW"
    assert body["run"]["resume_context"]["trigger_incident"]["browser_snapshot"]["metadata"]["page_ref"] == "page_login"


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
