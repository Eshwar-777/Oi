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
    "starting",
    "running",
    "paused",
    "waiting_for_user_action",
    "waiting_for_human",
    "human_controlling",
    "reconciling",
    "resuming",
    "retrying",
    "completed",
    "succeeded",
    "failed",
    "cancelled",
    "canceled",
    "timed_out",
    "expired",
]
ExecutorMode = Literal["unknown", "extension", "local_runner", "server_runner"]
AutomationEngine = Literal["playwright", "agent_browser"]
GoalType = Literal["ui_automation", "general_chat", "unknown"]
TaskKind = Literal["browser_automation", "general_chat", "unknown"]
ExecutionIntent = Literal["unspecified", "immediate", "once", "recurring"]
TargetType = Literal["browser_session", "desktop_app", "mobile_device", "unknown"]
ActionType = Literal[
    "reply_text",
    "select_execution_mode",
    "confirm",
    "start_run",
    "open_schedule_builder",
]
ArtifactType = Literal["screenshot", "log", "file"]
ScheduleState = Literal["scheduled", "claimed", "completed", "stopped", "failed", "disabled"]
NotificationUrgencyMode = Literal["all", "important_only", "none"]
RuntimeIncidentCategory = Literal[
    "auth",
    "navigation",
    "permission",
    "security",
    "ambiguity",
    "blocker",
    "unexpected_ui",
    "human_takeover",
    "resume_reconciliation",
]
RuntimeIncidentSeverity = Literal["info", "warning", "critical"]
ResumeDecisionStatus = Literal[
    "pending_replan",
    "resume_existing",
    "replace_remaining_steps",
    "ask_user",
    "cannot_resume",
]
StepKind = Literal[
    "navigate",
    "click",
    "type",
    "scroll",
    "wait",
    "extract",
    "snapshot",
    "press",
    "hover",
    "select",
    "upload",
    "tab",
    "frame",
    "open",
    "switch_target",
    "unknown",
]
StepStatus = Literal["pending", "running", "completed", "failed", "skipped"]
PhaseStatus = Literal["pending", "active", "completed", "blocked"]


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


class TaskInterpretation(BaseModel):
    task_kind: TaskKind = "unknown"
    execution_intent: ExecutionIntent = "unspecified"
    workflow_outline: list[str] = Field(default_factory=list)
    clarification_hints: list[str] = Field(default_factory=list)
    confidence: float = 0.0


class AgentBrowserTarget(BaseModel):
    by: str | None = None
    value: str | None = None
    x: int | None = None
    y: int | None = None
    screenshot_id: str | None = None
    viewport_width: int | None = None
    viewport_height: int | None = None
    device_pixel_ratio: float | None = None
    current_url: str | None = None
    page_title: str | None = None
    verification_checks: list[str] = Field(default_factory=list)
    role: str | None = None
    name: str | None = None
    ref: str | None = None
    label: str | None = None
    placeholder: str | None = None
    testid: str | None = None
    text: str | None = None
    page_ref: str | None = None
    candidates: list[dict[str, Any]] = Field(default_factory=list)
    disambiguation: dict[str, Any] = Field(default_factory=dict)


class AgentBrowserStep(BaseModel):
    type: Literal["browser"] = "browser"
    id: str | None = None
    command: str
    description: str | None = None
    target: AgentBrowserTarget | dict[str, Any] | str | None = None
    value: Any | None = None
    args: list[str] = Field(default_factory=list)
    snapshot_id: str | None = None
    page_ref: str | None = None
    output_key: str | None = None
    consumes_keys: list[str] = Field(default_factory=list)
    disambiguation: dict[str, Any] = Field(default_factory=dict)
    preconditions: list[dict[str, Any]] = Field(default_factory=list)
    success_criteria: list[dict[str, Any]] = Field(default_factory=list)


class IntentDraft(BaseModel):
    intent_id: str
    session_id: str
    user_goal: str
    goal_type: GoalType
    workflow_outline: list[str] = Field(default_factory=list)
    interpretation: TaskInterpretation = Field(default_factory=TaskInterpretation)
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
    attachment_warning: str | None = None
    assistant_prompt: str | None = None
    pending_action: str | None = None


