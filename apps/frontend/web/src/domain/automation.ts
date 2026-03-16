export type InputPart =
  | { type: "text"; text: string }
  | { type: "audio"; file_id: string; transcript?: string }
  | { type: "image"; file_id: string; caption?: string; ocr_text?: string }
  | { type: "file"; file_id: string; mime_type: string; name: string; summary?: string };

export type ExecutionMode =
  | "unknown"
  | "immediate"
  | "once"
  | "interval"
  | "multi_time";

export type ConversationDecision =
  | "GENERAL_CHAT"
  | "ASK_CLARIFICATION"
  | "ASK_EXECUTION_MODE"
  | "REQUIRES_CONFIRMATION"
  | "READY_TO_EXECUTE"
  | "READY_TO_SCHEDULE"
  | "READY_FOR_MULTI_TIME_SCHEDULE"
  | "BLOCKED";

export type RunState =
  | "draft"
  | "awaiting_clarification"
  | "awaiting_execution_mode"
  | "awaiting_confirmation"
  | "scheduled"
  | "queued"
  | "starting"
  | "running"
  | "paused"
  | "waiting_for_user_action"
  | "waiting_for_human"
  | "human_controlling"
  | "reconciling"
  | "resuming"
  | "retrying"
  | "completed"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "canceled"
  | "timed_out"
  | "expired";

export type ExecutorMode = "unknown" | "extension" | "local_runner" | "server_runner";
export type AutomationEngine = "agent_browser" | "computer_use";
export type BrowserTarget = "auto" | "my_browser" | "managed_browser";

export interface IntentDraft {
  intent_id: string;
  session_id: string;
  user_goal: string;
  goal_type: "ui_automation" | "general_chat" | "unknown";
  normalized_inputs: InputPart[];
  entities: Record<string, unknown>;
  missing_fields: string[];
  timing_mode: ExecutionMode;
  timing_candidates: string[];
  can_automate: boolean;
  confidence: number;
  decision: ConversationDecision;
  requires_confirmation: boolean;
  risk_flags: string[];
  clarification_question?: string;
  execution_mode_question?: string;
  confirmation_message?: string;
  attachment_warning?: string;
  assistant_prompt?: string;
  pending_action?: string | null;
}

export interface AutomationPlan {
  plan_id: string;
  intent_id: string;
  execution_mode: ExecutionMode;
  summary: string;
  execution_brief?: {
    goal: string;
    app_name?: string | null;
    target_entities: Record<string, unknown>;
    workflow_phases: string[];
    phase_completion_checks?: string[][];
    success_criteria: string[];
    guardrails: string[];
    disambiguation_hints: string[];
    completion_evidence: string[];
  } | null;
  targets: Array<{
    target_type: "browser_session" | "desktop_app" | "mobile_device" | "unknown";
    device_id?: string;
    tab_id?: number;
    app_name?: string;
  }>;
  steps: AutomationStep[];
  requires_confirmation: boolean;
}

export interface AgentBrowserTargetPayload {
  by?: string;
  value?: string;
  role?: string;
  name?: string;
  ref?: string;
  label?: string;
  placeholder?: string;
  testid?: string;
  text?: string;
  page_ref?: string;
  candidates?: Array<Record<string, unknown>>;
  disambiguation?: Record<string, unknown>;
}

export interface AgentBrowserStepPayload {
  type: "browser";
  id?: string;
  command: string;
  description?: string;
  target?: AgentBrowserTargetPayload | Record<string, unknown> | string;
  value?: unknown;
  args?: string[];
  snapshot_id?: string;
  page_ref?: string;
  output_key?: string;
  consumes_keys?: string[];
  disambiguation?: Record<string, unknown>;
  preconditions?: Array<Record<string, unknown>>;
  success_criteria?: Array<Record<string, unknown>>;
}

