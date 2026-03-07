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
  assistantReducer,
  createTimelineId,
  initialState,
  now,
  type AssistantAction,
  type AssistantState,
} from "./store/assistantStore";

interface AssistantContextValue extends AssistantState {
  prepareTurn: (text: string, attachments: ComposerAttachment[]) => Promise<void>;
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

export function AssistantProvider({ children }: { children: ReactNode }) {
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
    async (runId: string, action: "pause" | "resume" | "stop" | "retry") => {
      const result = await commandService.controlRun(runId, action);
      appendAssistantMessage(result.payload.assistant_message);
      dispatch({ type: "SET_ACTIVE_RUN", run: result.payload.run });
      await refreshRunDetail(result.payload.run.run_id);
      dispatch({
        type: "SET_RUN_ACTION_REASON",
        runId,
        reason:
          result.payload.run.state === "waiting_for_user_action"
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