class ExecutionBrief(BaseModel):
    goal: str
    app_name: str | None = None
    target_entities: dict[str, Any] = Field(default_factory=dict)
    workflow_phases: list[str] = Field(default_factory=list)
    phase_completion_checks: list[list[str]] = Field(default_factory=list)
    success_criteria: list[str] = Field(default_factory=list)
    guardrails: list[str] = Field(default_factory=list)
    disambiguation_hints: list[str] = Field(default_factory=list)
    completion_evidence: list[str] = Field(default_factory=list)


class PredictedPhase(BaseModel):
    phase_id: str
    label: str
    goal: str | None = None
    completion_signals: list[str] = Field(default_factory=list)
    advisory: bool = True


class PredictedExecutionPlan(BaseModel):
    summary: str
    phases: list[PredictedPhase] = Field(default_factory=list)
    advisory: bool = True
    generated_at: str | None = None


class ConfirmationPolicy(BaseModel):
    required: bool = False
    reason: str | None = None
    owner: Literal["conversation_core"] = "conversation_core"


class ExecutionContract(BaseModel):
    contract_id: str
    resolved_goal: str
    target_app: str | None = None
    target_entities: dict[str, Any] = Field(default_factory=dict)
    completion_criteria: list[str] = Field(default_factory=list)
    guardrails: list[str] = Field(default_factory=list)
    confirmation_policy: ConfirmationPolicy = Field(default_factory=ConfirmationPolicy)
    predicted_plan: PredictedExecutionPlan | None = None


class RuntimeBlock(BaseModel):
    reason: str
    reason_code: str | None = None
    message: str
    requires_user_reply: bool = False
    requires_confirmation: bool = False
    retriable: bool = True
    halt_kind: Literal["continue", "waiting_for_user_action", "waiting_for_human"] | None = None
    policy_source: Literal["deterministic", "llm_advisory"] | None = None
    verification_status: Literal["not_run", "passed", "failed", "ambiguous"] | None = None


class RuntimeActionPlan(BaseModel):
    status: Literal["action", "blocked", "completed"]
    summary: str = ""
    step: AgentBrowserStep | None = None
    block: RuntimeBlock | None = None
    intent: str = ""
    preferred_execution_mode: Literal["ref", "visual", "manual"]
    target_kind: str | None = None
    sensitive_step: bool = False
    expected_state_change: str = ""
    verification_checks: list[str] = Field(default_factory=list)
    execution_mode_detail: str | None = None
    evidence: dict[str, Any] | None = None


class ExecutionProgress(BaseModel):
    predicted_phases: list[ExecutionPhaseState] = Field(default_factory=list)
    active_phase_index: int | None = None
    completed_phase_evidence: dict[str, list[str]] = Field(default_factory=dict)
    current_runtime_action: dict[str, Any] | None = None
    recent_action_log: list[dict[str, Any]] = Field(default_factory=list)
    interruption: dict[str, Any] | None = None


class AutomationTarget(BaseModel):
    target_type: TargetType = "unknown"
    device_id: str | None = None
    tab_id: int | None = None
    app_name: str | None = None


