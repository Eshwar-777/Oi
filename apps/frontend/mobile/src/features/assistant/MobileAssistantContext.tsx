import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  type AutomationRun,
  type AutomationStep,
  type AutomationStreamEvent,
  getChatSessionState,
  getRun,
  type IntentDraft,
  listRunEvents,
  type RunEventRecord,
  type RunDetailResponse,
  type ScheduleSummaryCard,
} from "@/lib/automation";
import { connectEventStream } from "@/lib/eventStream";
import { loadPersistedJson, savePersistedJson } from "@/features/assistant/persistence";

export type TimelineMessage =
  | { id: string; role: "user"; text: string; timestamp: string }
  | { id: string; role: "assistant"; text: string; timestamp: string };

export interface NotificationContext {
  route: string | null;
  runId: string | null;
  browserSessionId: string | null;
  eventType: string | null;
  reasonCode: string | null;
  incidentCode: string | null;
  receivedAt: string;
}

export interface RunEventSummary {
  runId: string;
  latestReplanEvent: RunEventRecord | null;
  latestIncidentEvent: RunEventRecord | null;
  updatedAt: string;
}

interface PersistedChatState {
  sessionId: string;
  messages: TimelineMessage[];
  pendingIntent: IntentDraft | null;
  activeRun: AutomationRun | null;
  runDetail: RunDetailResponse | null;
  runReason: string;
  schedules: ScheduleSummaryCard[];
  notificationContext: NotificationContext | null;
  runEventSummaries: Record<string, RunEventSummary>;
  runStatesById: Record<string, string>;
}

interface MobileAssistantContextValue {
  sessionId: string;
  hasHydrated: boolean;
  streamStatus: "syncing" | "live" | "reconnecting";
  messages: TimelineMessage[];
  pendingIntent: IntentDraft | null;
  activeRun: AutomationRun | null;
  runDetail: RunDetailResponse | null;
  runReason: string;
  schedules: ScheduleSummaryCard[];
  notificationContext: NotificationContext | null;
  runEventSummaries: Record<string, RunEventSummary>;
  runStatesById: Record<string, string>;
  setPendingIntent: (intent: IntentDraft | null) => void;
  setActiveRun: (run: AutomationRun | null) => void;
  setRunDetail: (detail: RunDetailResponse | null) => void;
  setRunReason: (reason: string) => void;
  replaceSchedules: (items: ScheduleSummaryCard[]) => void;
  appendUserMessage: (text: string) => void;
  appendAssistantMessage: (text: string, options?: { timestamp?: string; id?: string }) => void;
  patchActiveRun: (runId: string, patch: Partial<AutomationRun>) => void;
  patchRunStep: (runId: string, stepId: string, patch: Partial<AutomationStep>) => void;
  hydrateRemoteState: () => Promise<void>;
  refreshRunDetail: (runId: string) => Promise<RunDetailResponse | null>;
  setNotificationContext: (context: NotificationContext | null) => void;
  refreshRunEventSummary: (runId: string) => Promise<RunEventSummary | null>;
}

const MobileAssistantContext = createContext<MobileAssistantContextValue | null>(null);

