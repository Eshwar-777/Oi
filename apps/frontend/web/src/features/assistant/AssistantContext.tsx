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
import { useLocation, useSearchParams } from "react-router-dom";
import {
  chatConversationTurn,
  ChatApiError,
  createChatConversation,
  deleteChatConversation,
  getConversationState,
  listChatConversations,
} from "@/api/chat";
import { eventStreamClient } from "@/api/events";
import { listGeminiModels } from "@/api/models";
import { getNotificationPreferences } from "@/api/notificationPreferences";
import { getRun, pauseRun, resumeRun, retryRun, stopRun } from "@/api/runs";
import { useAuth } from "@/features/auth/AuthContext";
import { errorCopy } from "@/features/assistant/uiCopy";
import { buildNotificationRoute, getNotificationBody, shouldNotifyInBrowser } from "@/features/assistant/notificationLogic";
import type {
  AutomationRun,
  AutomationStreamEvent,
  ChatTurnResponse,
  ComposerAttachment,
  ConversationSummary,
  GeminiModelOption,
  RunDetailResponse,
  ScheduleSummaryCard,
  SessionReadinessSummary,
} from "@/domain/automation";
import { notifyUser } from "@/lib/notifications";

interface AssistantContextValue {
  selectedConversationId: string | null;
  conversations: ConversationSummary[];
  sessionId: string;
  sessionReadiness: SessionReadinessSummary | null;
  selectedModel: string;
  modelOptions: GeminiModelOption[];
  timeline: Array<Record<string, unknown>>;
  schedules: ScheduleSummaryCard[];
  activeRun: AutomationRun | null;
  runDetails: Record<string, RunDetailResponse>;
  streamEvents: AutomationStreamEvent[];
  isThinking: boolean;
  errorMessage: string;
  dismissError: () => void;
  sendTurn: (text: string, attachments: ComposerAttachment[]) => Promise<ChatTurnResponse | null>;
  selectModel: (model: string) => void;
  selectConversation: (conversationId: string) => Promise<void>;
  createConversation: (title?: string) => Promise<void>;
  deleteConversation: (conversationId?: string | null) => Promise<void>;
  pauseActiveRun: () => Promise<void>;
  resumeActiveRun: () => Promise<void>;
  stopActiveRun: () => Promise<void>;
  retryActiveRun: () => Promise<void>;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);
const STORAGE_KEY = "oi:web:selected-conversation:v1";
const MAX_NOTIFIED_EVENT_IDS = 100;
const CHAT_CONVERSATION_PARAM = "conversation_id";
const CURATED_MODEL_IDS = ["gemini-2.5-flash", "gemini-2.5-pro"] as const;

function normalizeSelectedModel(
  candidate: string | null | undefined,
  options: GeminiModelOption[],
  defaultModelId?: string | null,
): string {
  const next = (candidate || "auto").trim() || "auto";
  if (next === "auto") return "auto";
  if (options.some((option) => option.id === next)) return next;
  if (defaultModelId && options.some((option) => option.id === defaultModelId)) return defaultModelId;
  return "auto";
}

function curateModelOptions(options: GeminiModelOption[]): GeminiModelOption[] {
  const allowed = new Set<string>(CURATED_MODEL_IDS);
  const curated = options.filter((option) => allowed.has(option.id));
  curated.sort(
    (left, right) =>
      CURATED_MODEL_IDS.indexOf(left.id as (typeof CURATED_MODEL_IDS)[number])
      - CURATED_MODEL_IDS.indexOf(right.id as (typeof CURATED_MODEL_IDS)[number]),
  );
  return curated;
}

function isNewerRun(next: AutomationRun | null, current: AutomationRun | null): boolean {
  if (!next) return false;
  if (!current) return true;
  return (Date.parse(next.updated_at || "") || 0) >= (Date.parse(current.updated_at || "") || 0);
}

function isTerminalRunState(state: string | null | undefined): boolean {
  return state === "completed" || state === "succeeded" || state === "failed" || state === "cancelled";
}