class AutomationStep(BaseModel):
    step_id: str
    phase_index: int | None = None
    # Legacy flattened fields kept only for older persisted runs.
    kind: StepKind | None = None
    command: str | None = None
    # Canonical executable browser-step contract for fresh plans and runs.
    command_payload: AgentBrowserStep | None = None
    label: str
    description: str | None = None
    # Legacy mirrored command fields synthesized into command_payload when needed.
    target: Any | None = None
    value: Any | None = None
    args: list[str] = Field(default_factory=list)
    snapshot_id: str | None = None
    disambiguation: dict[str, Any] = Field(default_factory=dict)
    preconditions: list[dict[str, Any]] = Field(default_factory=list)
    success_criteria: list[dict[str, Any]] = Field(default_factory=list)
    page_hint: str | None = None
    page_ref: str | None = None
    output_key: str | None = None
    consumes_keys: list[str] = Field(default_factory=list)
    status: StepStatus | None = None
    screenshot_url: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    error_code: str | None = None
    error_message: str | None = None

    def normalized_command_payload(self) -> AgentBrowserStep:
        # Fresh steps already have the exact planner-produced browser command.
        if self.command_payload is not None:
            return self.command_payload

        # Older persisted rows may only have the flattened mirror fields.
        target_payload: AgentBrowserTarget | dict[str, Any] | str | None = None
        if isinstance(self.target, AgentBrowserTarget):
            target_payload = self.target
        elif isinstance(self.target, dict):
            target_payload = AgentBrowserTarget.model_validate(self.target)
        elif isinstance(self.target, str):
            target_payload = self.target
        elif self.page_ref:
            target_payload = AgentBrowserTarget(page_ref=self.page_ref)

        command = self.command or self.kind or "unknown"
        return AgentBrowserStep(
            id=self.step_id,
            command=command,
            description=self.description or self.label,
            target=target_payload,
            value=self.value,
            args=list(self.args),
            snapshot_id=self.snapshot_id,
            page_ref=self.page_ref,
            output_key=self.output_key,
            consumes_keys=list(self.consumes_keys),
            disambiguation=dict(self.disambiguation),
            preconditions=[dict(item) for item in self.preconditions],
            success_criteria=[dict(item) for item in self.success_criteria],
        )

    def with_response_command_payload(self) -> AutomationStep:
        # Fresh API responses should expose only the canonical payload-backed shape.
        if self.command_payload is not None:
            return self.model_copy(update={"kind": None, "command": None})
        return self.model_copy(update={"command_payload": self.normalized_command_payload()})


class AutomationPlan(BaseModel):
    plan_id: str
    intent_id: str
    execution_mode: ExecutionMode
    summary: str
    model_id: str | None = None
    execution_contract: ExecutionContract | None = None
    predicted_plan: PredictedExecutionPlan | None = None
    execution_brief: ExecutionBrief | None = None
    targets: list[AutomationTarget] = Field(default_factory=list)
    steps: list[AutomationStep] = Field(default_factory=list)
    requires_confirmation: bool = False


class ExecutionPhaseState(BaseModel):
    phase_index: int
    label: str
    status: PhaseStatus = "pending"
    last_updated_at: str | None = None


class BrowserStateSnapshot(BaseModel):
    captured_at: str
    url: str | None = None
    title: str | None = None
    page_id: str | None = None
    screenshot_url: str | None = None
    viewport: dict[str, Any] = Field(default_factory=dict)
    pages: list[dict[str, Any]] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class EvidenceQualityScores(BaseModel):
    dom_confidence: float = 0.0
    visual_confidence: float = 0.0
    agreement_score: float = 0.0


class UnifiedEvidenceBundle(BaseModel):
    current_url: str = ""
    current_title: str = ""
    active_page_ref: str | None = None
    snapshot_id: str = ""
    snapshot_ref_count: int = 0
    page_snapshot: dict[str, Any] | None = None
    screenshot: str = ""
    screenshot_id: str = ""
    viewport_width: int = 0
    viewport_height: int = 0
    device_pixel_ratio: float = 1.0
    structured_context: dict[str, Any] | None = None
    recent_completed_actions: list[str] = Field(default_factory=list)
    last_verification_result: str = ""
    evidence_quality: EvidenceQualityScores = Field(default_factory=EvidenceQualityScores)


class ExecutionModeDecision(BaseModel):
    mode: Literal["ref", "visual", "manual"] = "ref"
    reason: str = ""
    evidence_quality: EvidenceQualityScores = Field(default_factory=EvidenceQualityScores)


class RuntimeIncident(BaseModel):
    incident_id: str
    category: RuntimeIncidentCategory
    severity: RuntimeIncidentSeverity = "warning"
    code: str
    summary: str
    details: str | None = None
    visible_signals: list[str] = Field(default_factory=list)
    requires_human: bool = False
    replannable: bool = True
    user_visible: bool = True
    browser_snapshot: BrowserStateSnapshot | None = None
    created_at: str


class ResumeContext(BaseModel):
    resume_id: str
    trigger: str
    previous_state: RunState
    current_step_index: int | None = None
    current_plan_summary: str | None = None
    browser_snapshot: BrowserStateSnapshot | None = None
    trigger_incident: RuntimeIncident | None = None
    known_variables: dict[str, Any] = Field(default_factory=dict)
    recent_human_actions: list[dict[str, Any]] = Field(default_factory=list)
    incident_id: str | None = None
    created_at: str


