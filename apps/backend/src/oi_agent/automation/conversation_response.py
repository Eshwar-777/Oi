from __future__ import annotations

from typing import Any

from oi_agent.automation.conversation_task import ConversationTask
from oi_agent.automation.models import (
    AssistantMessage,
    AutomationRun,
    ChatSessionStateResponse,
    ChatTurnResponse,
    ConversationSummary,
    ConversationStateResponse,
    InputPart,
    IntentDraft,
    RunResponse,
    SessionReadinessSummary,
    TaskInterpretation,
)
from oi_agent.automation.runtime_client import fetch_runtime_readiness
from oi_agent.automation.run_service import get_run_response
from oi_agent.automation.schedule_service import list_automation_schedules
from oi_agent.automation.sessions.manager import browser_session_manager
from oi_agent.automation.store import list_runs_for_session, list_session_turns

_ACTIVE_RUN_STATES = {
    "draft",
    "awaiting_clarification",
    "awaiting_execution_mode",
    "awaiting_confirmation",
    "scheduled",
    "queued",
    "starting",
    "running",
    "paused",
    "waiting_for_user_action",
    "waiting_for_human",
    "human_controlling",
    "reconciling",
    "resuming",
    "retrying",
}


def _legacy_decision(task: ConversationTask) -> str:
    if task.goal_type == "general_chat":
        return "GENERAL_CHAT"
    if task.phase == "awaiting_confirmation":
        return "REQUIRES_CONFIRMATION"
    if task.execution.missing_fields:
        return "ASK_CLARIFICATION"
    if task.phase == "awaiting_timing" or task.timing.mode == "unknown":
        return "ASK_EXECUTION_MODE"
    if task.phase == "scheduled":
        return "READY_TO_SCHEDULE"
    if task.phase in {"ready_to_execute", "executing", "completed"}:
        return "READY_TO_EXECUTE"
    return "GENERAL_CHAT"


def _legacy_timing_mode(task: ConversationTask) -> str:
    if task.timing.mode == "immediate":
        return "immediate"
    if task.timing.mode == "once":
        return "once"
    if task.timing.mode == "recurring":
        if task.timing.recurrence.get("type") == "multi_time":
            return "multi_time"
        return "interval"
    return "unknown"


def _legacy_execution_intent(task: ConversationTask) -> str:
    if task.timing.mode == "immediate":
        return "immediate"
    if task.timing.mode == "once":
        return "once"
    if task.timing.mode == "recurring":
        return "recurring"
    return "unspecified"


def task_to_intent_draft(task: ConversationTask) -> IntentDraft:
    raw_user_text = str(task.timing.raw_user_text or "").strip()
    return IntentDraft(
        intent_id=task.legacy_intent_id,
        session_id=task.session_id,
        user_goal=task.user_goal,
        goal_type=task.goal_type,
        workflow_outline=list(task.execution.workflow_outline),
        interpretation=TaskInterpretation(
            task_kind="browser_automation" if task.goal_type == "ui_automation" else "general_chat",
            execution_intent=_legacy_execution_intent(task),
            workflow_outline=list(task.execution.workflow_outline),
            clarification_hints=[],
            confidence=0.0,
        ),
        normalized_inputs=[InputPart(type="text", text=raw_user_text)] if raw_user_text else [],
        entities=dict(task.slots),
        missing_fields=list(task.execution.missing_fields),
        timing_mode=_legacy_timing_mode(task), 
        timing_candidates=[],
        can_automate=task.goal_type == "ui_automation",
        confidence=0.0,
        model_id=task.model_id,
        decision=_legacy_decision(task),
        requires_confirmation=task.confirmation.required,
        risk_flags=list(task.execution.risk_flags),
        clarification_question=task.execution.clarification_question,
        execution_mode_question=task.last_assistant_message if task.phase == "awaiting_timing" else None,
        confirmation_message=task.last_assistant_message if task.phase == "awaiting_confirmation" else None,
        assistant_prompt=task.last_assistant_message,
        pending_action=task.execution.active_run_action_needed,
    )


