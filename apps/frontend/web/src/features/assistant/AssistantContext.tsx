import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getChatSessionState, chatTurn } from "@/api/chat";
import { listGeminiModels } from "@/api/models";
import { getRun } from "@/api/runs";
import { useAuth } from "@/features/auth/AuthContext";
import type {
  AutomationRun,
  ComposerAttachment,
  GeminiModelOption,
  RunDetailResponse,
  ScheduleSummaryCard,
} from "@/domain/automation";

interface AssistantContextValue {
  sessionId: string;
  selectedModel: string;
  modelOptions: GeminiModelOption[];
  timeline: Array<Record<string, unknown>>;
  schedules: ScheduleSummaryCard[];
  activeRun: AutomationRun | null;
  runDetails: Record<string, RunDetailResponse>;
  isThinking: boolean;
  errorMessage: string;
  dismissError: () => void;
  sendTurn: (text: string, attachments: ComposerAttachment[]) => Promise<void>;
  selectModel: (model: string) => void;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

function createSessionId() {
  return crypto.randomUUID();
}

const STORAGE_KEY = "oi:web:assistant-session:v2";

function isNewerRun(next: AutomationRun | null, current: AutomationRun | null): boolean {
  if (!next) return false;
  if (!current) return true;
  if (next.run_id !== current.run_id) {
    const nextUpdated = Date.parse(next.updated_at || "") || 0;
    const currentUpdated = Date.parse(current.updated_at || "") || 0;
    return nextUpdated >= currentUpdated;
  }
  const nextUpdated = Date.parse(next.updated_at || "") || 0;
  const currentUpdated = Date.parse(current.updated_at || "") || 0;
  return nextUpdated >= currentUpdated;
}

function loadSessionId() {
  if (typeof window === "undefined") return createSessionId();
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value && value.trim()) return value;
  } catch {
    // ignore storage failures
  }
  const next = createSessionId();
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // ignore storage failures
  }
  return next;
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const [sessionId] = useState(loadSessionId);
  const [selectedModel, setSelectedModel] = useState("auto");
  const [modelOptions, setModelOptions] = useState<GeminiModelOption[]>([]);
  const [timeline, setTimeline] = useState<Array<Record<string, unknown>>>([]);
  const [schedules, setSchedules] = useState<ScheduleSummaryCard[]>([]);
  const [activeRun, setActiveRun] = useState<AutomationRun | null>(null);
  const [runDetails, setRunDetails] = useState<Record<string, RunDetailResponse>>({});
  const [isThinking, setIsThinking] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const hydrateSession = useCallback(async () => {
    const remote = await getChatSessionState(sessionId);
    setSelectedModel(remote.selected_model || "auto");
    setTimeline(Array.isArray(remote.timeline) ? remote.timeline : []);
    setSchedules(Array.isArray(remote.schedules) ? (remote.schedules as unknown as ScheduleSummaryCard[]) : []);
    setActiveRun((current) => {
      const remoteActive = remote.active_run ?? null;
      return isNewerRun(remoteActive, current) ? remoteActive : current;
    });
    setRunDetails((current) => ({ ...current, ...(remote.run_details ?? {}) }));
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    if (status !== "authenticated") return;
    void listGeminiModels()
      .then((response) => {
        if (cancelled) return;
        setModelOptions(response.items);
        if (selectedModel === "auto" && response.default_model_id) {
          setSelectedModel(response.default_model_id);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedModel, status]);

  useEffect(() => {
    if (status !== "authenticated") return;
    void hydrateSession().catch(() => {});
  }, [hydrateSession, status]);

  useEffect(() => {
    if (status !== "authenticated" || !activeRun?.run_id) return;
    const pollingRunId = activeRun.run_id;
    const timer = window.setInterval(() => {
      void Promise.all([
        hydrateSession(),
        getRun(pollingRunId).then((detail) => {
          setRunDetails((current) => ({ ...current, [pollingRunId]: detail }));
          setActiveRun((current) => (isNewerRun(detail.run, current) ? detail.run : current));
        }),
      ]).catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [activeRun?.run_id, hydrateSession, status]);

  const sendTurn = useCallback(
    async (text: string, attachments: ComposerAttachment[]) => {
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;
      setIsThinking(true);
      setErrorMessage("");
      try {
        await chatTurn({
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
        await hydrateSession();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Failed to send message.");
      } finally {
        setIsThinking(false);
      }
    },
    [hydrateSession, selectedModel, sessionId],
  );

  const value = useMemo<AssistantContextValue>(
    () => ({
      sessionId,
      selectedModel,
      modelOptions,
      timeline,
      schedules,
      activeRun,
      runDetails,
      isThinking,
      errorMessage,
      dismissError: () => setErrorMessage(""),
      sendTurn,
      selectModel: setSelectedModel,
    }),
    [activeRun, errorMessage, isThinking, modelOptions, runDetails, schedules, selectedModel, sendTurn, sessionId, timeline],
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