class ResumeDecision(BaseModel):
    decision_id: str
    status: ResumeDecisionStatus
    rationale: str
    user_message: str
    completed_step_ids: list[str] = Field(default_factory=list)
    skipped_step_ids: list[str] = Field(default_factory=list)
    updated_remaining_steps: list[AutomationStep] = Field(default_factory=list)
    created_at: str


class RunError(BaseModel):
    code: str
    message: str
    retryable: bool = False


class RunProgressTracker(BaseModel):
    last_screenshot_hash: str | None = None
    repeated_screenshot_count: int = 0
    last_url: str | None = None
    last_title: str | None = None
    last_failed_step_id: str | None = None
    last_failure_signature: str | None = None
    repeated_failed_step_count: int = 0
    last_updated_at: str | None = None


class AutomationRun(BaseModel):
    run_id: str
    plan_id: str
    session_id: str
    state: RunState
    execution_mode: ExecutionMode
    executor_mode: ExecutorMode = "unknown"
    automation_engine: AutomationEngine = "agent_browser"
    browser_session_id: str | None = None
    current_step_index: int | None = None
    total_steps: int = 0
    created_at: str
    updated_at: str
    scheduled_for: list[str] | None = None
    last_error: RunError | None = None
    known_variables: dict[str, Any] = Field(default_factory=dict)
    page_registry: dict[str, dict[str, Any]] = Field(default_factory=dict)
    active_page_ref: str | None = None
    progress_tracker: RunProgressTracker = Field(default_factory=RunProgressTracker)
    runtime_incident: RuntimeIncident | None = None
    resume_context: ResumeContext | None = None
    resume_decision: ResumeDecision | None = None
    active_phase_index: int | None = None
    phase_states: list[ExecutionPhaseState] = Field(default_factory=list)
    execution_progress: ExecutionProgress = Field(default_factory=ExecutionProgress)


class RunArtifact(BaseModel):
    artifact_id: str
    type: ArtifactType
    url: str
    created_at: str
    step_id: str | None = None


class ConversationStateResponse(BaseModel):
    task_id: str
    phase: str
    status: str
    user_goal: str
    resolved_goal: str | None = None
    missing_fields: list[str] = Field(default_factory=list)
    timing: dict[str, Any] = Field(default_factory=dict)
    confirmation: dict[str, Any] = Field(default_factory=dict)
    active_run_action_needed: str | None = None


class ChatTurnRequest(BaseModel):
    session_id: str = Field(..., min_length=1)
    inputs: list[InputPart] = Field(..., min_length=1)
    prepare_token: str | None = None
    client_context: ClientContext = Field(default_factory=ClientContext)


class ChatTurnResponse(BaseModel):
    assistant_message: AssistantMessage
    conversation: ConversationStateResponse
    active_run: AutomationRun | None = None
    schedules: list[dict[str, Any]] = Field(default_factory=list)


class ChatPrimeRequest(BaseModel):
    session_id: str = Field(..., min_length=1)
    partial_inputs: list[InputPart] = Field(..., min_length=1)
    client_context: ClientContext = Field(default_factory=ClientContext)


class ChatPrimeResponse(BaseModel):
    prepare_token: str
    expires_at: str
    session_id: str
    attachment_warning: str | None = None


class ChatSessionStateResponse(BaseModel):
    session_id: str
    has_state: bool = False
    selected_model: str = "auto"
    timeline: list[dict[str, Any]] = Field(default_factory=list)
    schedules: list[dict[str, Any]] = Field(default_factory=list)
    conversation: ConversationStateResponse | None = None
    active_run: AutomationRun | None = None
    run_details: dict[str, RunResponse] = Field(default_factory=dict)


class ResolveExecutionSchedule(BaseModel):
    run_at: list[str] = Field(default_factory=list)
    interval_seconds: int | None = Field(default=None, ge=1)
    timezone: str | None = None


