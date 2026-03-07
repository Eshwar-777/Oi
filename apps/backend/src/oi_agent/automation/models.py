from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


InputPartType = Literal["text", "audio", "image", "file"]
ExecutionMode = Literal["unknown", "immediate", "once", "interval", "multi_time"]
ConversationDecision = Literal[
    "GENERAL_CHAT",
    "ASK_CLARIFICATION",
    "ASK_EXECUTION_MODE",
    "REQUIRES_CONFIRMATION",
    "READY_TO_EXECUTE",
    "READY_TO_SCHEDULE",
    "READY_FOR_MULTI_TIME_SCHEDULE",
    "BLOCKED",
]
RunState = Literal[
    "draft",
    "awaiting_clarification",
    "awaiting_execution_mode",
    "awaiting_confirmation",
    "scheduled",
    "queued",
    "running",
    "paused",
    "waiting_for_user_action",
    "retrying",
    "completed",
    "failed",
    "cancelled",
    "expired",
]
GoalType = Literal["ui_automation", "general_chat", "unknown"]
TargetType = Literal["browser_tab", "desktop_app", "mobile_device", "unknown"]
ActionType = Literal[
    "reply_text",
    "select_execution_mode",
    "confirm",
    "start_run",
    "open_schedule_builder",
]
ArtifactType = Literal["screenshot", "log", "file"]
ScheduleState = Literal["scheduled", "claimed", "completed", "stopped", "failed", "disabled"]
StepKind = Literal[
    "navigate",
    "click",
    "type",
    "scroll",
    "wait",
    "extract",
    "switch_target",
    "unknown",
]
StepStatus = Literal["pending", "running", "completed", "failed", "skipped"]


class InputPart(BaseModel):
    type: InputPartType
    text: str | None = None
    file_id: str | None = None
    transcript: str | None = None
    caption: str | None = None
    ocr_text: str | None = None
    mime_type: str | None = None
    name: str | None = None
    summary: str | None = None


class ClientContext(BaseModel):
    timezone: str = "UTC"
    locale: str = "en-US"
    device_id: str | None = None
    tab_id: int | None = None
    model: str | None = None


class AssistantMessage(BaseModel):
    message_id: str
    role: Literal["assistant"] = "assistant"
    text: str


class SuggestedNextAction(BaseModel):
    type: ActionType
    label: str
    payload: dict[str, Any] = Field(default_factory=dict)


class IntentDraft(BaseModel):
    intent_id: str
    session_id: str
    user_goal: str
    goal_type: GoalType
    normalized_inputs: list[InputPart]
    entities: dict[str, Any] = Field(default_factory=dict)
    missing_fields: list[str] = Field(default_factory=list)
    timing_mode: ExecutionMode = "unknown"
    timing_candidates: list[str] = Field(default_factory=list)
    can_automate: bool = False
    confidence: float = 0.0
    model_id: str | None = None
    decision: ConversationDecision
    requires_confirmation: bool = False
    risk_flags: list[str] = Field(default_factory=list)
    clarification_question: str | None = None
    execution_mode_question: str | None = None
    confirmation_message: str | None = None


class AutomationTarget(BaseModel):
    target_type: TargetType = "unknown"
    device_id: str | None = None
    tab_id: int | None = None
    app_name: str | None = None


class AutomationStep(BaseModel):
    step_id: str
    kind: StepKind = "unknown"
    label: str
    description: str | None = None
    status: StepStatus | None = None
    screenshot_url: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    error_code: str | None = None
    error_message: str | None = None


class AutomationPlan(BaseModel):
    plan_id: str
    intent_id: str
    execution_mode: ExecutionMode
    summary: str
    model_id: str | None = None
    targets: list[AutomationTarget] = Field(default_factory=list)
    steps: list[AutomationStep] = Field(default_factory=list)
    requires_confirmation: bool = False


class RunError(BaseModel):
    code: str
    message: str
    retryable: bool = False


class AutomationRun(BaseModel):
    run_id: str
    plan_id: str
    session_id: str
    state: RunState
    execution_mode: ExecutionMode
    current_step_index: int | None = None
    total_steps: int = 0
    created_at: str
    updated_at: str
    scheduled_for: list[str] | None = None
    last_error: RunError | None = None


class RunArtifact(BaseModel):
    artifact_id: str
    type: ArtifactType
    url: str
    created_at: str
    step_id: str | None = None


class ChatTurnRequest(BaseModel):
    session_id: str = Field(..., min_length=1)
    inputs: list[InputPart] = Field(..., min_length=1)
    client_context: ClientContext = Field(default_factory=ClientContext)


class ChatTurnResponse(BaseModel):
    assistant_message: AssistantMessage
    intent_draft: IntentDraft
    suggested_next_actions: list[SuggestedNextAction] = Field(default_factory=list)


class ResolveExecutionSchedule(BaseModel):
    run_at: list[str] = Field(default_factory=list)
    interval_seconds: int | None = Field(default=None, ge=1)
    timezone: str | None = None


class ResolveExecutionRequest(BaseModel):
    session_id: str = Field(..., min_length=1)
    intent_id: str = Field(..., min_length=1)
    execution_mode: Literal["immediate", "once", "interval", "multi_time"]
    schedule: ResolveExecutionSchedule = Field(default_factory=ResolveExecutionSchedule)


class ResolveExecutionResponse(BaseModel):
    assistant_message: AssistantMessage
    plan: AutomationPlan | None = None
    run: AutomationRun | None = None
    status: Literal["awaiting_confirmation", "scheduled", "queued", "running"]


class ConfirmIntentRequest(BaseModel):
    session_id: str = Field(..., min_length=1)
    intent_id: str = Field(..., min_length=1)
    confirmed: bool


class ConfirmIntentResponse(BaseModel):
    assistant_message: AssistantMessage
    plan: AutomationPlan
    run: AutomationRun


class RunResponse(BaseModel):
    run: AutomationRun
    plan: AutomationPlan
    artifacts: list[RunArtifact] = Field(default_factory=list)


class RunActionResponse(BaseModel):
    run: AutomationRun
    assistant_message: AssistantMessage


class GeminiModelSummary(BaseModel):
    id: str
    label: str
    provider: str = "google"
    supports_generation: bool = True


class GeminiModelListResponse(BaseModel):
    items: list[GeminiModelSummary]
    default_model_id: str | None = None


class RunInterruptionRequest(BaseModel):
    reason: str | None = None
    source: Literal["user", "system", "extension"] = "user"


class AutomationSchedule(BaseModel):
    schedule_id: str
    user_id: str
    session_id: str
    prompt: str
    execution_mode: Literal["once", "interval", "multi_time"]
    timezone: str = "UTC"
    run_at: list[str] = Field(default_factory=list)
    interval_seconds: int | None = None
    device_id: str | None = None
    tab_id: int | None = None
    status: ScheduleState = "scheduled"
    enabled: bool = True
    next_run_at: str | None = None
    last_run_at: str | None = None
    last_error: str = ""
    claimed_at: str | None = None
    claimed_by: str | None = None
    created_at: str
    updated_at: str


class AutomationScheduleCreateRequest(BaseModel):
    session_id: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    execution_mode: Literal["once", "interval", "multi_time"]
    schedule: ResolveExecutionSchedule = Field(default_factory=ResolveExecutionSchedule)
    device_id: str | None = None
    tab_id: int | None = None


class AutomationScheduleResponse(BaseModel):
    schedule: AutomationSchedule


class AutomationScheduleListResponse(BaseModel):
    items: list[AutomationSchedule] = Field(default_factory=list)
