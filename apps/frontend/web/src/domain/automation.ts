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
}

export interface AutomationPlan {
  plan_id: string;
  intent_id: string;
  execution_mode: ExecutionMode;
  summary: string;
  targets: Array<{
    target_type: "browser_tab" | "desktop_app" | "mobile_device" | "unknown";
    device_id?: string;
    tab_id?: number;
    app_name?: string;
  }>;
  steps: AutomationStep[];
  requires_confirmation: boolean;
}

export interface AutomationStep {
  step_id: string;
  kind:
    | "navigate"
    | "click"
    | "type"
    | "scroll"
    | "wait"
    | "extract"
    | "switch_target"
    | "unknown";
  label: string;
  description?: string;
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
  inputs: InputPart[];
  prepare_token?: string;
  client_context: {
    timezone: string;
    locale: string;
    device_id?: string;
    tab_id?: number;
    model?: string;
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
  };
}

export interface ChatPrimeResponse {
  prepare_token: string;
  expires_at: string;
  session_id: string;
  attachment_warning?: string;
}

export interface ChatTurnResponse {
  assistant_message: AssistantMessage;
  intent_draft: IntentDraft;
  suggested_next_actions: SuggestedNextAction[];
}

export interface ResolveExecutionRequest {
  session_id: string;
  intent_id: string;
  execution_mode: Exclude<ExecutionMode, "unknown">;
  executor_mode?: ExecutorMode;
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
  action: "acquire" | "release" | "navigate" | "refresh_stream" | "input";
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
  | EventEnvelope<"step.started", { run_id: string; step_id: string; index: number; label: string }>
  | EventEnvelope<"step.progress", { run_id: string; step_id: string; label: string }>
  | EventEnvelope<"step.completed", { run_id: string; step_id: string; index: number; screenshot_url: string | null }>
  | EventEnvelope<"step.failed", { run_id: string; step_id: string; code: string; message: string; retryable: boolean; screenshot_url: string | null }>
  | EventEnvelope<"run.paused", { run_id: string; reason: string }>
  | EventEnvelope<"run.resumed", { run_id: string }>
  | EventEnvelope<"run.waiting_for_user_action", { run_id: string; reason: string }>
  | EventEnvelope<"run.waiting_for_human", { run_id: string; reason: string; reason_code?: string; url?: string }>
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
  summary: string;
  user_goal: string;
  run_times: string[];
  timezone: string;
  created_at: string;
}

export interface ComposerAttachment {
  id: string;
  label: string;
  part: Exclude<InputPart, { type: "text" }>;
}
