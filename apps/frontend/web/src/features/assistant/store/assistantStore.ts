import type {
  AutomationPlan,
  AutomationRun,
  AutomationStep,
  ComposerAttachment,
  ExecutionMode,
  GeminiModelOption,
  IntentDraft,
  RunDetailResponse,
  RunState,
  ScheduleSummaryCard,
} from "@/domain/automation";

export type TimelineItem =
  | {
      id: string;
      type: "user";
      timestamp: string;
      text: string;
      attachments: ComposerAttachment[];
    }
  | {
      id: string;
      type: "assistant";
      timestamp: string;
      text: string;
    }
  | {
      id: string;
      type: "status";
      timestamp: string;
      title: string;
      body: string;
    }
  | {
      id: string;
      type: "clarification";
      timestamp: string;
      question: string;
      missingFields: string[];
    }
  | {
      id: string;
      type: "execution_mode";
      timestamp: string;
      question: string;
      allowedModes: Exclude<ExecutionMode, "unknown">[];
    }
  | {
      id: string;
      type: "confirmation";
      timestamp: string;
      message: string;
    }
  | {
      id: string;
      type: "plan";
      timestamp: string;
      summary: string;
      executionMode: ExecutionMode;
      steps: AutomationStep[];
    }
  | {
      id: string;
      type: "run";
      timestamp: string;
      runId: string;
      state: RunState;
      title: string;
      body: string;
    }
  | {
      id: string;
      type: "step";
      timestamp: string;
      runId: string;
      stepId: string;
      status: "running" | "completed" | "failed";
      label: string;
      body?: string;
      screenshotUrl?: string | null;
      errorCode?: string;
      retryable?: boolean;
    };

export interface AssistantState {
  sessionId: string;
  selectedModel: string;
  modelOptions: GeminiModelOption[];
  timeline: TimelineItem[];
  schedules: ScheduleSummaryCard[];
  pendingIntent: IntentDraft | null;
  activePlan: AutomationPlan | null;
  activeRun: AutomationRun | null;
  runDetails: Record<string, RunDetailResponse>;
  runActionReasons: Record<string, string>;
  isThinking: boolean;
  preparedTurnToken: string | null;
  preparedAttachmentWarning: string | null;
}

export type AssistantAction =
  | { type: "SET_MODEL"; model: string }
  | { type: "SET_MODEL_OPTIONS"; items: GeminiModelOption[] }
  | { type: "SET_THINKING"; value: boolean }
  | { type: "APPEND_TIMELINE"; item: TimelineItem }
  | { type: "SET_PENDING_INTENT"; intent: IntentDraft | null }
  | { type: "SET_PLAN"; plan: AutomationPlan | null }
  | { type: "SET_ACTIVE_RUN"; run: AutomationRun | null }
  | { type: "SYNC_RUN"; runId: string; patch: Partial<AutomationRun> }
  | { type: "UPSERT_RUN_DETAIL"; detail: RunDetailResponse }
  | { type: "SET_PREPARED_TURN_TOKEN"; token: string | null }
  | { type: "SET_PREPARED_ATTACHMENT_WARNING"; message: string | null }
  | {
      type: "UPDATE_RUN_STEP";
      runId: string;
      stepId: string;
      patch: Partial<AutomationStep>;
    }
  | { type: "SET_RUN_ACTION_REASON"; runId: string; reason: string | null }
  | { type: "UPSERT_SCHEDULE"; card: ScheduleSummaryCard }
  | { type: "REMOVE_SCHEDULE_BY_INTENT"; intentId: string };

export const initialState: AssistantState = {
  sessionId: crypto.randomUUID(),
  selectedModel: "auto",
  modelOptions: [],
  timeline: [],
  schedules: [],
  pendingIntent: null,
  activePlan: null,
  activeRun: null,
  runDetails: {},
  runActionReasons: {},
  isThinking: false,
  preparedTurnToken: null,
  preparedAttachmentWarning: null,
};