class ResolveExecutionRequest(BaseModel):
    session_id: str = Field(..., min_length=1)
    intent_id: str = Field(..., min_length=1)
    execution_mode: Literal["immediate", "once", "interval", "multi_time"]
    executor_mode: ExecutorMode = "unknown"
    automation_engine: AutomationEngine = "agent_browser"
    browser_session_id: str | None = None
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


class RunStatusSummary(BaseModel):
    status: Literal["pending", "in_progress", "waiting", "success", "failed"]
    is_terminal: bool = False
    is_success: bool = False
    all_steps_completed: bool = False
    total_steps: int = 0
    pending_steps: int = 0
    running_steps: int = 0
    completed_steps: int = 0
    failed_steps: int = 0
    skipped_steps: int = 0


class RunResponse(BaseModel):
    run: AutomationRun
    plan: AutomationPlan
    artifacts: list[RunArtifact] = Field(default_factory=list)
    status: RunStatusSummary


class RunListResponse(BaseModel):
    items: list[RunResponse] = Field(default_factory=list)


class RunActionResponse(BaseModel):
    run: AutomationRun
    assistant_message: AssistantMessage


class RunRetryRequest(BaseModel):
    browser_session_id: str | None = None


class RunTransition(BaseModel):
    transition_id: str
    run_id: str
    from_state: RunState | None = None
    to_state: RunState
    reason_code: str
    reason_text: str = ""
    actor_type: Literal["system", "user", "runner", "scheduler"] = "system"
    actor_id: str | None = None
    created_at: str


class RunTransitionListResponse(BaseModel):
    items: list[RunTransition] = Field(default_factory=list)


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
    executor_mode: ExecutorMode = "unknown"
    automation_engine: AutomationEngine = "agent_browser"
    browser_session_id: str | None = None
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
    claim_expires_at: str | None = None
    claimed_by: str | None = None
    created_at: str
    updated_at: str


class AutomationScheduleCreateRequest(BaseModel):
    session_id: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    execution_mode: Literal["once", "interval", "multi_time"]
    executor_mode: ExecutorMode = "unknown"
    automation_engine: AutomationEngine = "agent_browser"
    browser_session_id: str | None = None
    schedule: ResolveExecutionSchedule = Field(default_factory=ResolveExecutionSchedule)
    device_id: str | None = None
    tab_id: int | None = None


class AutomationScheduleResponse(BaseModel):
    schedule: AutomationSchedule


class NotificationPreferences(BaseModel):
    user_id: str
    desktop_enabled: bool = True
    browser_enabled: bool = True
    mobile_push_enabled: bool = True
    connected_device_only_for_noncritical: bool = True
    urgency_mode: NotificationUrgencyMode = "all"
    updated_at: str


class NotificationPreferencesUpdateRequest(BaseModel):
    desktop_enabled: bool = True
    browser_enabled: bool = True
    mobile_push_enabled: bool = True
    connected_device_only_for_noncritical: bool = True
    urgency_mode: NotificationUrgencyMode = "all"


class NotificationPreferencesResponse(BaseModel):
    preferences: NotificationPreferences


class AutomationScheduleListResponse(BaseModel):
    items: list[AutomationSchedule] = Field(default_factory=list)


class AutomationEngineAnalyticsItem(BaseModel):
    automation_engine: AutomationEngine
    total_runs: int = 0
    completed_runs: int = 0
    failed_runs: int = 0
    human_paused_runs: int = 0
    local_runner_runs: int = 0
    server_runner_runs: int = 0
    success_rate: float = 0.0
    failure_rate: float = 0.0
    human_pause_rate: float = 0.0
    avg_duration_seconds: float | None = None
    last_run_at: str | None = None


class AutomationEngineAnalyticsResponse(BaseModel):
    items: list[AutomationEngineAnalyticsItem] = Field(default_factory=list)


class RuntimeIncidentAnalyticsItem(BaseModel):
    incident_code: str
    category: RuntimeIncidentCategory
    site: str = "unknown"
    total_runs: int = 0
    waiting_for_human_runs: int = 0
    reconciliation_runs: int = 0
    engines: dict[str, int] = Field(default_factory=dict)
    last_seen_at: str | None = None


class RuntimeIncidentAnalyticsResponse(BaseModel):
    items: list[RuntimeIncidentAnalyticsItem] = Field(default_factory=list)