function loadSelectedConversationId() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function isRecoverableConversationError(error: unknown): boolean {
  return (
    error instanceof ChatApiError &&
    (error.status === 404 || error.status === 410 || error.status === 422)
  );
}

function applyRunLifecycleState(
  current: AutomationRun | null,
  event: AutomationStreamEvent,
): AutomationRun | null {
  if (!event.run_id || !current || current.run_id !== event.run_id) {
    return current;
  }
  if (event.type === "run.started") {
    return { ...current, state: "starting", updated_at: event.timestamp };
  }
  if (event.type === "run.paused") {
    return { ...current, state: "paused", updated_at: event.timestamp };
  }
  if (event.type === "run.resumed") {
    return { ...current, state: "running", updated_at: event.timestamp };
  }
  if (event.type === "run.waiting_for_user_action") {
    return { ...current, state: "waiting_for_user_action", updated_at: event.timestamp };
  }
  if (event.type === "run.waiting_for_human") {
    return { ...current, state: "waiting_for_human", updated_at: event.timestamp };
  }
  if (event.type === "run.completed") {
    return { ...current, state: "completed", updated_at: event.timestamp };
  }
  if (event.type === "run.failed") {
    return {
      ...current,
      state: "failed",
      updated_at: event.timestamp,
      last_error: {
        code: event.payload.code,
        message: event.payload.message,
        retryable: event.payload.retryable,
      },
    };
  }
  if (event.type === "run.runtime_incident") {
    return {
      ...current,
      updated_at: event.timestamp,
      runtime_incident: event.payload.incident,
    };
  }
  return current;
}

function shouldRefreshRunFromEvent(event: AutomationStreamEvent): boolean {
  switch (event.type) {
    case "run.browser.snapshot":
    case "run.browser.action":
    case "step.started":
    case "step.progress":
    case "step.completed":
    case "step.failed":
    case "run.iterative_replan":
    case "run.runtime_incident":
    case "run.created":
    case "run.queued":
      return true;
    default:
      return false;
  }
}

const RUN_REFRESH_DEBOUNCE_MS = 300;
const RUN_POLL_INTERVAL_MS = 5000;
const RUN_STREAM_FRESHNESS_MS = 8000;

