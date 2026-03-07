import {
  createContext,
  useCallback,
  useEffect,
  useContext,
  useMemo,
  useReducer,
  useRef,
} from "react";
import type { ReactNode } from "react";
import {
  chatTurn as apiChatTurn,
  confirmIntent as apiConfirmIntent,
  resolveExecution as apiResolveExecution,
} from "@/api/chat";
import { eventStreamClient } from "@/api/events";
import { getRun as apiGetRun, pauseRun as apiPauseRun, resumeRun as apiResumeRun, retryRun as apiRetryRun, stopRun as apiStopRun } from "@/api/runs";
import type {
  AssistantMessage,
  AutomationPlan,
  AutomationRun,
  AutomationStep,
  AutomationStreamEvent,
  ChatTurnResponse,
  ComposerAttachment,
  ConfirmResponse,
  ExecutionMode,
  IntentDraft,
  ResolveExecutionResponse,
  RunDetailResponse,
  RunState,
  ScheduleSummaryCard,
} from "@/domain/automation";
import {
  createMockRunEvents,
  mockChatTurn,
  mockConfirm,
  mockGetRun,
  mockResolveExecution,
  mockRunControl,
} from "@/mocks/automationMock";
import { decisionLabel, errorCopy, runStateLabel } from "./uiCopy";

type TimelineItem =
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

interface AssistantState {
  sessionId: string;
  selectedModel: string;
  timeline: TimelineItem[];
  schedules: ScheduleSummaryCard[];
  pendingIntent: IntentDraft | null;
  activePlan: AutomationPlan | null;
  activeRun: AutomationRun | null;
  runDetails: Record<string, RunDetailResponse>;
  runActionReasons: Record<string, string>;
  isThinking: boolean;
}

type AssistantAction =
  | { type: "SET_MODEL"; model: string }
  | { type: "SET_THINKING"; value: boolean }
  | { type: "APPEND_TIMELINE"; item: TimelineItem }
  | { type: "SET_PENDING_INTENT"; intent: IntentDraft | null }
  | { type: "SET_PLAN"; plan: AutomationPlan | null }
  | { type: "SET_ACTIVE_RUN"; run: AutomationRun | null }
  | { type: "SYNC_RUN"; runId: string; patch: Partial<AutomationRun> }
  | { type: "UPSERT_RUN_DETAIL"; detail: RunDetailResponse }
  | {
      type: "UPDATE_RUN_STEP";
      runId: string;
      stepId: string;
      patch: Partial<AutomationStep>;
    }
  | { type: "SET_RUN_ACTION_REASON"; runId: string; reason: string | null }
  | { type: "UPSERT_SCHEDULE"; card: ScheduleSummaryCard }
  | { type: "REMOVE_SCHEDULE_BY_INTENT"; intentId: string };

const initialState: AssistantState = {
  sessionId: crypto.randomUUID(),
  selectedModel: "gemini-2.0-flash",
  timeline: [],
  schedules: [],
  pendingIntent: null,
  activePlan: null,
  activeRun: null,
  runDetails: {},
  runActionReasons: {},
  isThinking: false,
};