def task_to_conversation_state(task: ConversationTask) -> ConversationStateResponse:
    return ConversationStateResponse(
        conversation_id=task.conversation_id,
        task_id=task.task_id,
        phase=task.phase,
        status=task.status,
        user_goal=task.user_goal,
        resolved_goal=task.resolved_goal,
        missing_fields=list(task.execution.missing_fields),
        timing=task.timing.model_dump(mode="json"),
        confirmation=task.confirmation.model_dump(mode="json"),
        active_run_action_needed=task.execution.active_run_action_needed,
    )


def conversation_summary_from_sources(
    *,
    task: ConversationTask,
    turns: list[dict[str, Any]],
    active_run: AutomationRun | None,
) -> ConversationSummary:
    title = (task.user_goal or "New conversation").strip() or "New conversation"
    last_user_text = next(
        (str(turn.get("text", "") or "") for turn in reversed(turns) if turn.get("role") == "user"),
        None,
    )
    summary = str(task.resolved_goal or task.user_goal or "").strip()
    badges: list[str] = []
    if active_run and active_run.state in {"running", "starting", "resuming", "retrying"}:
        badges.append("Running")
    elif active_run and active_run.state in {"waiting_for_user_action", "waiting_for_human", "paused"}:
        badges.append("Needs attention")
    elif task.phase == "scheduled":
        badges.append("Scheduled")
    if active_run and active_run.runtime_incident:
        badges.append("Incident")
    return ConversationSummary(
        conversation_id=task.conversation_id,
        session_id=task.session_id,
        title=title[:80],
        summary=summary[:160],
        created_at=task.created_at,
        updated_at=task.updated_at,
        selected_model=task.model_id or "auto",
        last_assistant_text=task.last_assistant_message,
        last_user_text=last_user_text,
        last_run_state=active_run.state if active_run else None,
        has_unread_updates=bool(active_run and active_run.state in _ACTIVE_RUN_STATES),
        has_errors=bool(active_run and (active_run.last_error or active_run.runtime_incident)),
        badges=badges,
    )


async def build_session_readiness(
    *,
    user_id: str,
    active_run: AutomationRun | None,
) -> SessionReadinessSummary:
    runtime_ready = False
    runtime_detail = ""
    try:
        runtime = await fetch_runtime_readiness()
        runtime_ready = bool(runtime.get("ready", False))
        runtime_detail = str(runtime.get("detail", "") or "")
    except Exception:
        runtime_detail = "Runtime not reachable."

    sessions = await browser_session_manager.list_sessions(user_id=user_id)
    local_ready = any(session.origin == "local_runner" and session.status == "ready" for session in sessions)
    server_ready = any(session.origin == "server_runner" and session.status == "ready" for session in sessions)
    active_session = None
    if active_run and active_run.browser_session_id:
        active_session = next((session for session in sessions if session.session_id == active_run.browser_session_id), None)
    if active_session is None and sessions:
        active_session = sessions[0]

    status = "offline"
    label = "Disconnected"
    detail = runtime_detail or "No runner connected."
    browser_attached = False
    waiting_for_login = False
    human_takeover = False
    runner_connected = bool(active_session)
    controller_actor_id = None
    browser_session_id = None

    if active_session:
        browser_session_id = active_session.session_id
        browser_attached = active_session.status in {"ready", "busy"}
        human_takeover = bool(active_session.controller_lock)
        controller_actor_id = active_session.controller_lock.actor_id if active_session.controller_lock else None
        waiting_for_login = active_run is not None and active_run.state in {"waiting_for_user_action", "waiting_for_human"}
        if human_takeover:
            status = "takeover_active"
            label = "Takeover active"
            detail = "Manual browser control is active."
        elif waiting_for_login:
            status = "waiting_for_login"
            label = "Waiting for login"
            detail = "A manual login or confirmation step is blocking the run."
        elif browser_attached:
            status = "browser_attached"
            label = "Browser attached"
            detail = "A browser session is attached and ready for execution."
        elif active_session.origin == "local_runner" and local_ready:
            status = "local_ready"
            label = "Local ready"
            detail = "A local runner is connected."
        elif active_session.origin == "server_runner" and server_ready:
            status = "server_ready"
            label = "Server ready"
            detail = "A server runner is connected."
        else:
            status = "degraded" if runtime_ready else "disconnected"
            label = "Degraded" if runtime_ready else "Disconnected"
    elif runtime_ready:
        status = "degraded"
        label = "Degraded"
        detail = runtime_detail or "Runtime is reachable but no browser runner is attached."

    return SessionReadinessSummary(
        status=status,  # type: ignore[arg-type]
        label=label,
        detail=detail,
        local_ready=local_ready,
        server_ready=server_ready,
        browser_attached=browser_attached,
        waiting_for_login=waiting_for_login,
        human_takeover=human_takeover,
        runtime_ready=runtime_ready,
        runner_connected=runner_connected,
        browser_session_id=browser_session_id,
        controller_actor_id=controller_actor_id,
    )