export interface AutomationStep {
  step_id: string;
  phase_index?: number | null;
  // Legacy compatibility field for older persisted runs.
  kind?:
    | "navigate"
    | "click"
    | "type"
    | "scroll"
    | "wait"
    | "extract"
    | "snapshot"
    | "press"
    | "hover"
    | "select"
    | "upload"
    | "tab"
    | "frame"
    | "open"
    | "switch_target"
    | "unknown";
  // Legacy compatibility field for older persisted runs.
  command?: string;
  command_payload?: AgentBrowserStepPayload;
  label: string;
  description?: string;
  target?: unknown;
  value?: unknown;
  args?: string[];
  snapshot_id?: string;
  disambiguation?: Record<string, unknown>;
  preconditions?: Array<Record<string, unknown>>;
  success_criteria?: Array<Record<string, unknown>>;
  status?: "pending" | "running" | "completed" | "failed" | "skipped";
  screenshot_url?: string;
  started_at?: string;
  completed_at?: string;
  error_code?: string;
  error_message?: string;
}

export interface AutomationRun {
  run_id: string;
  plan_id: string;
  session_id: string;
  state: RunState;
  execution_mode: ExecutionMode;
  executor_mode?: ExecutorMode;
  automation_engine?: AutomationEngine;
  browser_session_id?: string | null;
  current_step_index: number | null;
  total_steps: number;
  created_at: string;
  updated_at: string;
  scheduled_for?: string[];
  last_error?: {
    code: string;
    message: string;
    retryable: boolean;
  } | null;
  runtime_incident?: {
    incident_id: string;
    category:
      | "auth"
      | "navigation"
      | "permission"
      | "security"
      | "ambiguity"
      | "blocker"
      | "unexpected_ui"
      | "human_takeover"
      | "resume_reconciliation";
    severity: "info" | "warning" | "critical";
    code: string;
    summary: string;
    details?: string | null;
    visible_signals: string[];
    requires_human: boolean;
    replannable: boolean;
    user_visible: boolean;
    browser_snapshot?: {
      captured_at: string;
      url?: string | null;
      title?: string | null;
      page_id?: string | null;
      screenshot_url?: string | null;
      metadata?: Record<string, unknown>;
    } | null;
    created_at: string;
  } | null;
  active_phase_index?: number | null;
  phase_states?: Array<{
    phase_index: number;
    label: string;
    status: "pending" | "active" | "completed" | "blocked";
    last_updated_at?: string | null;
  }>;
  execution_progress?: {
    predicted_phases?: Array<{
      phase_index: number;
      label: string;
      status: "pending" | "active" | "completed" | "blocked";
      last_updated_at?: string | null;
    }>;
    reconciled_phases?: Array<{
      phase_index: number;
      label: string;
      status: "pending" | "active" | "completed" | "blocked";
      last_updated_at?: string | null;
    }>;
    active_phase_index?: number | null;
    completed_phase_evidence?: Record<string, string[]>;
    phase_fact_evidence?: Record<string, string[]>;
    current_runtime_action?: Record<string, unknown> | null;
    recent_action_log?: Array<Record<string, unknown>>;
    interruption?: Record<string, unknown> | null;
    status_summary?: string | null;
  };
}

export interface AssistantMessage {
  message_id: string;
  role: "assistant";
  text: string;
}

export interface SuggestedNextAction {
  type:
    | "reply_text"
    | "select_execution_mode"
    | "confirm"
    | "start_run"
    | "open_schedule_builder";
  label: string;
  payload: Record<string, unknown>;
}

export interface GeminiModelOption {
  id: string;
  label: string;
  provider: string;
  supports_generation: boolean;
}

export interface GeminiModelListResponse {
  items: GeminiModelOption[];
  default_model_id: string | null;
}