function createSessionId() {
  return `mobile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function createTimelineId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function MobileAssistantProvider({ children }: { children: ReactNode }) {
  const [sessionId, setSessionId] = useState(createSessionId());
  const [hasHydrated, setHasHydrated] = useState(false);
  const [streamStatus, setStreamStatus] = useState<"syncing" | "live" | "reconnecting">("syncing");
  const [messages, setMessages] = useState<TimelineMessage[]>([]);
  const [pendingIntent, setPendingIntent] = useState<IntentDraft | null>(null);
  const [activeRun, setActiveRun] = useState<AutomationRun | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetailResponse | null>(null);
  const [runReason, setRunReason] = useState("");
  const [schedules, setSchedules] = useState<ScheduleSummaryCard[]>([]);
  const [notificationContext, setNotificationContext] = useState<NotificationContext | null>(null);
  const [runEventSummaries, setRunEventSummaries] = useState<Record<string, RunEventSummary>>({});
  const [runStatesById, setRunStatesById] = useState<Record<string, string>>({});
  const persistTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runDetailRefreshTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const appendUserMessage = useCallback((text: string) => {
    setMessages((current) => [
      ...current,
      { id: createTimelineId("user"), role: "user", text, timestamp: nowLabel() },
    ]);
  }, []);

  const appendAssistantMessage = useCallback((
    text: string,
    options?: { timestamp?: string; id?: string },
  ) => {
    setMessages((current) => [
      ...current,
      {
        id: options?.id ?? createTimelineId("assistant"),
        role: "assistant",
        text,
        timestamp: options?.timestamp
          ? new Date(options.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : nowLabel(),
      },
    ]);
  }, []);

  const patchActiveRun = useCallback((runId: string, patch: Partial<AutomationRun>) => {
    setActiveRun((current) => (current?.run_id === runId ? { ...current, ...patch } : current));
    if (patch.state) {
      setRunStatesById((current) => ({ ...current, [runId]: patch.state as string }));
    }
    setRunDetail((current) =>
      current?.run.run_id === runId
        ? {
            ...current,
            run: {
              ...current.run,
              ...patch,
            },
          }
        : current,
    );
  }, []);

  const patchRunStep = useCallback((runId: string, stepId: string, patch: Partial<AutomationStep>) => {
    setRunDetail((current) =>
      current?.run.run_id === runId
        ? {
            ...current,
            plan: {
              ...current.plan,
              steps: current.plan.steps.map((step) =>
                step.step_id === stepId ? { ...step, ...patch } : step,
              ),
            },
          }
        : current,
    );
  }, []);

  const refreshRunDetail = useCallback(async (runId: string) => {
    try {
      const detail = await getRun(runId);
      setRunDetail(detail);
      setActiveRun(detail.run);
      setRunStatesById((current) => ({ ...current, [runId]: detail.run.state }));
      return detail;
    } catch {
      return null;
    }
  }, []);

  const scheduleRunDetailRefresh = useCallback((runId: string, delay = 300) => {
    if (runDetailRefreshTimersRef.current[runId]) return;
    runDetailRefreshTimersRef.current[runId] = setTimeout(() => {
      delete runDetailRefreshTimersRef.current[runId];
      void refreshRunDetail(runId);
    }, delay);
  }, [refreshRunDetail]);

  const replaceSchedules = useCallback((items: ScheduleSummaryCard[]) => {
    setSchedules(items);
  }, []);

  const patchScheduleCard = useCallback((scheduleId: string, patch: Partial<ScheduleSummaryCard>) => {
    let found = false;
    setSchedules((current) =>
      current.map((item) => {
        if (item.schedule_id !== scheduleId) return item;
        found = true;
        return { ...item, ...patch };
      }),
    );
    return found;
  }, []);

  const upsertRunEventSummary = useCallback((runId: string, patch: Partial<RunEventSummary>) => {
    setRunEventSummaries((current) => {
      const existing = current[runId] ?? {
        runId,
        latestReplanEvent: null,
        latestIncidentEvent: null,
        updatedAt: new Date().toISOString(),
      };
      return {
        ...current,
        [runId]: {
          ...existing,
          ...patch,
          updatedAt: patch.updatedAt ?? new Date().toISOString(),
        },
      };
    });
  }, []);

  const refreshRunEventSummary = useCallback(async (runId: string) => {
    try {
      const items = await listRunEvents(runId);
      const latestReplanEvent = [...items].reverse().find((item) => item.type === "run.iterative_replan") ?? null;
      const latestIncidentEvent = [...items].reverse().find((item) => item.type === "run.runtime_incident") ?? null;
      const summary: RunEventSummary = {
        runId,
        latestReplanEvent,
        latestIncidentEvent,
        updatedAt: new Date().toISOString(),
      };
      setRunEventSummaries((current) => ({ ...current, [runId]: summary }));
      return summary;
    } catch {
      return null;
    }
  }, []);

  const hydrateRemoteState = useCallback(async () => {
    try {
      const state = await getChatSessionState(sessionId);
      setPendingIntent(null);
      setActiveRun(state.active_run ?? null);
      setRunStatesById((current) => {
        const next = { ...current };
        if (state.active_run?.run_id && state.active_run.state) {
          next[state.active_run.run_id] = state.active_run.state;
        }
        for (const [runId, detail] of Object.entries(state.run_details ?? {})) {
          if (detail?.run?.state) {
            next[runId] = detail.run.state;
          }
        }
        return next;
      });
      setRunReason("");
      setSchedules(
        Array.isArray(state.schedules) ? (state.schedules as unknown as ScheduleSummaryCard[]) : [],
      );
      if (state.active_run?.run_id && state.run_details[state.active_run.run_id]) {
        setRunDetail(state.run_details[state.active_run.run_id] ?? null);
      } else {
        setRunDetail(null);
      }
    } catch {
      // Ignore remote hydration failures to keep the app usable during backend restarts.
    }
  }, [sessionId]);

  useEffect(() => {
    let active = true;
    void loadPersistedJson<PersistedChatState | null>(null)
      .then((persisted) => {
        if (!active || !persisted) return;
        setSessionId(persisted.sessionId || createSessionId());
        setMessages(Array.isArray(persisted.messages) ? persisted.messages : []);
        setPendingIntent(persisted.pendingIntent ?? null);
        setActiveRun(persisted.activeRun ?? null);
        setRunDetail(persisted.runDetail ?? null);
        setRunReason(typeof persisted.runReason === "string" ? persisted.runReason : "");
        setSchedules(Array.isArray(persisted.schedules) ? persisted.schedules : []);
        setNotificationContext(persisted.notificationContext ?? null);
        setRunEventSummaries(
          persisted.runEventSummaries && typeof persisted.runEventSummaries === "object"
            ? persisted.runEventSummaries
            : {},
        );
        setRunStatesById(
          persisted.runStatesById && typeof persisted.runStatesById === "object"
            ? persisted.runStatesById
            : {},
        );
      })
      .finally(() => {
        if (active) setHasHydrated(true);
      });

    return () => {
      active = false;
      if (persistTimeoutRef.current) {
        clearTimeout(persistTimeoutRef.current);
        persistTimeoutRef.current = null;
      }
      for (const timer of Object.values(runDetailRefreshTimersRef.current)) {
        clearTimeout(timer);
      }
      runDetailRefreshTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    if (!hasHydrated) return;
    if (persistTimeoutRef.current) {
      clearTimeout(persistTimeoutRef.current);
    }
    persistTimeoutRef.current = setTimeout(() => {
      void savePersistedJson<PersistedChatState>({
        sessionId,
        messages,
        pendingIntent,
        activeRun,
        runDetail,
        runReason,
        schedules,
        notificationContext,
        runEventSummaries,
        runStatesById,
      });
    }, 1000);
  }, [activeRun, hasHydrated, messages, notificationContext, pendingIntent, runDetail, runEventSummaries, runReason, runStatesById, schedules, sessionId]);

  const applyStreamEvent = useCallback(async (event: AutomationStreamEvent) => {
    setStreamStatus("live");

    if (event.type === "assistant.message") {
      appendAssistantMessage(event.payload.text, {
        timestamp: event.timestamp,
        id: event.payload.message_id,
      });
      return;
    }

    if (event.type === "run.created") {
      setActiveRun(event.payload.run);
      setRunStatesById((current) => ({ ...current, [event.payload.run.run_id]: event.payload.run.state }));
      if (runDetail?.run.run_id !== event.payload.run.run_id) {
        scheduleRunDetailRefresh(event.payload.run.run_id, 200);
      }
      void refreshRunEventSummary(event.payload.run.run_id);
      return;
    }

    if (event.type === "schedule.created") {
      const found = patchScheduleCard(event.payload.schedule_id, {
        status: "scheduled",
        run_times: event.payload.run_times,
      });
      if (!found) {
        void hydrateRemoteState();
      }
      return;
    }

    if (event.type === "run.queued") {
      patchActiveRun(event.payload.run_id, { state: "queued", updated_at: event.timestamp });
      appendAssistantMessage("Run queued. The automation will start shortly.", {
        timestamp: event.timestamp,
        id: event.event_id,
      });
      return;
    }

    if (event.type === "run.started" || event.type === "run.resumed") {
      patchActiveRun(event.payload.run_id, { state: "running", updated_at: event.timestamp });
      setRunReason("");
      return;
    }

    if (event.type === "run.paused") {
      patchActiveRun(event.payload.run_id, { state: "paused", updated_at: event.timestamp });
      setRunReason(event.payload.reason);
      appendAssistantMessage(event.payload.reason, {
        timestamp: event.timestamp,
        id: event.event_id,
      });
      return;
    }

    if (event.type === "run.waiting_for_user_action") {
      patchActiveRun(event.payload.run_id, { state: "waiting_for_user_action", updated_at: event.timestamp });
      setRunReason(event.payload.reason);
      appendAssistantMessage(event.payload.reason, {
        timestamp: event.timestamp,
        id: event.event_id,
      });
      return;
    }

    if (event.type === "run.waiting_for_human") {
      patchActiveRun(event.payload.run_id, { state: "waiting_for_human", updated_at: event.timestamp });
      setRunReason(event.payload.reason);
      appendAssistantMessage(event.payload.reason, {
        timestamp: event.timestamp,
        id: event.event_id,
      });
      return;
    }

    if (event.type === "run.completed") {
      patchActiveRun(event.payload.run_id, { state: "completed", updated_at: event.timestamp });
      appendAssistantMessage(event.payload.message, {
        timestamp: event.timestamp,
        id: event.event_id,
      });
      return;
    }

    if (event.type === "run.failed") {
      patchActiveRun(event.payload.run_id, {
        state: "failed",
        updated_at: event.timestamp,
        last_error: {
          code: event.payload.code,
          message: event.payload.message,
          retryable: event.payload.retryable,
        },
      });
      appendAssistantMessage(event.payload.message, {
        timestamp: event.timestamp,
        id: event.event_id,
      });
      return;
    }

    if (event.type === "run.interrupted_by_user") {
      patchActiveRun(event.payload.run_id, { state: "paused", updated_at: event.timestamp });
      appendAssistantMessage(event.payload.message, {
        timestamp: event.timestamp,
        id: event.event_id,
      });
      return;
    }

    if (event.type === "run.iterative_replan") {
      upsertRunEventSummary(event.payload.run_id, {
        latestReplanEvent: {
          event_id: event.event_id,
          run_id: event.payload.run_id,
          type: event.type,
          created_at: event.timestamp,
          payload: event.payload,
        },
      });
      appendAssistantMessage(
        `Replanning after ${event.payload.completed_command}. Next: ${event.payload.next_command}.`,
        { timestamp: event.timestamp, id: event.event_id },
      );
      if (runDetail?.run.run_id === event.payload.run_id || activeRun?.run_id === event.payload.run_id) {
        scheduleRunDetailRefresh(event.payload.run_id, 800);
      }
      return;
    }

    if (event.type === "run.runtime_incident") {
      upsertRunEventSummary(event.payload.run_id, {
        latestIncidentEvent: {
          event_id: event.event_id,
          run_id: event.payload.run_id,
          type: event.type,
          created_at: event.timestamp,
          payload: event.payload,
        },
      });
      return;
    }

    if (event.type === "step.started") {
      patchActiveRun(event.payload.run_id, {
        state: "running",
        updated_at: event.timestamp,
        current_step_index: event.payload.index,
      });
      patchRunStep(event.payload.run_id, event.payload.step_id, {
        status: "running",
        started_at: event.timestamp,
      });
      return;
    }

    if (event.type === "step.progress") {
      patchRunStep(event.payload.run_id, event.payload.step_id, { status: "running" });
      return;
    }

    if (event.type === "step.completed") {
      patchRunStep(event.payload.run_id, event.payload.step_id, {
        status: "completed",
        completed_at: event.timestamp,
        screenshot_url: event.payload.screenshot_url ?? undefined,
      });
      patchActiveRun(event.payload.run_id, {
        updated_at: event.timestamp,
        current_step_index: event.payload.index + 1,
      });
      return;
    }

    if (event.type === "step.failed") {
      patchRunStep(event.payload.run_id, event.payload.step_id, {
        status: "failed",
        error_code: event.payload.code,
        error_message: event.payload.message,
      });
      patchActiveRun(event.payload.run_id, {
        state: "failed",
        updated_at: event.timestamp,
        last_error: {
          code: event.payload.code,
          message: event.payload.message,
          retryable: event.payload.retryable,
        },
      });
    }
  }, [activeRun?.run_id, appendAssistantMessage, hydrateRemoteState, patchActiveRun, patchRunStep, patchScheduleCard, refreshRunEventSummary, runDetail?.run.run_id, scheduleRunDetailRefresh, upsertRunEventSummary]);

  useEffect(() => {
    if (!hasHydrated || !sessionId) return () => undefined;
    setStreamStatus("syncing");
    return connectEventStream({
      sessionId,
      onEvent: (event) => {
        void applyStreamEvent(event);
      },
      onError: () => {
        setStreamStatus("reconnecting");
      },
    });
  }, [applyStreamEvent, hasHydrated, sessionId]);

  const value = useMemo<MobileAssistantContextValue>(
    () => ({
      sessionId,
      hasHydrated,
      streamStatus,
      messages,
      pendingIntent,
      activeRun,
      runDetail,
      runReason,
      schedules,
      notificationContext,
      runEventSummaries,
      runStatesById,
      setPendingIntent,
      setActiveRun,
      setRunDetail,
      setRunReason,
      replaceSchedules,
      appendUserMessage,
      appendAssistantMessage,
      patchActiveRun,
      patchRunStep,
      hydrateRemoteState,
      refreshRunDetail,
      setNotificationContext,
      refreshRunEventSummary,
    }),
    [
      sessionId,
      hasHydrated,
      streamStatus,
      messages,
      pendingIntent,
      activeRun,
      runDetail,
      runReason,
      schedules,
      notificationContext,
      runEventSummaries,
      runStatesById,
      replaceSchedules,
      appendUserMessage,
      appendAssistantMessage,
      patchActiveRun,
      patchRunStep,
      hydrateRemoteState,
      refreshRunDetail,
      setNotificationContext,
      refreshRunEventSummary,
    ],
  );

  return <MobileAssistantContext.Provider value={value}>{children}</MobileAssistantContext.Provider>;
}

export function useMobileAssistant() {
  const value = useContext(MobileAssistantContext);
  if (!value) {
    throw new Error("useMobileAssistant must be used within MobileAssistantProvider");
  }
  return value;
}
