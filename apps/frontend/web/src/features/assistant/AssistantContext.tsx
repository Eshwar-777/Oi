import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import type { Dispatch, ReactNode } from "react";
import { eventStreamClient } from "@/api/events";
import type {
  ComposerAttachment,
  ConfirmResponse,
  ExecutionMode,
  IntentDraft,
  ResolveExecutionResponse,
} from "@/domain/automation";
import { createEventProjector } from "./projection/eventProjector";
import { commandService } from "./services/commandService";
import {
  createMockRunEvents,
  mockChatTurn,
  mockConfirm,
  mockGetRun,
  mockResolveExecution,
  mockRunControl,
} from "@/mocks/automationMock";
import { decisionLabel, errorCopy, runStateLabel } from "./uiCopy";
import { useAuth } from "@/features/auth/AuthContext";

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
  modelOptions: GeminiModelOption[];
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
  | { type: "SET_MODEL_OPTIONS"; items: GeminiModelOption[] }
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
};

function assistantReducer(state: AssistantState, action: AssistantAction): AssistantState {
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
  prepareTurn: (text: string, attachments: ComposerAttachment[]) => Promise<void>;
  sendTurn: (text: string, attachments: ComposerAttachment[]) => Promise<void>;
  chooseExecutionMode: (
    mode: Exclude<ExecutionMode, "unknown">,
    schedule: { run_at?: string[]; interval_seconds?: number; timezone: string },
  ) => Promise<void>;
  confirmPendingIntent: () => Promise<void>;
  controlRun: (runId: string, action: "pause" | "resume" | "stop" | "retry" | "approve") => Promise<void>;
  selectModel: (model: string) => void;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const [state, dispatch] = useReducer(assistantReducer, initialState);
  const stateRef = useRef(state);
  const confirmPendingIntentRef = useRef<(() => Promise<void>) | null>(null);
  const lastPreparedDraftRef = useRef("");
  const prepareAbortRef = useRef<AbortController | null>(null);
  const prepareSequenceRef = useRef(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const appendAssistantMessage = useCallback((message: { message_id: string; text: string }) => {
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

  const refreshRunDetail = useCallback(async (runId: string) => {
    const result = await commandService.getRun(runId);
    dispatch({ type: "UPSERT_RUN_DETAIL", detail: result.payload });
    return result.payload;
  }, []);

  const projector = useMemo(
    () =>
      createEventProjector({
        appendAssistantMessage,
        dispatch: dispatch as Dispatch<AssistantAction>,
        refreshRunDetail,
        sessionId: state.sessionId,
        stateRef,
      }),
    [appendAssistantMessage, refreshRunDetail, state.sessionId],
  );

  useEffect(() => {
    let cancelled = false;

    void commandService
      .listModels()
      .then((response) => {
        if (cancelled || response.items.length === 0) return;
        dispatch({ type: "SET_MODEL_OPTIONS", items: response.items });
        if (
          stateRef.current.selectedModel === "auto" &&
          response.default_model_id &&
          response.items.some((item) => item.id === response.default_model_id)
        ) {
          dispatch({ type: "SET_MODEL", model: response.default_model_id });
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const prepareTurn = useCallback(
    async (text: string, attachments: ComposerAttachment[]) => {
      const userText = text.trim();
      const inputs = [
        ...(userText ? [{ type: "text" as const, text: userText }] : []),
        ...attachments.map((item) => item.part),
      ];
      if (inputs.length === 0) {
        prepareAbortRef.current?.abort();
        prepareAbortRef.current = null;
        lastPreparedDraftRef.current = "";
        dispatch({ type: "SET_PREPARED_TURN_TOKEN", token: null });
        dispatch({ type: "SET_PREPARED_ATTACHMENT_WARNING", message: null });
        return;
      }

      const draftKey = JSON.stringify(inputs);
      if (draftKey === lastPreparedDraftRef.current) return;

      prepareAbortRef.current?.abort();
      const controller = new AbortController();
      prepareAbortRef.current = controller;
      const sequence = prepareSequenceRef.current + 1;
      prepareSequenceRef.current = sequence;

      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const locale = navigator.language;
      try {
        const result = await commandService.prepareTurn(
          {
            session_id: state.sessionId,
            partial_inputs: inputs,
            client_context: {
              timezone,
              locale,
              model: state.selectedModel,
            },
          },
          { signal: controller.signal },
        );
        if (prepareSequenceRef.current !== sequence) return;
        lastPreparedDraftRef.current = draftKey;
        dispatch({ type: "SET_PREPARED_TURN_TOKEN", token: result.payload.prepare_token });
        dispatch({
          type: "SET_PREPARED_ATTACHMENT_WARNING",
          message: result.payload.attachment_warning ?? null,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        throw error;
      } finally {
        if (prepareAbortRef.current === controller) {
          prepareAbortRef.current = null;
        }
      }
    },
    [state.selectedModel, state.sessionId],
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
      prepareAbortRef.current?.abort();
      prepareAbortRef.current = null;
      prepareSequenceRef.current += 1;
      dispatch({ type: "SET_PREPARED_ATTACHMENT_WARNING", message: null });

      const inputs = [
        ...(userText ? [{ type: "text" as const, text: userText }] : []),
        ...attachments.map((item) => item.part),
      ];

      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const locale = navigator.language;
      const result = await commandService.sendTurn({
        session_id: state.sessionId,
        inputs,
        prepare_token: stateRef.current.preparedTurnToken ?? undefined,
        client_context: {
          timezone,
          locale,
          model: state.selectedModel,
        },
      });

      dispatch({ type: "SET_THINKING", value: false });
      dispatch({ type: "SET_PREPARED_TURN_TOKEN", token: null });
      dispatch({ type: "SET_PREPARED_ATTACHMENT_WARNING", message: null });
      lastPreparedDraftRef.current = "";
      await projector.applyIntentResponse(result.payload, timezone);
    },
    [projector, state.activeRun?.state, state.pendingIntent, state.selectedModel, state.sessionId],
  );

  const chooseExecutionMode = useCallback(
    async (
      mode: Exclude<ExecutionMode, "unknown">,
      schedule: { run_at?: string[]; interval_seconds?: number; timezone: string },
    ) => {
      if (!state.pendingIntent) return;
      const currentIntent = state.pendingIntent;
      if (mode === "immediate") {
        dispatch({ type: "REMOVE_SCHEDULE_BY_INTENT", intentId: currentIntent.intent_id });
      }
      dispatch({ type: "SET_PENDING_INTENT", intent: null });
      dispatch({ type: "SET_THINKING", value: true });

      const result = await commandService.resolveExecution({
        session_id: state.sessionId,
        intent_id: currentIntent.intent_id,
        execution_mode: mode,
        schedule,
      });

      dispatch({ type: "SET_THINKING", value: false });
      await projector.applyResolveResponse(
        result.payload as ResolveExecutionResponse,
        currentIntent,
        schedule.timezone,
        result.source === "mock",
      );
    },
    [projector, state.pendingIntent, state.sessionId],
  );

  const confirmPendingIntent = useCallback(async () => {
    if (!state.pendingIntent) return;
    const currentIntent = state.pendingIntent;
    dispatch({ type: "SET_PENDING_INTENT", intent: null });
    dispatch({ type: "SET_THINKING", value: true });

    const result = await commandService.confirmIntent({
      session_id: state.sessionId,
      intent_id: currentIntent.intent_id,
      confirmed: true,
    });

    dispatch({ type: "SET_THINKING", value: false });
    await projector.applyResolveResponse(
      result.payload as ConfirmResponse,
      currentIntent,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      result.source === "mock",
    );
  }, [projector, state.pendingIntent, state.sessionId]);

  useEffect(() => {
    confirmPendingIntentRef.current = confirmPendingIntent;
  }, [confirmPendingIntent]);

  const controlRun = useCallback(
    async (runId: string, action: "pause" | "resume" | "stop" | "retry" | "approve") => {
      const result = await commandService.controlRun(runId, action);
      appendAssistantMessage(result.payload.assistant_message);
      dispatch({ type: "SET_ACTIVE_RUN", run: result.payload.run });
      await refreshRunDetail(result.payload.run.run_id);
      dispatch({
        type: "SET_RUN_ACTION_REASON",
        runId,
        reason:
          result.payload.run.state === "waiting_for_user_action" || result.payload.run.state === "waiting_for_human"
            ? result.payload.assistant_message.text
            : null,
      });
      dispatch({
        type: "APPEND_TIMELINE",
        item: {
          id: createTimelineId("run-control"),
          type: "run",
          timestamp: now(),
          runId: result.payload.run.run_id,
          state: result.payload.run.state,
          title: result.payload.assistant_message.text,
          body: result.payload.assistant_message.text,
        },
      });
    },
    [appendAssistantMessage, refreshRunDetail],
  );

  useEffect(() => {
    if (status !== "authenticated") {
      return () => undefined;
    }
    return eventStreamClient.connect(state.sessionId, (event) => {
      void projector.applyStreamEvent(event);
    });
  }, [projector, state.sessionId]);

  const value = useMemo<AssistantContextValue>(
    () => ({
      ...state,
      prepareTurn,
      sendTurn,
      chooseExecutionMode,
      confirmPendingIntent,
      controlRun,
      selectModel: (model: string) => dispatch({ type: "SET_MODEL", model }),
    }),
    [state, prepareTurn, sendTurn, chooseExecutionMode, confirmPendingIntent, controlRun],
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