export interface ChatTurnRequest {
  session_id: string;
  conversation_id?: string;
  inputs: InputPart[];
  prepare_token?: string;
  client_context: {
    timezone: string;
    locale: string;
    device_id?: string;
    tab_id?: number;
    model?: string;
    automation_engine?: AutomationEngine;
    browser_target?: BrowserTarget;
  };
}

export interface ChatPrimeRequest {
  session_id: string;
  partial_inputs: InputPart[];
  client_context: {
    timezone: string;
    locale: string;
    device_id?: string;
    tab_id?: number;
    model?: string;
    automation_engine?: AutomationEngine;
    browser_target?: BrowserTarget;
  };
}

export interface ChatPrimeResponse {
  prepare_token: string;
  expires_at: string;
  session_id: string;
  attachment_warning?: string;
}

export interface ConversationSummary {
  conversation_id: string;
  session_id: string;
  title: string;
  summary: string;
  created_at: string;
  updated_at: string;
  selected_model: string;
  selected_automation_engine?: AutomationEngine;
  last_assistant_text?: string | null;
  last_user_text?: string | null;
  last_run_state?: RunState | null;
  has_unread_updates: boolean;
  has_errors: boolean;
  badges: string[];
}

export interface SessionReadinessSummary {
  status:
    | "local_ready"
    | "server_ready"
    | "browser_attached"
    | "waiting_for_login"
    | "takeover_active"
    | "disconnected"
    | "degraded"
    | "offline";
  label: string;
  detail: string;
  local_ready: boolean;
  server_ready: boolean;
  browser_attached: boolean;
  waiting_for_login: boolean;
  human_takeover: boolean;
  runtime_ready: boolean;
  runner_connected: boolean;
  browser_session_id?: string | null;
  controller_actor_id?: string | null;
  last_checked_at?: string | null;
}

export interface ChatSessionStateResponse {
  conversation_id: string;
  session_id: string;
  has_state: boolean;
  selected_model: string;
  conversation_meta?: ConversationSummary | null;
  session_readiness: SessionReadinessSummary;
  timeline: Array<Record<string, unknown>>;
  schedules: Array<Record<string, unknown>>;
  conversation?: {
    task_id: string;
    phase: string;
    status: string;
    user_goal: string;
    resolved_goal?: string | null;
    missing_fields: string[];
    timing: Record<string, unknown>;
    confirmation: Record<string, unknown>;
    active_run_action_needed?: string | null;
  } | null;
  active_run?: AutomationRun | null;
  run_details: Record<string, RunDetailResponse>;
}

export interface ChatTurnResponse {
  conversation_meta: ConversationSummary;
  assistant_message: AssistantMessage;
  conversation: {
    conversation_id: string;
    task_id: string;
    phase: string;
    status: string;
    user_goal: string;
    resolved_goal?: string | null;
    missing_fields: string[];
    timing: Record<string, unknown>;
    confirmation: Record<string, unknown>;
    active_run_action_needed?: string | null;
  };
  active_run?: AutomationRun | null;
  schedules: Array<Record<string, unknown>>;
}

export interface ComputerUseExecuteRequest {
  session_id: string;
  conversation_id?: string;
  prompt: string;
  client_context: {
    timezone: string;
    locale: string;
    device_id?: string;
    tab_id?: number;
    model?: string;
    automation_engine?: AutomationEngine;
    browser_target?: BrowserTarget;
  };
}

export interface ComputerUseExecuteResponse {
  conversation_id: string;
  session_id: string;
  assistant_text: string;
  status: "clarification" | "scheduled" | "running" | "ready";
  run_id?: string | null;
  schedule_ids: string[];
  requires_clarification: boolean;
}

export interface ConversationListResponse {
  items: ConversationSummary[];
}

export interface ResolveExecutionRequest {
  session_id: string;
  intent_id: string;
  execution_mode: Exclude<ExecutionMode, "unknown">;
  executor_mode?: ExecutorMode;
  automation_engine?: AutomationEngine;
  browser_session_id?: string | null;
  schedule: {
    run_at?: string[];
    interval_seconds?: number;
    timezone: string;
  };
}