function mergeConversationSummary(
  current: ConversationSummary[],
  incoming: ConversationSummary,
): ConversationSummary[] {
  const existingIndex = current.findIndex((item) => item.conversation_id === incoming.conversation_id);
  if (existingIndex === -1) {
    return [incoming, ...current].sort(
      (a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0),
    );
  }

  const next = [...current];
  next[existingIndex] = { ...next[existingIndex], ...incoming };
  return next;
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { status } = useAuth();
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(loadSelectedConversationId);
  const [sessionId, setSessionId] = useState("");
  const [sessionReadiness, setSessionReadiness] = useState<SessionReadinessSummary | null>(null);
  const [selectedModel, setSelectedModel] = useState("auto");
  const [modelOptions, setModelOptions] = useState<GeminiModelOption[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [timeline, setTimeline] = useState<Array<Record<string, unknown>>>([]);
  const [schedules, setSchedules] = useState<ScheduleSummaryCard[]>([]);
  const [activeRun, setActiveRun] = useState<AutomationRun | null>(null);
  const [runDetails, setRunDetails] = useState<Record<string, RunDetailResponse>>({});
  const [streamEvents, setStreamEvents] = useState<AutomationStreamEvent[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const notificationPreferencesRef = useRef<{
    browser_enabled: boolean;
    urgency_mode: "all" | "important_only" | "none";
  } | null>(null);
  const notifiedEventIdsRef = useRef<string[]>([]);
  const runDetailsRef = useRef<Record<string, RunDetailResponse>>({});
  const routedConversationId = searchParams.get(CHAT_CONVERSATION_PARAM);
  const initializedRef = useRef(false);
  const initPromiseRef = useRef<Promise<void> | null>(null);
  const refreshPromiseRef = useRef<Promise<ConversationSummary[]> | null>(null);
  const hydratePromisesRef = useRef(new Map<string, Promise<void>>());
  const runRefreshTimersRef = useRef(new Map<string, number>());
  const runRefreshInFlightRef = useRef(new Map<string, Promise<void>>());
  const lastRunStreamAtRef = useRef(new Map<string, number>());

  const persistSelectedConversation = useCallback((conversationId: string | null) => {
    setSelectedConversationId(conversationId);
    if (typeof window !== "undefined") {
      try {
        if (conversationId) {
          window.localStorage.setItem(STORAGE_KEY, conversationId);
        } else {
          window.localStorage.removeItem(STORAGE_KEY);
        }
      } catch {
        // ignore storage failures
      }
    }
  }, []);

  const clearConversationState = useCallback(() => {
    setSessionId("");
    setSessionReadiness(null);
    setTimeline([]);
    setSchedules([]);
    setActiveRun(null);
    setRunDetails({});
    setStreamEvents([]);
    setErrorMessage("");
    setIsThinking(false);
  }, []);

  const hydrateConversation = useCallback(
    async (conversationId: string) => {
      const existing = hydratePromisesRef.current.get(conversationId);
      if (existing) {
        await existing;
        return;
      }
      const pending = (async () => {
        const remote = await getConversationState(conversationId);
        setSessionId(remote.session_id);
        setSessionReadiness(remote.session_readiness);
        setSelectedModel((current) =>
          normalizeSelectedModel(remote.selected_model || current, modelOptions),
        );
        setTimeline(Array.isArray(remote.timeline) ? remote.timeline : []);
        setSchedules(Array.isArray(remote.schedules) ? (remote.schedules as unknown as ScheduleSummaryCard[]) : []);
        setActiveRun((current) => {
          const remoteActive = remote.active_run ?? null;
          return isNewerRun(remoteActive, current) ? remoteActive : current;
        });
        setRunDetails((current) => ({ ...current, ...(remote.run_details ?? {}) }));
        if (remote.conversation_meta) {
          setConversations((current) => mergeConversationSummary(current, remote.conversation_meta!)
          );
        }
      })();
      hydratePromisesRef.current.set(conversationId, pending);
      try {
        await pending;
      } finally {
        hydratePromisesRef.current.delete(conversationId);
      }
    },
    [modelOptions],
  );

  const refreshConversationList = useCallback(async () => {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }
    const pending = (async () => {
      const response = await listChatConversations();
      setConversations(response.items);
      if (!selectedConversationId && response.items[0]) {
        persistSelectedConversation(response.items[0].conversation_id);
      }
      return response.items;
    })();
    refreshPromiseRef.current = pending;
    try {
      return await pending;
    } finally {
      refreshPromiseRef.current = null;
    }
  }, [persistSelectedConversation, selectedConversationId]);

  const refreshRunDetail = useCallback(async (runId: string) => {
    const existing = runRefreshInFlightRef.current.get(runId);
    if (existing) {
      await existing;
      return;
    }
    const pending = (async () => {
      const detail = await getRun(runId);
      setRunDetails((current) => ({ ...current, [runId]: detail }));
      setActiveRun((current) => (isNewerRun(detail.run, current) ? detail.run : current));
    })();
    runRefreshInFlightRef.current.set(runId, pending);
    try {
      await pending;
    } finally {
      runRefreshInFlightRef.current.delete(runId);
    }
  }, []);

  const scheduleRunRefresh = useCallback(
    (runId: string, debounceMs = RUN_REFRESH_DEBOUNCE_MS) => {
      const existingTimer = runRefreshTimersRef.current.get(runId);
      if (existingTimer) {
        window.clearTimeout(existingTimer);
      }
      const timer = window.setTimeout(() => {
        runRefreshTimersRef.current.delete(runId);
        void refreshRunDetail(runId).catch(() => undefined);
      }, debounceMs);
      runRefreshTimersRef.current.set(runId, timer);
    },
    [refreshRunDetail],
  );

  const ensureActiveConversation = useCallback(
    async (preferredConversationId?: string | null) => {
      const items = await listChatConversations();
      setConversations(items.items);
      const fallbackId =
        (preferredConversationId &&
        items.items.some((item) => item.conversation_id === preferredConversationId)
          ? preferredConversationId
          : null) ||
        items.items[0]?.conversation_id ||
        null;
      if (fallbackId) {
        persistSelectedConversation(fallbackId);
        await hydrateConversation(fallbackId);
        return fallbackId;
      }
      const created = await createChatConversation({ title: "New conversation" });
      persistSelectedConversation(created.conversation_id);
      await refreshConversationList();
      await hydrateConversation(created.conversation_id);
      return created.conversation_id;
    },
    [hydrateConversation, persistSelectedConversation, refreshConversationList],
  );

  useEffect(() => {
    let cancelled = false;
    if (status !== "authenticated") return;
    void listGeminiModels()
      .then((response) => {
        if (cancelled) return;
        const curated = curateModelOptions(response.items);
        setModelOptions(curated);
        setSelectedModel((current) =>
          normalizeSelectedModel(current, curated, response.default_model_id),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [status]);

  useEffect(() => {
    if (status !== "authenticated") {
      initializedRef.current = false;
      initPromiseRef.current = null;
      return;
    }
    if (initializedRef.current) return;
    if (initPromiseRef.current) return;
    initPromiseRef.current = (async () => {
      try {
        const items = await refreshConversationList();
        const target = routedConversationId || selectedConversationId || items[0]?.conversation_id || null;
        if (!target) {
          const created = await createChatConversation({ title: "New conversation" });
          persistSelectedConversation(created.conversation_id);
          await hydrateConversation(created.conversation_id);
        } else {
          persistSelectedConversation(target);
          await hydrateConversation(target);
        }
        initializedRef.current = true;
      } catch (error) {
        if (!isRecoverableConversationError(error)) {
          return;
        }
        try {
          await ensureActiveConversation(null);
          initializedRef.current = true;
        } catch {
          // ignore recovery failures here
        }
      } finally {
        initPromiseRef.current = null;
      }
    })();
  }, [ensureActiveConversation, hydrateConversation, persistSelectedConversation, refreshConversationList, selectedConversationId, status, routedConversationId]);

  useEffect(() => {
    if (status !== "authenticated" || !selectedConversationId) return;
    void hydrateConversation(selectedConversationId).catch(async (error) => {
      if (!isRecoverableConversationError(error)) {
        return;
      }
      try {
        await ensureActiveConversation(null);
      } catch {
        // ignore recovery failures here
      }
    });
  }, [ensureActiveConversation, hydrateConversation, selectedConversationId, status]);

  useEffect(() => {
    let cancelled = false;
    if (status !== "authenticated") {
      notificationPreferencesRef.current = null;
      return;
    }
    void getNotificationPreferences()
      .then((preferences) => {
        if (cancelled) return;
        notificationPreferencesRef.current = {
          browser_enabled: preferences.browser_enabled,
          urgency_mode: preferences.urgency_mode,
        };
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [status]);

  useEffect(() => {
    if (location.pathname !== "/chat" || !selectedConversationId) return;
    if (routedConversationId && routedConversationId !== selectedConversationId) return;
    if (searchParams.get(CHAT_CONVERSATION_PARAM) === selectedConversationId) return;
    const next = new URLSearchParams(searchParams);
    next.set(CHAT_CONVERSATION_PARAM, selectedConversationId);
    setSearchParams(next, { replace: true });
  }, [location.pathname, routedConversationId, searchParams, selectedConversationId, setSearchParams]);

  useEffect(() => {
    if (status !== "authenticated" || !activeRun?.run_id || isTerminalRunState(activeRun.state)) return;
    const pollingRunId = activeRun.run_id;
    const timer = window.setInterval(() => {
      const lastStreamAt = lastRunStreamAtRef.current.get(pollingRunId) ?? 0;
      if (Date.now() - lastStreamAt < RUN_STREAM_FRESHNESS_MS) {
        return;
      }
      void refreshRunDetail(pollingRunId).catch(() => undefined);
    }, RUN_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [activeRun?.run_id, activeRun?.state, refreshRunDetail, status]);

  useEffect(() => {
    return () => {
      for (const timer of runRefreshTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      runRefreshTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (status !== "authenticated" || !sessionId) return;
    return eventStreamClient.connect(sessionId, (event) => {
      if (
        event.event_id &&
        shouldNotifyInBrowser(event, notificationPreferencesRef.current) &&
        !notifiedEventIdsRef.current.includes(event.event_id)
      ) {
        const detail = event.run_id ? runDetailsRef.current[event.run_id] : undefined;
        const body = getNotificationBody(event);
        if (body) {
          notifyUser("Automation needs review", body, buildNotificationRoute(event, detail, selectedConversationId));
          notifiedEventIdsRef.current = [...notifiedEventIdsRef.current, event.event_id].slice(-MAX_NOTIFIED_EVENT_IDS);
        }
      }
      setStreamEvents((current) => [...current.slice(-119), event]);
      if (event.type === "assistant.message" && typeof event.payload?.text === "string") {
        setTimeline((current) => [
          ...current,
          {
            id: `${event.event_id}:assistant`,
            type: "assistant",
            text: event.payload.text,
            timestamp: event.timestamp,
          },
        ]);
      }
      if (event.type === "run.runtime_incident") {
        const incident = (event.payload as { incident?: { summary?: string; code?: string } }).incident;
        setErrorMessage(incident?.summary || (incident?.code ? errorCopy(incident.code) : "") || "The run hit an issue.");
      }
      if (event.type === "run.failed") {
        const payload = event.payload as { message?: string; code?: string };
        setErrorMessage(payload.message || (payload.code ? errorCopy(payload.code) : "") || "The run failed.");
      }
      if (event.run_id) {
        lastRunStreamAtRef.current.set(event.run_id, Date.now());
        setActiveRun((current) => applyRunLifecycleState(current, event));
        if (shouldRefreshRunFromEvent(event)) {
          scheduleRunRefresh(event.run_id);
        }
      }
    });
  }, [selectedConversationId,scheduleRunRefresh,sessionId, status]);

  const sendTurn = useCallback(
    async (text: string, attachments: ComposerAttachment[]) => {
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return null;
      setIsThinking(true);
      setErrorMessage("");
      try {
        let targetConversationId = selectedConversationId;
        let targetSessionId = sessionId;
        if (!targetConversationId) {
          targetConversationId = await ensureActiveConversation(null);
          const refreshed = await getConversationState(targetConversationId);
          targetSessionId = refreshed.session_id;
        }
        const request = {
          conversation_id: targetConversationId,
          session_id: targetSessionId,
          inputs: [
            ...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
            ...attachments.map((item) => item.part),
          ],
          client_context: {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            locale: navigator.language || "en-US",
            model: selectedModel === "auto" ? undefined : selectedModel,
          },
        };
        let response: ChatTurnResponse;
        try {
          response = await chatConversationTurn(targetConversationId, request);
        } catch (error) {
          if (!isRecoverableConversationError(error)) {
            throw error;
          }
          targetConversationId = await ensureActiveConversation(null);
          const refreshed = await getConversationState(targetConversationId);
          response = await chatConversationTurn(targetConversationId, {
            ...request,
            conversation_id: targetConversationId,
            session_id: refreshed.session_id,
          });
        }
        await hydrateConversation(targetConversationId);
        await refreshConversationList();
        return response;
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Failed to send message.");
        return null;
      } finally {
        setIsThinking(false);
      }
    },
    [ensureActiveConversation, hydrateConversation, refreshConversationList, selectedConversationId, selectedModel, sessionId],
  );

  const createConversation = useCallback(async (title?: string) => {
    const created = await createChatConversation({ title, model_id: selectedModel === "auto" ? undefined : selectedModel });
    persistSelectedConversation(created.conversation_id);
    await refreshConversationList();
    await hydrateConversation(created.conversation_id);
  }, [hydrateConversation, persistSelectedConversation, refreshConversationList, selectedModel]);

  const selectConversation = useCallback(async (conversationId: string) => {
    persistSelectedConversation(conversationId);
    await hydrateConversation(conversationId);
  }, [hydrateConversation, persistSelectedConversation]);

  const deleteConversation = useCallback(async (conversationId?: string | null) => {
    const targetConversationId = conversationId ?? selectedConversationId;
    setErrorMessage("");

    if (!targetConversationId) {
      persistSelectedConversation(null);
      clearConversationState();
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete(CHAT_CONVERSATION_PARAM);
      setSearchParams(nextParams, { replace: true });
      return;
    }

    try {
      await deleteChatConversation(targetConversationId);
    } catch (error) {
      if (!isRecoverableConversationError(error)) {
        setErrorMessage(error instanceof Error ? error.message : "Failed to delete conversation.");
        return;
      }
    }

    hydratePromisesRef.current.delete(targetConversationId);
    const nextConversations = conversations.filter((item) => item.conversation_id !== targetConversationId);
    setConversations(nextConversations);

    if (selectedConversationId !== targetConversationId) {
      return;
    }

    const fallbackId = nextConversations[0]?.conversation_id ?? null;
    persistSelectedConversation(fallbackId);
    if (!fallbackId) {
      clearConversationState();
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete(CHAT_CONVERSATION_PARAM);
      setSearchParams(nextParams, { replace: true });
      return;
    }

    await hydrateConversation(fallbackId);
  }, [
    clearConversationState,
    conversations,
    hydrateConversation,
    persistSelectedConversation,
    searchParams,
    selectedConversationId,
    setSearchParams,
  ]);

  const mutateActiveRun = useCallback(
    async (action: "pause" | "resume" | "stop" | "retry") => {
      if (!activeRun?.run_id) return;
      setErrorMessage("");
      try {
        const response =
          action === "pause"
            ? await pauseRun(activeRun.run_id)
            : action === "resume"
              ? await resumeRun(activeRun.run_id)
              : action === "stop"
                ? await stopRun(activeRun.run_id)
                : await retryRun(activeRun.run_id, {
                    browserSessionId: activeRun.browser_session_id ?? null,
                  });
        setActiveRun(response.run);
        const detail = await getRun(response.run.run_id);
        setRunDetails((current) => ({ ...current, [response.run.run_id]: detail }));
        if (selectedConversationId) {
          await hydrateConversation(selectedConversationId);
          await refreshConversationList();
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : `Failed to ${action} run.`);
      }
    },
    [activeRun, hydrateConversation, refreshConversationList, selectedConversationId],
  );

  const value = useMemo<AssistantContextValue>(
    () => ({
      selectedConversationId,
      conversations,
      sessionId,
      sessionReadiness,
      selectedModel,
      modelOptions,
      timeline,
      schedules,
      activeRun,
      runDetails,
      streamEvents,
      isThinking,
      errorMessage,
      dismissError: () => setErrorMessage(""),
      sendTurn,
      selectModel: setSelectedModel,
      selectConversation,
      createConversation,
      deleteConversation,
      pauseActiveRun: () => mutateActiveRun("pause"),
      resumeActiveRun: () => mutateActiveRun("resume"),
      stopActiveRun: () => mutateActiveRun("stop"),
      retryActiveRun: () => mutateActiveRun("retry"),
    }),
    [
      activeRun,
      conversations,
      createConversation,
      deleteConversation,
      errorMessage,
      isThinking,
      modelOptions,
      mutateActiveRun,
      runDetails,
      schedules,
      selectConversation,
      selectedConversationId,
      selectedModel,
      sendTurn,
      sessionId,
      sessionReadiness,
      streamEvents,
      timeline,
    ],
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