def build_chat_turn_response(
    task: ConversationTask,
    assistant_text: str,
    *,
    conversation_meta: ConversationSummary,
) -> ChatTurnResponse:
    return ChatTurnResponse(
        conversation_meta=conversation_meta,
        assistant_message=AssistantMessage(
            message_id=f"assistant:{task.task_id}:{task.updated_at}",
            text=assistant_text,
        ),
        conversation=task_to_conversation_state(task),
        active_run=None,
        schedules=[],
    )


def _run_title(state: str) -> str:
    return " ".join(part.capitalize() for part in state.replace("_", " ").split()) or "Run update"


def _is_user_facing_run_text(text: str) -> bool:
    lowered = text.strip().lower()
    if not lowered:
        return False
    if (
        lowered.startswith("[openclaw/")
        or lowered.startswith("[agent-browser")
        or lowered.startswith("at async ")
        or lowered.startswith("{\"text\":")
        or "embedded run prompt end" in lowered
        or "prepared openclaw session" in lowered
        or "seeded runtime config" in lowered
        or "/node_modules/" in lowered
        or "/users/" in lowered
    ):
        return False
    return True


def _current_run_summary(run: AutomationRun) -> str | None:
    execution_progress = run.execution_progress
    if hasattr(execution_progress, "status_summary"):
        summary = str(execution_progress.status_summary or "").strip()
        if summary and _is_user_facing_run_text(summary):
            return summary
    elif isinstance(execution_progress, dict):
        summary = str(execution_progress.get("status_summary", "") or "").strip()
        if summary and _is_user_facing_run_text(summary):
            return summary

    current_runtime_action = None
    recent_action_log: list[dict[str, Any]] = []
    if hasattr(execution_progress, "current_runtime_action"):
        current_runtime_action = execution_progress.current_runtime_action
        recent_action_log = list(execution_progress.recent_action_log or [])
    elif isinstance(execution_progress, dict):
        current_runtime_action = execution_progress.get("current_runtime_action")
        recent_action_log = list(execution_progress.get("recent_action_log", []) or [])

    if isinstance(current_runtime_action, dict):
        message = str(current_runtime_action.get("message", "") or "").strip()
        if message and _is_user_facing_run_text(message):
            return message
    for entry in reversed(recent_action_log):
        if not isinstance(entry, dict):
            continue
        message = str(entry.get("message", "") or "").strip()
        if message and _is_user_facing_run_text(message):
            return message
    return None


def _run_body(run: AutomationRun) -> str:
    summary = _current_run_summary(run)
    if summary:
        return summary
    interruption = None
    if hasattr(run.execution_progress, "interruption"):
        interruption = run.execution_progress.interruption
    elif isinstance(run.execution_progress, dict):
        interruption = run.execution_progress.get("interruption")
    if isinstance(interruption, dict) and str(interruption.get("message", "") or "").strip():
        return str(interruption.get("message", "") or "").strip()
    if run.state == "awaiting_confirmation":
        return "The assistant is waiting for typed confirmation before the automation starts."
    if run.state == "scheduled":
        return "The automation is scheduled for a future time."
    if run.state == "queued":
        return "I’ve queued the task and I’ll update you here as I work through it."
    if run.state == "running":
        return "I’m working through the task and I’ll keep the next useful update here."
    if run.state == "waiting_for_user_action":
        return "A manual step is required. Complete it in the target app, then reply here."
    if run.state == "waiting_for_human":
        return "A sensitive action needs typed approval before the automation can continue."
    if run.state == "paused":
        return "The run is paused and can continue when you reply."
    if run.state == "failed":
        return "The run hit an issue and stopped."
    if run.state in {"completed", "succeeded"}:
        return "The automation finished successfully."
    if run.state in {"cancelled", "canceled"}:
        return "The automation was stopped."
    return "The automation will report progress here."