export function assistantReducer(state: AssistantState, action: AssistantAction): AssistantState {
  switch (action.type) {
    case "SET_MODEL":
      return { ...state, selectedModel: action.model };
    case "SET_MODEL_OPTIONS":
      return { ...state, modelOptions: action.items };
    case "SET_THINKING":
      return { ...state, isThinking: action.value };
    case "APPEND_TIMELINE":
      return { ...state, timeline: [...state.timeline, action.item] };
    case "SET_PENDING_INTENT":
      return { ...state, pendingIntent: action.intent };
    case "SET_PLAN":
      return { ...state, activePlan: action.plan };
    case "SET_ACTIVE_RUN":
      return { ...state, activeRun: action.run };
    case "SET_PREPARED_TURN_TOKEN":
      return { ...state, preparedTurnToken: action.token };
    case "SET_PREPARED_ATTACHMENT_WARNING":
      return { ...state, preparedAttachmentWarning: action.message };
    case "SYNC_RUN":
      return {
        ...state,
        activeRun:
          state.activeRun && state.activeRun.run_id === action.runId
            ? { ...state.activeRun, ...action.patch }
            : state.activeRun,
        runDetails: state.runDetails[action.runId]
          ? {
              ...state.runDetails,
              [action.runId]: {
                ...state.runDetails[action.runId],
                run: {
                  ...state.runDetails[action.runId].run,
                  ...action.patch,
                },
              },
            }
          : state.runDetails,
      };
    case "UPSERT_RUN_DETAIL":
      return {
        ...state,
        runDetails: {
          ...state.runDetails,
          [action.detail.run.run_id]: action.detail,
        },
      };
    case "UPDATE_RUN_STEP": {
      const detail = state.runDetails[action.runId];
      if (!detail) return state;
      return {
        ...state,
        runDetails: {
          ...state.runDetails,
          [action.runId]: {
            ...detail,
            plan: {
              ...detail.plan,
              steps: detail.plan.steps.map((step) =>
                step.step_id === action.stepId ? { ...step, ...action.patch } : step,
              ),
            },
          },
        },
      };
    }
    case "SET_RUN_ACTION_REASON":
      return {
        ...state,
        runActionReasons: action.reason
          ? { ...state.runActionReasons, [action.runId]: action.reason }
          : Object.fromEntries(
              Object.entries(state.runActionReasons).filter(([runId]) => runId !== action.runId),
            ),
      };
    case "UPSERT_SCHEDULE": {
      const existing = state.schedules.find(
        (card) =>
          card.schedule_id === action.card.schedule_id || card.intent_id === action.card.intent_id,
      );
      if (existing) {
        return {
          ...state,
          schedules: state.schedules.map((card) =>
            card.schedule_id === existing.schedule_id ? action.card : card,
          ),
        };
      }
      return { ...state, schedules: [action.card, ...state.schedules] };
    }
    case "REMOVE_SCHEDULE_BY_INTENT":
      return {
        ...state,
        schedules: state.schedules.filter((card) => card.intent_id !== action.intentId),
      };
    default:
      return state;
  }
}

export function createTimelineId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export function now() {
  return new Date().toISOString();
}

export function shouldCreateDraftSchedule(intent: IntentDraft) {
  return (
    intent.decision === "ASK_EXECUTION_MODE" ||
    intent.decision === "READY_TO_SCHEDULE" ||
    intent.decision === "READY_FOR_MULTI_TIME_SCHEDULE"
  );
}

export function createDraftScheduleCard(intent: IntentDraft, timezone: string): ScheduleSummaryCard {
  return {
    schedule_id: `intent_${intent.intent_id}`,
    intent_id: intent.intent_id,
    status: "draft",
    execution_mode:
      intent.decision === "READY_FOR_MULTI_TIME_SCHEDULE"
        ? "multi_time"
        : intent.timing_mode === "unknown"
          ? "once"
          : intent.timing_mode,
    summary: "Schedule request captured from chat",
    user_goal: intent.user_goal,
    run_times: [],
    timezone,
    created_at: now(),
  };
}

export function createScheduleCard(
  intent: IntentDraft,
  run: AutomationRun,
  timezone: string,
): ScheduleSummaryCard {
  return {
    schedule_id: `intent_${intent.intent_id}`,
    intent_id: intent.intent_id,
    run_id: run.run_id,
    status: "scheduled",
    execution_mode: run.execution_mode,
    summary:
      run.execution_mode === "interval"
        ? "Repeating automation queued from chat"
        : run.execution_mode === "multi_time"
          ? "Multi-time automation queued from chat"
          : "One-time automation queued from chat",
    user_goal: intent.user_goal,
    run_times: run.scheduled_for ?? [],
    timezone,
    created_at: now(),
  };
}

export function buildRunBody(run: AutomationRun) {
  switch (run.state) {
    case "awaiting_confirmation":
      return "Review the task and confirm before the automation starts.";
    case "scheduled":
      return "The automation is queued for a future time.";
    case "queued":
      return "The automation is queued and will start as soon as the runtime begins executing it.";
    case "running":
      return "The automation is active and will report progress here.";
    case "waiting_for_user_action":
      return "There is a manual step to complete. Finish it in the target app, then press Resume.";
    case "waiting_for_human":
      return "A sensitive action needs approval before the automation can continue.";
    case "paused":
      return "The run is paused and can continue when you are ready.";
    case "failed":
      return "The run hit an issue and needs a decision.";
    case "completed":
      return "The automation finished successfully.";
    case "cancelled":
      return "The automation was stopped.";
    default:
      return "The automation will report progress here.";
  }
}
