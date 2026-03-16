from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from oi_agent.automation.models import AutomationEngine

ConversationTaskStatus = Literal["active", "scheduled", "executing", "completed", "failed", "cancelled"]
ConversationTaskPhase = Literal[
    "general_chat",
    "collecting_requirements",
    "awaiting_timing",
    "awaiting_confirmation",
    "ready_to_execute",
    "executing",
    "awaiting_user_action",
    "scheduled",
    "completed",
    "failed",
    "cancelled",
]
ConversationActionRequest = Literal["none", "ask", "confirm", "execute", "schedule", "run_control", "reply"]
ConversationIntentType = Literal["new_task", "continue_task", "run_control", "general_chat"]
ConversationTaskKind = Literal["ui_automation", "general_chat"]


class ConversationTiming(BaseModel):
    mode: Literal["unknown", "immediate", "once", "recurring"] = "unknown"
    timezone: str = "UTC"
    run_at: list[str] = Field(default_factory=list)
    recurrence: dict[str, Any] = Field(default_factory=dict)
    raw_user_text: str | None = None


class ConversationConfirmation(BaseModel):
    required: bool = False
    confirmed: bool | None = None
    subject: str | None = None
    reason: str | None = None


class ConversationExecution(BaseModel):
    task_kind: ConversationTaskKind = "ui_automation"
    browser_target: Literal["auto", "my_browser", "managed_browser"] = "auto"
    browser_session_id: str | None = None
    missing_fields: list[str] = Field(default_factory=list)
    workflow_outline: list[str] = Field(default_factory=list)
    risk_flags: list[str] = Field(default_factory=list)
    clarification_question: str | None = None
    interruption: dict[str, Any] | None = None
    active_run_action_needed: str | None = None


class AssistantReplyPayload(BaseModel):
    kind: Literal["clarification", "confirmation", "status_update", "interruption", "completion", "reply"] = "reply"
    text: str
    reason: str | None = None
    instruction: str | None = None
    expected_reply_examples: list[str] = Field(default_factory=list)
    open_sessions_hint: str | None = None


class ConversationTask(BaseModel):
    task_id: str
    conversation_id: str = ""
    legacy_intent_id: str
    session_id: str
    user_id: str
    status: ConversationTaskStatus = "active"
    phase: ConversationTaskPhase = "collecting_requirements"
    user_goal: str
    resolved_goal: str | None = None
    goal_type: Literal["ui_automation", "general_chat", "unknown"] = "unknown"
    model_id: str | None = None
    automation_engine: AutomationEngine = "agent_browser"
    slots: dict[str, Any] = Field(default_factory=dict)
    timing: ConversationTiming = Field(default_factory=ConversationTiming)
    confirmation: ConversationConfirmation = Field(default_factory=ConversationConfirmation)
    execution: ConversationExecution = Field(default_factory=ConversationExecution)
    active_run_id: str | None = None
    active_schedule_id: str | None = None
    last_assistant_message: str | None = None
    created_at: str
    updated_at: str


class ConversationResolution(BaseModel):
    assistant_reply: AssistantReplyPayload
    task_patch: dict[str, Any] = Field(default_factory=dict)
    next_phase: ConversationTaskPhase
    action_request: ConversationActionRequest = "none"
    action_payload: dict[str, Any] = Field(default_factory=dict)
    confidence: float = 0.0
    intent_type: ConversationIntentType = "continue_task"


class ExecutionRequest(BaseModel):
    task_id: str
    conversation_id: str
    session_id: str
    user_id: str
    legacy_intent_id: str
    resolved_goal: str
    slots: dict[str, Any] = Field(default_factory=dict)
    timing: ConversationTiming = Field(default_factory=ConversationTiming)
    confirmation: ConversationConfirmation = Field(default_factory=ConversationConfirmation)
    completion_criteria: list[str] = Field(default_factory=list)
    active_run_id: str | None = None
    model_id: str | None = None
    automation_engine: AutomationEngine = "agent_browser"


class ScheduleRequest(BaseModel):
    task_id: str
    conversation_id: str
    session_id: str
    user_id: str
    legacy_intent_id: str
    prompt: str
    timing: ConversationTiming = Field(default_factory=ConversationTiming)
    model_id: str | None = None
    automation_engine: AutomationEngine = "agent_browser"