export interface ResolveExecutionResponse {
  assistant_message: AssistantMessage;
  plan: AutomationPlan | null;
  run: AutomationRun | null;
  status: "awaiting_confirmation" | "scheduled" | "queued" | "running";
}

export interface ConfirmRequest {
  session_id: string;
  intent_id: string;
  confirmed: boolean;
}

export interface ConfirmResponse {
  assistant_message: AssistantMessage;
  plan: AutomationPlan;
  run: AutomationRun;
}

export interface Artifact {
  artifact_id: string;
  type: "screenshot" | "log" | "file";
  url: string;
  created_at: string;
  step_id?: string;
}

export interface RunDetailResponse {
  run: AutomationRun;
  plan: AutomationPlan;
  artifacts: Artifact[];
  status: {
    status: "pending" | "in_progress" | "waiting" | "success" | "failed";
    is_terminal: boolean;
    is_success: boolean;
    all_steps_completed: boolean;
    total_steps: number;
    pending_steps: number;
    running_steps: number;
    completed_steps: number;
    failed_steps: number;
    skipped_steps: number;
  };
}

export interface RunTransition {
  transition_id: string;
  run_id: string;
  from_state?: RunState | null;
  to_state: RunState;
  reason_code: string;
  reason_text: string;
  actor_type: "system" | "user" | "runner" | "scheduler";
  actor_id?: string | null;
  created_at: string;
}