function assistantReducer(state: AssistantState, action: AssistantAction): AssistantState {
  switch (action.type) {
    case "SET_MODEL":
      return { ...state, selectedModel: action.model };
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
    case "SYNC_RUN":
      return {
        ...state,
        activeRun:
          state.activeRun && state.activeRun.run_id === action.runId
            ? {
                ...state.activeRun,
                ...action.patch,
              }
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
          card.schedule_id === action.card.schedule_id ||
          card.intent_id === action.card.intent_id,
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

function createTimelineId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function now() {
  return new Date().toISOString();
}

async function withMockFallback<T>(primary: () => Promise<T>, fallback: () => Promise<T>) {
  try {
    return await primary();
  } catch {
    return fallback();
  }
}

interface AssistantContextValue extends AssistantState {
  sendTurn: (text: string, attachments: ComposerAttachment[]) => Promise<void>;
  chooseExecutionMode: (
    mode: Exclude<ExecutionMode, "unknown">,
    schedule: { run_at?: string[]; interval_seconds?: number; timezone: string },
  ) => Promise<void>;
  confirmPendingIntent: () => Promise<void>;
  controlRun: (runId: string, action: "pause" | "resume" | "stop" | "retry") => Promise<void>;
  selectModel: (model: string) => void;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

function createScheduleCard(
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

function buildRunBody(run: AutomationRun) {
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

function shouldCreateDraftSchedule(intent: IntentDraft) {
  return (
    intent.decision === "ASK_EXECUTION_MODE" ||
    intent.decision === "READY_TO_SCHEDULE" ||
    intent.decision === "READY_FOR_MULTI_TIME_SCHEDULE"
  );
}

function createDraftScheduleCard(
  intent: IntentDraft,
  timezone: string,
): ScheduleSummaryCard {
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

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(assistantReducer, initialState);
  const stateRef = useRef(state);
  const confirmPendingIntentRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const appendAssistantMessage = useCallback((message: AssistantMessage) => {
    dispatch({
      type: "APPEND_TIMELINE",
      item: {
        id: message.message_id,
        type: "assistant",
        timestamp: now(),
        text: message.text,
      },
    });
  }, []);

  const applyIntentResponse = useCallback((response: ChatTurnResponse, timezone: string) => {
    appendAssistantMessage(response.assistant_message);
    dispatch({ type: "SET_PENDING_INTENT", intent: response.intent_draft });
    if (response.intent_draft.decision === "GENERAL_CHAT") {
      dispatch({ type: "SET_PLAN", plan: null });
      return;
    }

    if (shouldCreateDraftSchedule(response.intent_draft)) {
      dispatch({
        type: "UPSERT_SCHEDULE",
        card: createDraftScheduleCard(response.intent_draft, timezone),
      });
    }

    if (
      response.intent_draft.decision !== "ASK_CLARIFICATION" &&
      response.intent_draft.decision !== "ASK_EXECUTION_MODE" &&
      response.intent_draft.decision !== "REQUIRES_CONFIRMATION"
    ) {
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("intent"),
          type: "status",
          timestamp: now(),
          title: decisionLabel(response.intent_draft.decision),
          body: response.intent_draft.user_goal,
        },
      });
    }

    if (response.intent_draft.decision === "ASK_CLARIFICATION") {
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("clarify"),
          type: "clarification",
          timestamp: now(),
          question:
            response.intent_draft.clarification_question ||
            "I need one more detail before I can continue.",
          missingFields: response.intent_draft.missing_fields,
        },
      });
    }

    if (response.intent_draft.decision === "ASK_EXECUTION_MODE") {
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("mode"),
          type: "execution_mode",
          timestamp: now(),
          question:
            response.intent_draft.execution_mode_question ||
            "Choose how you want this to run.",
          allowedModes: ["immediate", "once", "interval", "multi_time"],
        },
      });
    }

    if (response.intent_draft.decision === "REQUIRES_CONFIRMATION") {
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("confirm"),
          type: "confirmation",
          timestamp: now(),
          message:
            response.intent_draft.confirmation_message ||
            "Please confirm before I continue.",
        },
      });
    }
  }, [appendAssistantMessage]);

  const applyStreamEvent = useCallback(
    async (event: AutomationStreamEvent) => {
      const currentState = stateRef.current;
      const stepSource =
        (event.run_id ? currentState.runDetails[event.run_id]?.plan.steps : undefined) ??
        currentState.activePlan?.steps ??
        [];

      if (event.type === "run.created") {
        dispatch({ type: "SET_ACTIVE_RUN", run: event.payload.run });
        const detail = await withMockFallback(
          () => apiGetRun(event.payload.run.run_id),
          () => mockGetRun(event.payload.run.run_id),
        );
        dispatch({ type: "UPSERT_RUN_DETAIL", detail });
        return;
      }

      if (event.type === "assistant.message") {
        appendAssistantMessage({
          message_id: event.payload.message_id,
          role: "assistant",
          text: event.payload.text,
        });
        return;
      }

      if (event.type === "clarification.requested") {
        dispatch({
          type: "APPEND_TIMELINE",
          item: {
            id: createTimelineId("clarify"),
            type: "clarification",
            timestamp: event.timestamp,
            question: event.payload.question,
            missingFields: event.payload.missing_fields,
          },
        });
        return;
      }

      if (event.type === "execution_mode.requested") {
        dispatch({
          type: "APPEND_TIMELINE",
          item: {
            id: createTimelineId("mode"),
            type: "execution_mode",
            timestamp: event.timestamp,
            question: event.payload.question,
            allowedModes: event.payload.allowed_modes,
          },
        });
        return;
      }

      if (event.type === "confirmation.requested") {
        dispatch({
          type: "APPEND_TIMELINE",
          item: {
            id: createTimelineId("confirm"),
            type: "confirmation",
            timestamp: event.timestamp,
            message: event.payload.message,
          },
        });
        return;
      }

      if (event.type === "run.queued") {
        dispatch({
          type: "UPDATE_ACTIVE_RUN_STATE",
          runId: event.payload.run_id,
          state: "queued",
          updatedAt: event.timestamp,
        });
        dispatch({
          type: "APPEND_TIMELINE",
          item: {
            id: createTimelineId("run-queued"),
            type: "run",
            timestamp: event.timestamp,
            runId: event.payload.run_id,
            state: "queued",
            title: "Run queued",
            body: "The automation is queued and will start shortly.",
          },
        });
        return;
      }

      if (event.type === "schedule.created") {
        dispatch({
          type: "APPEND_TIMELINE",
          item: {
            id: createTimelineId("schedule"),
            type: "status",
            timestamp: event.timestamp,
            title: "Upcoming event saved",
            body:
              event.payload.run_times.length > 0
                ? `Next run: ${new Date(event.payload.run_times[0]).toLocaleString()}`
                : "The schedule is now available in the schedules tab.",
          },
        });
        return;
      }

      if (event.type === "run.started" || event.type === "run.resumed") {
        dispatch({
          type: "SYNC_RUN",
          runId: event.payload.run_id,
          patch: {
            state: "running",
            updated_at: event.timestamp,
          },
        });
        dispatch({ type: "SET_RUN_ACTION_REASON", runId: event.payload.run_id, reason: null });
        dispatch({
          type: "APPEND_TIMELINE",
          item: {
            id: createTimelineId("run-start"),
            type: "run",
            timestamp: event.timestamp,
            runId: event.payload.run_id,
            state: "running",
            title: "Run in progress",
            body: "I am working through the automation steps.",
          },
        });
        return;
      }

      if (event.type === "run.paused") {
        dispatch({
          type: "UPDATE_ACTIVE_RUN_STATE",
          runId: event.payload.run_id,
          state: "paused",
          updatedAt: event.timestamp,
        });
        dispatch({
          type: "APPEND_TIMELINE",
          item: {
            id: createTimelineId("run-paused"),
            type: "run",
            timestamp: event.timestamp,
            runId: event.payload.run_id,
            state: "paused",
            title: "Run paused",
            body: event.payload.reason,
          },
        });
        return;
      }

      if (event.type === "step.started") {
        dispatch({
          type: "SYNC_RUN",
          runId: event.payload.run_id,
          patch: {
            current_step_index: event.payload.index,
            updated_at: event.timestamp,
          },
        });
        dispatch({
          type: "UPDATE_RUN_STEP",
          runId: event.payload.run_id,
          stepId: event.payload.step_id,
          patch: {
            status: "running",
            started_at: event.timestamp,
          },
        });
        dispatch({
          type: "APPEND_TIMELINE",
          item: {
            id: createTimelineId("step"),
            type: "step",
            timestamp: event.timestamp,
            runId: event.payload.run_id,
            stepId: event.payload.step_id,
            status: "running",
            label: event.payload.label,
            body: stepSource[event.payload.index]?.description,
          },
        });
        return;
      }

      if (event.type === "step.completed") {
        dispatch({
          type: "UPDATE_RUN_STEP",
          runId: event.payload.run_id,
          stepId: event.payload.step_id,
          patch: {
            status: "completed",
            completed_at: event.timestamp,
            screenshot_url: event.payload.screenshot_url ?? undefined,
          },
        });
        dispatch({
          type: "APPEND_TIMELINE",
          item: {
            id: createTimelineId("step"),
            type: "step",
            timestamp: event.timestamp,
            runId: event.payload.run_id,
            stepId: event.payload.step_id,
            status: "completed",
            label: stepSource[event.payload.index]?.label || "Step completed",
            screenshotUrl: event.payload.screenshot_url,
          },
        });
        return;
      }

      if (event.type === "step.failed") {
        dispatch({
          type: "UPDATE_RUN_STEP",
          runId: event.payload.run_id,
          stepId: event.payload.step_id,
          patch: {
            status: "failed",
            error_code: event.payload.code,
            error_message: event.payload.message,
            completed_at: event.timestamp,
            screenshot_url: event.payload.screenshot_url ?? undefined,
          },
        });
        dispatch({
          type: "APPEND_TIMELINE",
          item: {
            id: createTimelineId("step"),
            type: "step",
            timestamp: event.timestamp,
            runId: event.payload.run_id,
            stepId: event.payload.step_id,
            status: "failed",
            label: "Step needs attention",
            body: errorCopy(event.payload.code),
            screenshotUrl: event.payload.screenshot_url,
            errorCode: event.payload.code,
            retryable: event.payload.retryable,
          },
        });
        return;
      }

      if (event.type === "run.waiting_for_user_action") {
        dispatch({
          type: "SYNC_RUN",
          runId: event.payload.run_id,
          patch: {
            state: "waiting_for_user_action",
            updated_at: event.timestamp,
          },
        });
        dispatch({
          type: "SET_RUN_ACTION_REASON",
          runId: event.payload.run_id,
          reason: event.payload.reason,
        });
        dispatch({
          type: "APPEND_TIMELINE",
          item: {
            id: createTimelineId("run"),
            type: "run",
            timestamp: event.timestamp,
            runId: event.payload.run_id,
            state: "waiting_for_user_action",
            title: "Manual action required",
            body: event.payload.reason,
          },
        });
        return;
      }

      if (event.type === "run.completed") {
        dispatch({
          type: "SYNC_RUN",
          runId: event.payload.run_id,
          patch: {
            state: "completed",
            updated_at: event.timestamp,
          },
        });
        dispatch({ type: "SET_RUN_ACTION_REASON", runId: event.payload.run_id, reason: null });
        dispatch({
          type: "APPEND_TIMELINE",
          item: {
            id: createTimelineId("run"),
            type: "run",
            timestamp: event.timestamp,
            runId: event.payload.run_id,
            state: "completed",
            title: "Run completed",
            body: event.payload.message,
          },
        });
        return;
      }

      if (event.type === "run.waiting_for_user_action") {
        dispatch({
          type: "UPDATE_ACTIVE_RUN_STATE",
          runId: event.payload.run_id,
          state: "waiting_for_user_action",
          updatedAt: event.timestamp,
        });
        dispatch({
          type: "APPEND_TIMELINE",
          item: {
            id: createTimelineId("run-waiting"),
            type: "run",
            timestamp: event.timestamp,
            runId: event.payload.run_id,
            state: "waiting_for_user_action",
            title: "Waiting for you",
            body: event.payload.reason,
          },
        });
        return;
      }

      if (event.type === "run.interrupted_by_user") {
        dispatch({
          type: "UPDATE_ACTIVE_RUN_STATE",
          runId: event.payload.run_id,
          state: "paused",
          updatedAt: event.timestamp,
        });
        dispatch({
          type: "APPEND_TIMELINE",
          item: {
            id: createTimelineId("run-interrupt"),
            type: "run",
            timestamp: event.timestamp,
            runId: event.payload.run_id,
            state: "paused",
            title: "Run paused",
            body: event.payload.message,
          },
        });
        return;
      }

      if (event.type === "run.failed") {
        dispatch({
          type: "SYNC_RUN",
          runId: event.payload.run_id,
          patch: {
            state: "failed",
            updated_at: event.timestamp,
            last_error: {
              code: event.payload.code,
              message: event.payload.message,
              retryable: event.payload.retryable,
            },
          },
        });
        dispatch({ type: "SET_RUN_ACTION_REASON", runId: event.payload.run_id, reason: null });
        dispatch({
          type: "APPEND_TIMELINE",
          item: {
            id: createTimelineId("run"),
            type: "run",
            timestamp: event.timestamp,
            runId: event.payload.run_id,
            state: "failed",
            title: "Run needs attention",
            body: errorCopy(event.payload.code),
          },
        });
        return;
      }
    },
    [appendAssistantMessage],
  );

  const applyResolveResponse = useCallback(
    async (
      response: ResolveExecutionResponse | ConfirmResponse,
      intent: IntentDraft,
      timezone: string,
      useMockEvents: boolean,
    ) => {
      const plan = response.plan;
      if (!plan) {
        appendAssistantMessage(response.assistant_message);
        return;
      }

      appendAssistantMessage(response.assistant_message);
      dispatch({ type: "SET_PLAN", plan });

      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("plan"),
          type: "plan",
          timestamp: now(),
          summary: plan.summary,
          executionMode: plan.execution_mode,
          steps: plan.steps,
        },
      });

      if ("run" in response && response.run) {
        const run = response.run;
        if (run.state === "awaiting_confirmation") {
          dispatch({ type: "SET_PENDING_INTENT", intent });
          dispatch({
            type: "APPEND_TIMELINE",
            item: {
              id: createTimelineId("confirm"),
              type: "confirmation",
              timestamp: now(),
              message: response.assistant_message.text,
            },
          });
        } else {
          dispatch({ type: "SET_PENDING_INTENT", intent: null });
        }
        dispatch({ type: "SET_ACTIVE_RUN", run });
        const detail = await withMockFallback(
          () => apiGetRun(run.run_id),
          () => mockGetRun(run.run_id),
        );
        dispatch({ type: "UPSERT_RUN_DETAIL", detail });
        dispatch({
          type: "APPEND_TIMELINE",
          item: {
            id: createTimelineId("run"),
            type: "run",
            timestamp: now(),
            runId: run.run_id,
            state: run.state,
            title: runStateLabel(run.state),
            body: buildRunBody(run),
          },
        });

        if (run.execution_mode !== "immediate") {
          dispatch({
            type: "UPSERT_SCHEDULE",
            card: createScheduleCard(intent, run, timezone),
          });
        }

        if (useMockEvents) {
          const mockEvents = createMockRunEvents(run, plan, state.sessionId);
          const refreshedDetail = await mockGetRun(run.run_id);
          dispatch({ type: "UPSERT_RUN_DETAIL", detail: refreshedDetail });
          mockEvents.forEach((event, index) => {
            window.setTimeout(() => {
              void applyStreamEvent(event);
            }, (index + 1) * 500);
          });
        }
      } else {
        dispatch({ type: "SET_PENDING_INTENT", intent: null });
      }
    },
    [appendAssistantMessage, applyStreamEvent, state.sessionId],
  );

  const sendTurn = useCallback(
    async (text: string, attachments: ComposerAttachment[]) => {
      const userText = text.trim();
      if (!userText && attachments.length === 0) return;
      const normalized = userText.toLowerCase();

      if (
        attachments.length === 0 &&
        (normalized === "confirm" || normalized === "yes" || normalized === "proceed") &&
        state.pendingIntent &&
        (state.pendingIntent.decision === "REQUIRES_CONFIRMATION" ||
          state.activeRun?.state === "awaiting_confirmation")
      ) {
        dispatch({
          type: "APPEND_TIMELINE",
          item: {
            id: createTimelineId("user"),
            type: "user",
            timestamp: now(),
            text: userText,
            attachments: [],
          },
        });
        await confirmPendingIntentRef.current?.();
        return;
      }

      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("user"),
          type: "user",
          timestamp: now(),
          text: userText,
          attachments,
        },
      });
      dispatch({ type: "SET_THINKING", value: true });

      const inputs = [
        ...(userText ? [{ type: "text" as const, text: userText }] : []),
        ...attachments.map((item) => item.part),
      ];

      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const locale = navigator.language;

      const response = await withMockFallback(
        () =>
          apiChatTurn({
            session_id: state.sessionId,
            inputs,
            client_context: {
              timezone,
              locale,
              model: state.selectedModel,
            },
          }),
        () =>
          mockChatTurn({
            session_id: state.sessionId,
            inputs,
            client_context: {
              timezone,
              locale,
              model: state.selectedModel,
            },
          }),
      );

      dispatch({ type: "SET_THINKING", value: false });
      applyIntentResponse(response, timezone);
    },
    [applyIntentResponse, state.activeRun?.state, state.pendingIntent, state.selectedModel, state.sessionId],
  );

  const chooseExecutionMode = useCallback(
    async (
      mode: Exclude<ExecutionMode, "unknown">,
      schedule: { run_at?: string[]; interval_seconds?: number; timezone: string },
    ) => {
      if (!state.pendingIntent) return;
      if (mode === "immediate") {
        dispatch({
          type: "REMOVE_SCHEDULE_BY_INTENT",
          intentId: state.pendingIntent.intent_id,
        });
      }
      dispatch({ type: "SET_THINKING", value: true });

      let response: ResolveExecutionResponse;
      let usedMock = false;
      try {
        response = await apiResolveExecution({
          session_id: state.sessionId,
          intent_id: state.pendingIntent.intent_id,
          execution_mode: mode,
          schedule,
        });
      } catch {
        usedMock = true;
        response = await mockResolveExecution({
          session_id: state.sessionId,
          intent_id: state.pendingIntent.intent_id,
          execution_mode: mode,
          schedule,
        });
      }

      dispatch({ type: "SET_THINKING", value: false });
      await applyResolveResponse(response, state.pendingIntent, schedule.timezone, usedMock);
    },
    [applyResolveResponse, state.pendingIntent, state.sessionId],
  );

  const confirmPendingIntent = useCallback(async () => {
    if (!state.pendingIntent) return;
    dispatch({ type: "SET_THINKING", value: true });

    let response: ConfirmResponse;
    let usedMock = false;
    try {
      response = await apiConfirmIntent({
        session_id: state.sessionId,
        intent_id: state.pendingIntent.intent_id,
        confirmed: true,
      });
    } catch {
      usedMock = true;
      response = await mockConfirm({
        session_id: state.sessionId,
        intent_id: state.pendingIntent.intent_id,
        confirmed: true,
      });
    }

    dispatch({ type: "SET_THINKING", value: false });
    await applyResolveResponse(
      response,
      state.pendingIntent,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      usedMock,
    );
  }, [applyResolveResponse, state.pendingIntent, state.sessionId]);

  useEffect(() => {
    confirmPendingIntentRef.current = confirmPendingIntent;
  }, [confirmPendingIntent]);

  const controlRun = useCallback(
    async (runId: string, action: "pause" | "resume" | "stop" | "retry") => {
      const response = await withMockFallback(
        () =>
          action === "pause"
            ? apiPauseRun(runId)
            : action === "resume"
              ? apiResumeRun(runId)
              : action === "stop"
                ? apiStopRun(runId)
                : apiRetryRun(runId),
        () => mockRunControl(runId, action),
      );

      appendAssistantMessage(response.assistant_message);
      dispatch({ type: "SET_ACTIVE_RUN", run: response.run });
      const detail = await withMockFallback(
        () => apiGetRun(response.run.run_id),
        () => mockGetRun(response.run.run_id),
      );
      dispatch({ type: "UPSERT_RUN_DETAIL", detail });
      dispatch({
        type: "SET_RUN_ACTION_REASON",
        runId,
        reason:
          response.run.state === "waiting_for_user_action"
            ? response.assistant_message.text
            : null,
      });
      const detail = await withMockFallback(
        () => apiGetRun(response.run.run_id),
        () => mockGetRun(response.run.run_id),
      );
      dispatch({ type: "UPSERT_RUN_DETAIL", detail });
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("run-control"),
          type: "run",
          timestamp: now(),
          runId: response.run.run_id,
          state: response.run.state,
          title: runStateLabel(response.run.state),
          body: response.assistant_message.text,
        },
      });
    },
    [appendAssistantMessage],
  );

  useEffect(() => {
    return eventStreamClient.connect(state.sessionId, (event) => {
      void applyStreamEvent(event);
    });
  }, [applyStreamEvent, state.sessionId]);

  const value = useMemo<AssistantContextValue>(
    () => ({
      ...state,
      sendTurn,
      chooseExecutionMode,
      confirmPendingIntent,
      controlRun,
      selectModel: (model: string) => dispatch({ type: "SET_MODEL", model }),
    }),
    [state, sendTurn, chooseExecutionMode, confirmPendingIntent, controlRun],
  );

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistant() {
  const context = useContext(AssistantContext);
  if (!context) {
    throw new Error("useAssistant must be used within AssistantProvider");
  }
  return context;
}
