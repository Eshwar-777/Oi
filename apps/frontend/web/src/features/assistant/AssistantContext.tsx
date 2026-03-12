import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  chatConversationTurn,
  createChatConversation,
  getConversationState,
  listChatConversations,
} from "@/api/chat";
import { eventStreamClient } from "@/api/events";
import { listGeminiModels } from "@/api/models";
import { getRun, pauseRun, resumeRun, retryRun, stopRun } from "@/api/runs";
import { useAuth } from "@/features/auth/AuthContext";
import type {
  AutomationRun,
  AutomationStreamEvent,
  ComposerAttachment,
  ConversationSummary,
  GeminiModelOption,
  RunDetailResponse,
  ScheduleSummaryCard,
  SessionReadinessSummary,
} from "@/domain/automation";

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
  sendTurn: (text: string, attachments: ComposerAttachment[]) => Promise<void>;
  selectModel: (model: string) => void;
  selectConversation: (conversationId: string) => Promise<void>;
  createConversation: (title?: string) => Promise<void>;
  pauseActiveRun: () => Promise<void>;
  resumeActiveRun: () => Promise<void>;
  stopActiveRun: () => Promise<void>;
  retryActiveRun: () => Promise<void>;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);
const STORAGE_KEY = "oi:web:selected-conversation:v1";

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

function isNewerRun(next: AutomationRun | null, current: AutomationRun | null): boolean {
  if (!next) return false;
  if (!current) return true;
  return (Date.parse(next.updated_at || "") || 0) >= (Date.parse(current.updated_at || "") || 0);
}

function loadSelectedConversationId() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function AssistantProvider({ children }: { children: ReactNode }) {
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

  const hydrateConversation = useCallback(
    async (conversationId: string) => {
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
        setConversations((current) => {
          const next = current.filter((item) => item.conversation_id !== remote.conversation_meta?.conversation_id);
          return [remote.conversation_meta!, ...next].sort(
            (a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0),
          );
        });
      }
    },
    [modelOptions],
  );

  const refreshConversationList = useCallback(async () => {
    const response = await listChatConversations();
    setConversations(response.items);
    if (!selectedConversationId && response.items[0]) {
      persistSelectedConversation(response.items[0].conversation_id);
    }
    return response.items;
  }, [persistSelectedConversation, selectedConversationId]);

  useEffect(() => {
    let cancelled = false;
    if (status !== "authenticated") return;
    void listGeminiModels()
      .then((response) => {
        if (cancelled) return;
        setModelOptions(response.items);
        setSelectedModel((current) =>
          normalizeSelectedModel(current, response.items, response.default_model_id),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [status]);

  useEffect(() => {
    if (status !== "authenticated") return;
    void refreshConversationList()
      .then(async (items) => {
        const target = selectedConversationId || items[0]?.conversation_id || null;
        if (!target) {
          const created = await createChatConversation({ title: "New conversation" });
          persistSelectedConversation(created.conversation_id);
          await hydrateConversation(created.conversation_id);
          return;
        }
        persistSelectedConversation(target);
        await hydrateConversation(target);
      })
      .catch(() => undefined);
  }, [hydrateConversation, persistSelectedConversation, refreshConversationList, selectedConversationId, status]);

  useEffect(() => {
    if (status !== "authenticated" || !selectedConversationId) return;
    void hydrateConversation(selectedConversationId).catch(() => undefined);
  }, [hydrateConversation, selectedConversationId, status]);

  useEffect(() => {
    if (status !== "authenticated" || !activeRun?.run_id) return;
    const pollingRunId = activeRun.run_id;
    const timer = window.setInterval(() => {
      void Promise.all([
        selectedConversationId ? hydrateConversation(selectedConversationId) : Promise.resolve(),
        getRun(pollingRunId).then((detail) => {
          setRunDetails((current) => ({ ...current, [pollingRunId]: detail }));
          setActiveRun((current) => (isNewerRun(detail.run, current) ? detail.run : current));
        }),
      ]).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [activeRun?.run_id, hydrateConversation, selectedConversationId, status]);

  useEffect(() => {
    if (status !== "authenticated" || !sessionId) return;
    return eventStreamClient.connect(sessionId, (event) => {
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
        setErrorMessage(incident?.summary || incident?.code || "The run hit an issue.");
      }
      if (event.type === "run.failed") {
        const payload = event.payload as { message?: string; code?: string };
        setErrorMessage(payload.message || payload.code || "The run failed.");
      }
      if (event.run_id) {
        void getRun(event.run_id)
          .then((detail) => {
            setRunDetails((current) => ({ ...current, [event.run_id!]: detail }));
            setActiveRun((current) => (isNewerRun(detail.run, current) ? detail.run : current));
          })
          .catch(() => undefined);
      }
    });
  }, [sessionId, status]);

  const sendTurn = useCallback(
    async (text: string, attachments: ComposerAttachment[]) => {
      const trimmed = text.trim();
      if ((!trimmed && attachments.length === 0) || !selectedConversationId) return;
      setIsThinking(true);
      setErrorMessage("");
      try {
        await chatConversationTurn(selectedConversationId, {
          conversation_id: selectedConversationId,
          session_id: sessionId,
          inputs: [
            ...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
            ...attachments.map((item) => item.part),
          ],
          client_context: {
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            locale: navigator.language || "en-US",
            model: selectedModel === "auto" ? undefined : selectedModel,
          },
        });
        await hydrateConversation(selectedConversationId);
        await refreshConversationList();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Failed to send message.");
      } finally {
        setIsThinking(false);
      }
    },
    [hydrateConversation, refreshConversationList, selectedConversationId, selectedModel, sessionId],
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
      pauseActiveRun: () => mutateActiveRun("pause"),
      resumeActiveRun: () => mutateActiveRun("resume"),
      stopActiveRun: () => mutateActiveRun("stop"),
      retryActiveRun: () => mutateActiveRun("retry"),
    }),
    [
      activeRun,
      conversations,
      createConversation,
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