export interface BrowserSessionRecord {
  session_id: string;
  user_id: string;
  origin: "local_runner" | "server_runner";
  provider: string;
  automation_engine: AutomationEngine;
  status: "idle" | "starting" | "ready" | "busy" | "stopped" | "error";
  browser_session_id?: string | null;
  browser_version?: string | null;
  runner_id?: string | null;
  runner_label?: string | null;
  page_id?: string | null;
  pages: Array<{ page_id: string; url: string; title: string; is_active: boolean }>;
  viewport?: { width: number; height: number; dpr: number } | null;
  controller_lock?: {
    actor_id: string;
    actor_type: "web" | "mobile" | "desktop" | "system";
    acquired_at: string;
    expires_at: string;
    priority: number;
  } | null;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface SessionControlAuditRecord {
  audit_id: string;
  session_id: string;
  actor_id: string;
  actor_type: "web" | "mobile" | "desktop" | "system";
  action:
    | "acquire"
    | "release"
    | "navigate"
    | "refresh_stream"
    | "activate_page"
    | "preview_page"
    | "clear_preview_page"
    | "open_tab"
    | "input";
  input_type?: string | null;
  target_url?: string | null;
  outcome: "accepted" | "rejected";
  detail?: string | null;
  created_at: string;
}

export interface RunControlResponse {
  run: AutomationRun;
  assistant_message: AssistantMessage;
}

export interface EventEnvelope<TType extends string, TPayload> {
  event_id: string;
  session_id: string;
  run_id: string | null;
  type: TType;
  timestamp: string;
  payload: TPayload;
}

export type AutomationStreamEvent =
  | EventEnvelope<"assistant.message", { message_id: string; text: string }>
  | EventEnvelope<"understanding.started", { label: string }>
  | EventEnvelope<"understanding.completed", { intent_id: string; decision: ConversationDecision }>
  | EventEnvelope<"clarification.requested", { intent_id: string; question: string; missing_fields: string[] }>
  | EventEnvelope<"execution_mode.requested", { intent_id: string; question: string; allowed_modes: Exclude<ExecutionMode, "unknown">[] }>
  | EventEnvelope<"confirmation.requested", { intent_id: string; message: string }>
  | EventEnvelope<"run.created", { run: AutomationRun }>
  | EventEnvelope<"run.queued", { run_id: string }>
  | EventEnvelope<"run.started", { run_id: string }>
  | EventEnvelope<"run.activity", { run_id: string; summary: string; tone?: "neutral" | "warning" | "danger" | "success" }>
  | EventEnvelope<"run.log", { level: "info" | "error"; source: string; message: string; createdAt?: string }>
  | EventEnvelope<"run.browser.snapshot", { run_id?: string; summary?: string; message?: string; [key: string]: unknown }>
  | EventEnvelope<"run.browser.action", { run_id?: string; summary?: string; message?: string; [key: string]: unknown }>
  | EventEnvelope<"step.started", { run_id: string; step_id: string; index: number; label: string }>
  | EventEnvelope<"step.progress", { run_id: string; step_id: string; label: string }>
  | EventEnvelope<"step.completed", { run_id: string; step_id: string; index: number; screenshot_url: string | null }>
  | EventEnvelope<"step.failed", { run_id: string; step_id: string; code: string; message: string; retryable: boolean; screenshot_url: string | null }>
  | EventEnvelope<"run.paused", { run_id: string; reason: string }>
  | EventEnvelope<"run.resumed", { run_id: string }>
  | EventEnvelope<"run.waiting_for_user_action", { run_id: string; reason: string }>
  | EventEnvelope<"run.waiting_for_human", { run_id: string; reason: string; reason_code?: string; url?: string }>
  | EventEnvelope<
      "run.iterative_replan",
      {
        run_id: string;
        completed_command: string;
        next_command: string;
        replan_reasons: string[];
        snapshot_id?: string;
        page_ref?: string | null;
        url?: string | null;
        title?: string | null;
      }
    >
  | EventEnvelope<
      "run.runtime_incident",
      {
        run_id: string;
        step_id?: string;
        step_index?: number;
        incident: NonNullable<AutomationRun["runtime_incident"]>;
      }
    >
  | EventEnvelope<"run.interrupted_by_user", { run_id: string; message: string }>
  | EventEnvelope<"run.completed", { run_id: string; message: string }>
  | EventEnvelope<"run.failed", { run_id: string; code: string; message: string; retryable: boolean }>
  | EventEnvelope<"schedule.created", { schedule_id: string; run_times: string[] }>;

export interface ScheduleSummaryCard {
  schedule_id: string;
  intent_id: string;
  run_id?: string;
  status: "draft" | "scheduled";
  execution_mode: ExecutionMode;
  executor_mode?: ExecutorMode;
  automation_engine?: AutomationEngine;
  browser_session_id?: string | null;
  summary: string;
  user_goal: string;
  run_times: string[];
  timezone: string;
  created_at: string;
}

export interface AutomationEngineAnalyticsItem {
  automation_engine: AutomationEngine;
  total_runs: number;
  completed_runs: number;
  failed_runs: number;
  human_paused_runs: number;
  local_runner_runs: number;
  server_runner_runs: number;
  success_rate: number;
  failure_rate: number;
  human_pause_rate: number;
  avg_duration_seconds?: number | null;
  last_run_at?: string | null;
}

export interface RuntimeIncidentAnalyticsItem {
  incident_code: string;
  category:
    | "auth"
    | "navigation"
    | "permission"
    | "security"
    | "ambiguity"
    | "blocker"
    | "unexpected_ui"
    | "human_takeover"
    | "resume_reconciliation";
  site: string;
  total_runs: number;
  waiting_for_human_runs: number;
  reconciliation_runs: number;
  engines: Record<string, number>;
  last_seen_at?: string | null;
}

export interface NotificationPreferences {
  user_id: string;
  desktop_enabled: boolean;
  browser_enabled: boolean;
  mobile_push_enabled: boolean;
  connected_device_only_for_noncritical: boolean;
  urgency_mode: "all" | "important_only" | "none";
  updated_at: string;
}

export interface ComposerAttachment {
  id: string;
  label: string;
  part: Exclude<InputPart, { type: "text" }>;
}
