from types import SimpleNamespace

import pytest

from oi_agent.automation.conversation_response import build_chat_session_state
from oi_agent.automation.models import SessionReadinessSummary


@pytest.mark.asyncio
async def test_build_chat_session_state_uses_next_run_at_when_run_times_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    schedule = SimpleNamespace(
        schedule_id="schedule-1",
        session_id="session-1",
        execution_mode="once",
        executor_mode="local_runner",
        automation_engine="agent_browser",
        browser_session_id=None,
        prompt="Send an email at 12:30 PM today.",
        run_at=[],
        next_run_at="2026-03-13T12:30:00+05:30",
        timezone="Asia/Calcutta",
        created_at="2026-03-13T11:58:17+05:30",
    )

    async def fake_list_session_turns(user_id: str, session_id: str, limit: int = 100):
        return []

    async def fake_list_runs_for_session(user_id: str, session_id: str, limit: int = 10):
        return []

    async def fake_list_automation_schedules(*, user_id: str, limit: int = 50):
        return [schedule]

    async def fake_build_session_readiness(*, user_id: str, active_run):
        return SessionReadinessSummary(
            status="local_ready",
            label="Local ready",
            detail="A local runner is connected.",
            local_ready=True,
            server_ready=False,
            browser_attached=False,
            waiting_for_login=False,
            human_takeover=False,
            runtime_ready=True,
            runner_connected=True,
        )

    monkeypatch.setattr("oi_agent.automation.conversation_response.list_session_turns", fake_list_session_turns)
    monkeypatch.setattr("oi_agent.automation.conversation_response.list_runs_for_session", fake_list_runs_for_session)
    monkeypatch.setattr("oi_agent.automation.conversation_response.list_automation_schedules", fake_list_automation_schedules)
    monkeypatch.setattr("oi_agent.automation.conversation_response.build_session_readiness", fake_build_session_readiness)

    response = await build_chat_session_state("user-1", "session-1", None)

    assert len(response.schedules) == 1
    assert response.schedules[0]["run_times"] == ["2026-03-13T12:30:00+05:30"]