async def build_chat_session_state(user_id: str, session_id: str, task: ConversationTask | None) -> ChatSessionStateResponse:
    turns = await list_session_turns(user_id, session_id, limit=100)
    timeline: list[dict[str, Any]] = []
    for turn in turns:
        role = str(turn.get("role", "") or "")
        if role == "user":
            timeline.append(
                {
                    "id": str(turn.get("turn_id", "") or ""),
                    "type": "user",
                    "timestamp": str(turn.get("timestamp", "") or ""),
                    "text": str(turn.get("text", "") or ""),
                    "attachments": [],
                }
            )
        elif role == "assistant":
            timeline.append(
                {
                    "id": str(turn.get("turn_id", "") or ""),
                    "type": "assistant",
                    "timestamp": str(turn.get("timestamp", "") or ""),
                    "text": str(turn.get("text", "") or ""),
                }
            )

    run_rows = await list_runs_for_session(user_id, session_id, limit=10)
    run_details: dict[str, RunResponse] = {}
    active_candidates: list[AutomationRun] = []
    for row in run_rows:
        run_detail = await get_run_response(user_id, str(row.get("run_id", "") or ""))
        run_details[run_detail.run.run_id] = run_detail
        if run_detail.run.state in _ACTIVE_RUN_STATES:
            active_candidates.append(run_detail.run)
    active_run: AutomationRun | None = None
    if active_candidates:
        active_run = max(
            active_candidates,
            key=lambda run: str(getattr(run, "updated_at", "") or ""),
        )

    if active_run is not None:
        timeline.append(
            {
                "id": f"run_{active_run.run_id}",
                "type": "run",
                "timestamp": active_run.updated_at,
                "runId": active_run.run_id,
                "state": active_run.state,
                "title": _run_title(active_run.state),
                "body": _run_body(active_run),
                "executionProgress": active_run.execution_progress.model_dump(mode="json") if hasattr(active_run.execution_progress, "model_dump") else dict(active_run.execution_progress or {}),
            }
        )

    schedule_rows = await list_automation_schedules(user_id=user_id, limit=50)
    schedules = [
        {
            "schedule_id": row.schedule_id,
            "intent_id": task.legacy_intent_id if task else row.session_id,
            "status": "scheduled",
            "execution_mode": row.execution_mode,
            "executor_mode": row.executor_mode,
            "automation_engine": row.automation_engine,
            "browser_session_id": row.browser_session_id,
            "summary": "Scheduled automation from chat",
            "user_goal": row.prompt,
            "run_times": list(row.run_at),
            "timezone": row.timezone,
            "created_at": row.created_at,
        }
        for row in schedule_rows
        if row.session_id == session_id
    ]

    selected_model = task.model_id if task and task.model_id else "auto"
    conversation_meta = conversation_summary_from_sources(
        task=task,
        turns=turns,
        active_run=active_run,
    ) if task else None
    session_readiness = await build_session_readiness(user_id=user_id, active_run=active_run)

    return ChatSessionStateResponse(
        conversation_id=task.conversation_id if task else session_id,
        session_id=session_id,
        has_state=bool(turns or schedules or active_run or task),
        selected_model=selected_model,
        conversation_meta=conversation_meta,
        session_readiness=session_readiness,
        timeline=timeline,
        schedules=schedules,
        conversation=task_to_conversation_state(task) if task else None,
        active_run=active_run,
        run_details=run_details,
    )
