from __future__ import annotations

from typing import Any

from oi_agent.automation.conversation_task import ConversationTask
from oi_agent.automation.models import (
    AssistantMessage,
    AutomationRun,
    ChatSessionStateResponse,
    ChatTurnResponse,
    ConversationStateResponse,
    IntentDraft,
    RunResponse,
    TaskInterpretation,
)
from oi_agent.automation.run_service import get_run_response
from oi_agent.automation.schedule_service import list_automation_schedules
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
        normalized_inputs=[],
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


def build_chat_turn_response(task: ConversationTask, assistant_text: str) -> ChatTurnResponse:
    return ChatTurnResponse(
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


def _run_body(run: AutomationRun) -> str:
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
        return "The automation is queued and will start shortly."
    if run.state == "running":
        return "The automation is active and will report progress here."
    if run.state == "waiting_for_user_action":
        return "A manual step is required. Complete it in the target app, then reply here."
    if run.state == "waiting_for_human":
        return "A sensitive action needs typed approval before the automation can continue."
    if run.state == "paused":
        return "The run is paused and can continue when you reply."
    if run.state == "failed":
        return "The run hit an issue and is waiting for your next instruction."
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

    return ChatSessionStateResponse(
        session_id=session_id,
        has_state=bool(turns or schedules or active_run or task),
        selected_model=selected_model,
        timeline=timeline,
        schedules=schedules,
        conversation=task_to_conversation_state(task) if task else None,
        active_run=active_run,
        run_details=run_details,
    )
