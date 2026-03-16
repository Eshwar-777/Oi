import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, PanResponder, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import {
  MobileScreen,
  SecondaryButton,
  SectionHeader,
  StatusChip,
  SurfaceCard,
  useMobileTheme,
} from "@oi/design-system-mobile";
import { useMobileAssistant } from "@/features/assistant/MobileAssistantContext";
import {
  AssistantStatusCard,
  IncidentSummaryBlock,
  describeNotificationContext,
  runTone,
} from "@/features/assistant/ui";

import { fetchWithTimeout, getApiBaseUrl } from "@/lib/api";
import { getAuthHeaders } from "@/lib/authHeaders";

type SessionStatus = "idle" | "starting" | "ready" | "busy" | "stopped" | "error";
type SessionOrigin = "local_runner" | "server_runner";
type AutomationEngine = "agent_browser";
type RuntimeIncidentCategory =
  | "auth"
  | "navigation"
  | "permission"
  | "security"
  | "ambiguity"
  | "blocker"
  | "unexpected_ui"
  | "human_takeover"
  | "resume_reconciliation";

interface BrowserSessionRecord {
  session_id: string;
  origin: SessionOrigin;
  automation_engine: AutomationEngine;
  status: SessionStatus;
  runner_label?: string | null;
  page_id?: string | null;
  pages?: Array<{
    page_id: string;
    title?: string;
    url?: string;
    is_active?: boolean;
  }>;
  controller_lock?: {
    actor_id: string;
    actor_type: "web" | "mobile" | "desktop" | "system";
    expires_at: string;
  } | null;
  viewport?: {
    width: number;
    height: number;
    dpr: number;
  } | null;
  created_at?: string;
  updated_at?: string;
}

interface SessionFrameResponse {
  session_id: string;
  frame?: SessionFrameEnvelope | SessionFrameState | null;
}

interface SessionFrameState {
  session_id?: string;
  screenshot?: string;
  current_url?: string;
  page_title?: string;
  page_id?: string;
  timestamp?: string;
  viewport?: {
    width: number;
    height: number;
    dpr: number;
  };
}

interface SessionFrameEnvelope {
  type?: string;
  payload?: SessionFrameState;
}

type SessionFrameHealthState = "unknown" | "live" | "empty" | "error";

interface SessionFrameHealth {
  state: SessionFrameHealthState;
  timestamp?: string | null;
}

interface RuntimeIncidentAnalyticsItem {
  incident_code: string;
  category: RuntimeIncidentCategory;
  site: string;
  total_runs: number;
  waiting_for_human_runs: number;
  reconciliation_runs: number;
  engines: Record<string, number>;
  last_seen_at?: string | null;
}

const MOBILE_FRAME_POLL_MS = 1500;
const SESSION_FRAME_PROBE_LIMIT = 4;

function incidentGuidance(item: RuntimeIncidentAnalyticsItem) {
  switch (item.incident_code) {
    case "RUNTIME_FILE_UPLOAD_REQUIRED":
      return "A user has to choose a file in the browser before the run can continue. Use the live session above and take control.";
    case "RUNTIME_DOWNLOAD_PROMPT":
      return "The browser hit a download permission or save prompt and usually needs reconciliation after review in the live session.";
    case "RUNTIME_VERIFICATION_WIDGET":
      return "An embedded challenge or security widget needs human review in the live browser. Take control from the viewer above.";
    case "RUNTIME_UNSUPPORTED_WIDGET":
      return "The target UI is inside a closed or custom widget boundary the engine cannot safely pierce. Review and then let the agent replan.";
    case "RUNTIME_REPEATED_STEP_FAILURE":
      return "The same action kept failing, so the run switched to reconciliation instead of retrying blindly.";
    case "RUNTIME_NO_PROGRESS":
      return "The browser stayed on the same visual state across multiple steps. Review the live browser and resume if it is safe.";
    default:
      return "This blocker pattern is being tracked so you can decide whether to take over or let the agent replan from the current state.";
  }
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const api = getApiBaseUrl();
  const response = await fetchWithTimeout(`${api}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(await getAuthHeaders()),
      ...(init?.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof body?.detail === "string" ? body.detail : "Request failed";
    throw new Error(detail);
  }
  return body as T;
}

async function listBrowserSessions(): Promise<BrowserSessionRecord[]> {
  const body = await apiJson<{ items?: BrowserSessionRecord[] }>("/browser/sessions");
  return Array.isArray(body.items) ? body.items : [];
}

function sessionHealthFromFrame(frame: SessionFrameState | null, fallbackState: SessionFrameHealthState = "empty"): SessionFrameHealth {
  return {
    state: frame?.screenshot ? "live" : fallbackState,
    timestamp: frame?.timestamp ?? null,
  };
}

function sessionUpdatedAt(session: BrowserSessionRecord): number {
  const raw = session.updated_at || session.created_at || "";
  const timestamp = Date.parse(raw);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function compareBrowserSessions(
  left: BrowserSessionRecord,
  right: BrowserSessionRecord,
  health: Record<string, SessionFrameHealth>,
): number {
  const frameRank = {
    live: 0,
    unknown: 1,
    empty: 2,
    error: 3,
  } as const;
  const statusRank = {
    ready: 0,
    busy: 1,
    starting: 2,
    idle: 3,
    error: 4,
    stopped: 5,
  } as const;

  const leftHealth = health[left.session_id]?.state ?? "unknown";
  const rightHealth = health[right.session_id]?.state ?? "unknown";
  if (frameRank[leftHealth] !== frameRank[rightHealth]) {
    return frameRank[leftHealth] - frameRank[rightHealth];
  }
  if (statusRank[left.status] !== statusRank[right.status]) {
    return statusRank[left.status] - statusRank[right.status];
  }
  const updatedDelta = sessionUpdatedAt(right) - sessionUpdatedAt(left);
  if (updatedDelta !== 0) return updatedDelta;
  if (left.origin !== right.origin) {
    return left.origin === "local_runner" ? -1 : 1;
  }
  return (left.runner_label || left.session_id).localeCompare(right.runner_label || right.session_id);
}

function selectProbeCandidates(
  sessions: BrowserSessionRecord[],
  currentSessionId: string | null,
  requestedSessionId?: string,
): BrowserSessionRecord[] {
  const candidates = [...sessions]
    .filter((session) => session.status === "ready" || session.status === "busy" || session.status === "starting")
    .sort((left, right) => sessionUpdatedAt(right) - sessionUpdatedAt(left));
  const selectedIds = new Set<string>();
  if (requestedSessionId) selectedIds.add(requestedSessionId);
  if (currentSessionId) selectedIds.add(currentSessionId);
  for (const session of candidates.slice(0, SESSION_FRAME_PROBE_LIMIT)) {
    selectedIds.add(session.session_id);
  }
  return sessions.filter((session) => selectedIds.has(session.session_id));
}

async function probeSessionHealth(
  sessions: BrowserSessionRecord[],
): Promise<Record<string, SessionFrameHealth>> {
  const entries = await Promise.allSettled(
    sessions.map(async (session) => {
      const frame = await getBrowserSessionFrame(session.session_id);
      return [session.session_id, sessionHealthFromFrame(frame)] as const;
    }),
  );
  const next: Record<string, SessionFrameHealth> = {};
  for (const entry of entries) {
    if (entry.status === "fulfilled") {
      const [sessionId, health] = entry.value;
      next[sessionId] = health;
    }
  }
  return next;
}

function choosePreferredSessionId({
  sessions,
  currentSessionId,
  requestedSessionId,
  health,
}: {
  sessions: BrowserSessionRecord[];
  currentSessionId: string | null;
  requestedSessionId?: string;
  health: Record<string, SessionFrameHealth>;
}): string | null {
  if (requestedSessionId && sessions.some((session) => session.session_id === requestedSessionId)) {
    return requestedSessionId;
  }
  const currentSession = currentSessionId
    ? sessions.find((session) => session.session_id === currentSessionId) ?? null
    : null;
  const liveSession = sessions.find((session) => health[session.session_id]?.state === "live") ?? null;
  if (currentSession && health[currentSession.session_id]?.state === "live") {
    return currentSession.session_id;
  }
  if (liveSession) {
    return liveSession.session_id;
  }
  if (currentSession) {
    return currentSession.session_id;
  }
  return sessions[0]?.session_id ?? null;
}

function normalizeSessionFrame(frame?: SessionFrameResponse["frame"]): SessionFrameState | null {
  if (!frame || typeof frame !== "object") return null;
  if ("payload" in frame && frame.payload && typeof frame.payload === "object") {
    return frame.payload;
  }
  return frame as SessionFrameState;
}

async function getBrowserSessionFrame(sessionId: string): Promise<SessionFrameState | null> {
  console.debug("[browser-session] mobile fetching latest frame", { sessionId });
  const body = await apiJson<SessionFrameResponse>(`/browser/sessions/${encodeURIComponent(sessionId)}/frame`);
  const frame = normalizeSessionFrame(body.frame);
  console.debug("[browser-session] mobile fetched latest frame", {
    sessionId,
    hasFrame: Boolean(frame),
    hasScreenshot: Boolean(frame?.screenshot),
    timestamp: frame?.timestamp ?? null,
  });
  return frame;
}

async function controlBrowserSession(sessionId: string, action: "navigate" | "refresh_stream", url?: string) {
  return apiJson<{ ok: boolean; session_id: string; action: string }>(
    `/browser/sessions/${encodeURIComponent(sessionId)}/control`,
    {
      method: "POST",
      body: JSON.stringify({ action, url }),
    },
  );
}

async function acquireControl(sessionId: string, actorId: string): Promise<void> {
  await apiJson(`/browser/sessions/${encodeURIComponent(sessionId)}/controller/acquire`, {
    method: "POST",
    body: JSON.stringify({
      actor_id: actorId,
      actor_type: "mobile",
      priority: 200,
      ttl_seconds: 300,
    }),
  });
}

async function listRuntimeIncidentAnalytics(): Promise<RuntimeIncidentAnalyticsItem[]> {
  const body = await apiJson<{ items?: RuntimeIncidentAnalyticsItem[] }>("/api/analytics/runtime-incidents");
  return Array.isArray(body.items) ? body.items : [];
}

async function releaseControl(sessionId: string, actorId: string): Promise<void> {
  await apiJson(`/browser/sessions/${encodeURIComponent(sessionId)}/controller/release`, {
    method: "POST",
    body: JSON.stringify({ actor_id: actorId }),
  });
}

async function sendSessionInput(
  sessionId: string,
  payload: {
    actor_id: string;
    input_type: "click" | "type" | "scroll" | "keypress" | "move" | "mouse_down" | "mouse_up";
    x?: number;
    y?: number;
    text?: string;
    delta_x?: number;
    delta_y?: number;
    key?: string;
    button?: "left" | "middle" | "right";
  },
): Promise<void> {
  await apiJson(`/browser/sessions/${encodeURIComponent(sessionId)}/input`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function statusTone(status: SessionStatus): "brand" | "success" | "warning" | "danger" | "neutral" {
  if (status === "ready") return "success";
  if (status === "busy" || status === "starting") return "brand";
  if (status === "error") return "danger";
  if (status === "stopped") return "neutral";
  return "warning";
}

function prettyTime(value?: string) {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleTimeString();
}

function sessionMatchLabel({
  sessionId,
  selectedSessionId,
  requestedSessionId,
  requestedRunId,
}: {
  sessionId: string;
  selectedSessionId: string | null;
  requestedSessionId?: string;
  requestedRunId?: string;
}) {
  if (requestedSessionId && sessionId === requestedSessionId) return "Incident target";
  if (selectedSessionId && sessionId === selectedSessionId && requestedRunId) return "Selected for run";
  if (selectedSessionId && sessionId === selectedSessionId) return "Selected";
  return "";
}

function mapFramePointToViewport({
  locationX,
  locationY,
  layoutWidth,
  layoutHeight,
  viewportWidth,
  viewportHeight,
}: {
  locationX: number;
  locationY: number;
  layoutWidth: number;
  layoutHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}) {
  if (!layoutWidth || !layoutHeight || !viewportWidth || !viewportHeight) return null;

  const containerAspect = layoutWidth / layoutHeight;
  const viewportAspect = viewportWidth / viewportHeight;
  let renderWidth = layoutWidth;
  let renderHeight = layoutHeight;
  let offsetX = 0;
  let offsetY = 0;

  if (containerAspect > viewportAspect) {
    renderWidth = layoutHeight * viewportAspect;
    offsetX = (layoutWidth - renderWidth) / 2;
  } else {
    renderHeight = layoutWidth / viewportAspect;
    offsetY = (layoutHeight - renderHeight) / 2;
  }

  const localX = locationX - offsetX;
  const localY = locationY - offsetY;
  if (localX < 0 || localY < 0 || localX > renderWidth || localY > renderHeight) return null;

  return {
    x: Math.round((localX / renderWidth) * viewportWidth),
    y: Math.round((localY / renderHeight) * viewportHeight),
  };
}

export default function NavigatorScreen() {
  const theme = useMobileTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ session_id?: string; run_id?: string }>();
  const {
    activeRun,
    runReason,
    schedules,
    notificationContext,
    runEventSummaries,
    runStatesById,
    refreshRunEventSummary,
  } = useMobileAssistant();
  const routeSessionId = Array.isArray(params.session_id) ? params.session_id[0] : params.session_id;
  const routeRunId = Array.isArray(params.run_id) ? params.run_id[0] : params.run_id;
  const requestedSessionId = routeSessionId ?? notificationContext?.browserSessionId ?? undefined;
  const requestedRunId = routeRunId ?? notificationContext?.runId ?? undefined;
  const actorId = useRef(`mobile:${Math.random().toString(36).slice(2)}`).current;
  const previousSelectedSessionIdRef = useRef<string | null>(null);
  const selectedSessionIdRef = useRef<string | null>(null);
  const sessionFrameHealthRef = useRef<Record<string, SessionFrameHealth>>({});
  const [sessions, setSessions] = useState<BrowserSessionRecord[]>([]);
  const [sessionFrameHealth, setSessionFrameHealth] = useState<Record<string, SessionFrameHealth>>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [frame, setFrame] = useState<SessionFrameState | null>(null);
  const [runtimeIncidents, setRuntimeIncidents] = useState<RuntimeIncidentAnalyticsItem[]>([]);
  const [requestedRunState, setRequestedRunState] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshingFrame, setRefreshingFrame] = useState(false);
  const [frameStreamStatus, setFrameStreamStatus] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [errorMessage, setErrorMessage] = useState("");
  const [navigateUrl, setNavigateUrl] = useState("");
  const [remoteInputText, setRemoteInputText] = useState("");
  const [frameLayout, setFrameLayout] = useState({ width: 0, height: 0 });
  const [sessionActionPending, setSessionActionPending] =
    useState<"" | "navigate" | "refresh_stream" | "type" | "release" | "acquire" | "backspace" | "keypress" | "frame_input">("");
  const frameGestureRef = useRef<{ x: number; y: number } | null>(null);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.session_id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );
  const selectedSessionFrameHealth = selectedSessionId ? sessionFrameHealth[selectedSessionId] : undefined;

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    sessionFrameHealthRef.current = sessionFrameHealth;
  }, [sessionFrameHealth]);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setErrorMessage("");
    try {
      const items = await listBrowserSessions();
      const probeCandidates = selectProbeCandidates(items, selectedSessionIdRef.current, requestedSessionId);
      const probedHealth = probeCandidates.length > 0 ? await probeSessionHealth(probeCandidates) : {};
      const orderedItems = [...items].sort((left, right) => compareBrowserSessions(left, right, probedHealth));
      const incidentItems = await listRuntimeIncidentAnalytics();
      setSessions(orderedItems);
      setSessionFrameHealth((current) => ({
        ...current,
        ...probedHealth,
      }));
      setRuntimeIncidents(incidentItems.slice(0, 4));
      setSelectedSessionId((current) =>
        choosePreferredSessionId({
          sessions: orderedItems,
          currentSessionId: current,
          requestedSessionId,
          health: {
            ...sessionFrameHealthRef.current,
            ...probedHealth,
          },
        }),
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load browser sessions");
    } finally {
      setLoading(false);
    }
  }, [requestedSessionId]);

  const refreshRequestedRunState = useCallback(async () => {
    if (!requestedRunId) return;
    try {
      await refreshRunEventSummary(requestedRunId);
      const state = runStatesById[requestedRunId] ?? "";
      setRequestedRunState(state);
    } catch {
      // Leave current viewer state intact on refresh failure.
    }
  }, [refreshRunEventSummary, requestedRunId, runStatesById]);

  const loadFrame = useCallback(async (sessionId: string) => {
    setRefreshingFrame(true);
    try {
      const nextFrame = await getBrowserSessionFrame(sessionId);
      setFrame(nextFrame);
      setSessionFrameHealth((current) => ({
        ...current,
        [sessionId]: sessionHealthFromFrame(nextFrame),
      }));
      if (requestedRunId) {
        await refreshRequestedRunState();
      }
    } catch (error) {
      setSessionFrameHealth((current) => ({
        ...current,
        [sessionId]: { state: "error", timestamp: null },
      }));
      setErrorMessage(error instanceof Error ? error.message : "Failed to refresh live frame");
    } finally {
      setRefreshingFrame(false);
    }
  }, [refreshRequestedRunState, requestedRunId]);

  useFocusEffect(
    useCallback(() => {
      void loadSessions();
    }, [loadSessions]),
  );

  const sharedRequestedRun = requestedRunId && activeRun?.run_id === requestedRunId ? activeRun : null;
  const requestedRunSummary = requestedRunId ? runEventSummaries[requestedRunId] ?? null : null;
  const latestReplanEvent = requestedRunSummary?.latestReplanEvent ?? null;
  const latestIncidentEvent = requestedRunSummary?.latestIncidentEvent ?? null;

  useEffect(() => {
    if (!selectedSessionId) {
      setFrame(null);
      setFrameStreamStatus("connecting");
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const pollFrame = async () => {
      try {
        const nextFrame = await getBrowserSessionFrame(selectedSessionId);
        if (cancelled) return;
        setFrame(nextFrame);
        setSessionFrameHealth((current) => ({
          ...current,
          [selectedSessionId]: sessionHealthFromFrame(nextFrame),
        }));
        if (nextFrame?.screenshot) {
          setFrameStreamStatus("live");
        } else {
          setFrameStreamStatus("connecting");
        }
      } catch {
        if (!cancelled) {
          setSessionFrameHealth((current) => ({
            ...current,
            [selectedSessionId]: { state: "error", timestamp: null },
          }));
          setFrameStreamStatus((current) => (current === "live" ? "reconnecting" : "connecting"));
        }
      } finally {
        if (!cancelled) {
          timer = setTimeout(() => {
            void pollFrame();
          }, MOBILE_FRAME_POLL_MS);
        }
      }
    };

    setFrameStreamStatus("connecting");
    void pollFrame();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [selectedSessionId]);

  useEffect(() => {
    if (!requestedRunId) {
      setRequestedRunState("");
      return;
    }
    const cachedState = runStatesById[requestedRunId];
    if (sharedRequestedRun) {
      setRequestedRunState(sharedRequestedRun.state);
      return;
    }
    if (cachedState) {
      setRequestedRunState(cachedState);
      return;
    }
    void refreshRequestedRunState();
  }, [refreshRequestedRunState, requestedRunId, runStatesById, sharedRequestedRun]);

  const isControlling = selectedSession?.controller_lock?.actor_id === actorId;
  const liveSessions = sessions.filter((session) => sessionFrameHealth[session.session_id]?.state === "live").length;
  const lockedSessions = sessions.filter((session) => Boolean(session.controller_lock)).length;
  const selectedActivePage = selectedSession?.pages?.find((page) => page.is_active) ?? selectedSession?.pages?.[0] ?? null;
  const currentPageUrl = frame?.current_url || selectedActivePage?.url || "";
  const selectedSessionMatchLabel = selectedSession
    ? sessionMatchLabel({
        sessionId: selectedSession.session_id,
        selectedSessionId,
        requestedSessionId,
        requestedRunId,
      })
    : "";
  const selectedSessionSupportsRun = Boolean(selectedSession && requestedRunId);
  const livePathSteps = [
    {
      key: "run",
      label: "Run context",
      value: requestedRunId ?? activeRun?.run_id ?? "No active run",
      tone: requestedRunId || activeRun ? "brand" : "neutral",
    },
    {
      key: "alert",
      label: "Alert",
      value: notificationContext ? describeNotificationContext(notificationContext) : "No recent alert",
      tone: notificationContext ? "warning" : "neutral",
    },
    {
      key: "session",
      label: "Session",
      value: selectedSession ? selectedSession.runner_label || selectedSession.session_id : "Pick a browser session",
      tone: selectedSession ? "success" : "neutral",
    },
    {
      key: "control",
      label: "Control",
      value: isControlling ? "You can act now" : selectedSession ? "Take control to continue" : "Waiting for session",
      tone: isControlling ? "success" : selectedSession ? "warning" : "neutral",
    },
  ] as const;

  useEffect(() => {
    if (selectedSessionId !== previousSelectedSessionIdRef.current) {
      setNavigateUrl(currentPageUrl);
      previousSelectedSessionIdRef.current = selectedSessionId;
    }
  }, [currentPageUrl, selectedSessionId]);

  const handleSessionControl = useCallback(
    async (action: "navigate" | "refresh_stream", url?: string) => {
      if (!selectedSessionId) return;
      setSessionActionPending(action);
      setErrorMessage("");
      try {
        await controlBrowserSession(selectedSessionId, action, url);
        await loadFrame(selectedSessionId);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Failed to update session");
      } finally {
        setSessionActionPending("");
      }
    },
    [loadFrame, selectedSessionId],
  );

  const sendRemoteKeypress = useCallback(
    async (key: string, pendingState: "backspace" | "keypress" = "keypress") => {
      if (!selectedSessionId) return;
      setSessionActionPending(pendingState);
      setErrorMessage("");
      try {
        await sendSessionInput(selectedSessionId, {
          actor_id: actorId,
          input_type: "keypress",
          key,
        });
        await loadFrame(selectedSessionId);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Failed to send session keypress");
      } finally {
        setSessionActionPending("");
      }
    },
    [actorId, loadFrame, selectedSessionId],
  );

  const sendRemoteText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!selectedSessionId || !trimmed) return;
      setSessionActionPending("type");
      setErrorMessage("");
      try {
        await sendSessionInput(selectedSessionId, {
          actor_id: actorId,
          input_type: "type",
          text: trimmed,
        });
        setRemoteInputText("");
        await loadFrame(selectedSessionId);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Failed to type into the remote page");
      } finally {
        setSessionActionPending("");
      }
    },
    [actorId, loadFrame, selectedSessionId],
  );

  const sendFramedSessionInput = useCallback(
    async (payload: Parameters<typeof sendSessionInput>[1]) => {
      if (!selectedSessionId) return;
      setSessionActionPending("frame_input");
      setErrorMessage("");
      try {
        await sendSessionInput(selectedSessionId, payload);
        await loadFrame(selectedSessionId);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Failed to send session input");
      } finally {
        setSessionActionPending("");
      }
    },
    [loadFrame, selectedSessionId],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => isControlling,
        onMoveShouldSetPanResponder: (_, gestureState) => isControlling && (Math.abs(gestureState.dx) > 2 || Math.abs(gestureState.dy) > 2),
        onPanResponderGrant: (event) => {
          const viewportWidth = selectedSession?.viewport?.width ?? 1280;
          const viewportHeight = selectedSession?.viewport?.height ?? 800;
          frameGestureRef.current = mapFramePointToViewport({
            locationX: event.nativeEvent.locationX,
            locationY: event.nativeEvent.locationY,
            layoutWidth: frameLayout.width,
            layoutHeight: frameLayout.height,
            viewportWidth,
            viewportHeight,
          });
        },
        onPanResponderRelease: (event, gestureState) => {
          const start = frameGestureRef.current;
          frameGestureRef.current = null;
          if (!start || !selectedSessionId) return;
          const viewportWidth = selectedSession?.viewport?.width ?? 1280;
          const viewportHeight = selectedSession?.viewport?.height ?? 800;
          const end =
            mapFramePointToViewport({
              locationX: event.nativeEvent.locationX,
              locationY: event.nativeEvent.locationY,
              layoutWidth: frameLayout.width,
              layoutHeight: frameLayout.height,
              viewportWidth,
              viewportHeight,
            }) ?? start;

          const moved = Math.abs(gestureState.dx) > 12 || Math.abs(gestureState.dy) > 12;
          if (!moved) {
            void sendFramedSessionInput({
              actor_id: actorId,
              input_type: "click",
              x: end.x,
              y: end.y,
              button: "left",
            });
            return;
          }

          setSessionActionPending("frame_input");
          setErrorMessage("");
          void sendSessionInput(selectedSessionId, {
            actor_id: actorId,
            input_type: "mouse_down",
            x: start.x,
            y: start.y,
            button: "left",
          })
            .then(() =>
              sendSessionInput(selectedSessionId, {
                actor_id: actorId,
                input_type: "move",
                x: end.x,
                y: end.y,
              }),
            )
            .then(() =>
              sendSessionInput(selectedSessionId, {
                actor_id: actorId,
                input_type: "mouse_up",
                x: end.x,
                y: end.y,
                button: "left",
              }),
            )
            .then(() => loadFrame(selectedSessionId))
            .catch((error) => {
              setErrorMessage(error instanceof Error ? error.message : "Failed to send session input");
            })
            .finally(() => {
              setSessionActionPending("");
            });
        },
        onPanResponderTerminate: () => {
          frameGestureRef.current = null;
        },
      }),
    [actorId, frameLayout.height, frameLayout.width, isControlling, loadFrame, selectedSession?.viewport?.height, selectedSession?.viewport?.width, selectedSessionId, sendFramedSessionInput],
  );

  const styles = useMemo(() => getNavigatorStyles(theme), [theme]);

  return (
    <MobileScreen scrollable contentContainerStyle={styles.content}>
      <SectionHeader
        eyebrow="Sessions"
        title="Live browser sessions"
        description="Inspect browser frames, understand who holds the control lock, and step in from mobile when a run needs help."
      />

      {activeRun ? (
        <AssistantStatusCard
          eyebrow="Run"
          title="Assistant session state"
          description={runReason || `Active run ${activeRun.run_id} is available across mobile chat, schedules, and sessions.`}
          state={activeRun.state}
          executionMode={activeRun.execution_mode}
          variant="run"
          metaItems={[
            `Run ${activeRun.run_id}`,
            schedules.length > 0 ? `${schedules.length} upcoming schedule${schedules.length === 1 ? "" : "s"}` : "No schedules loaded",
          ]}
          quickLinks={[
            { label: "Open chat", onPress: () => router.push(`/(tabs)/chat?run_id=${encodeURIComponent(activeRun.run_id)}`) },
            { label: "Open schedules", onPress: () => router.push("/(tabs)/schedules") },
          ]}
        >
          {notificationContext ? <Text style={styles.metaText}>Last alert: {describeNotificationContext(notificationContext)}</Text> : null}
        </AssistantStatusCard>
      ) : null}

      <View style={styles.summaryGrid}>
        <SurfaceCard style={styles.summaryCard}>
          <Text style={styles.summaryValue}>{sessions.length}</Text>
          <Text style={styles.summaryLabel}>Connected sessions</Text>
        </SurfaceCard>
        <SurfaceCard style={styles.summaryCard}>
          <Text style={styles.summaryValue}>{liveSessions}</Text>
          <Text style={styles.summaryLabel}>Live frames</Text>
        </SurfaceCard>
        <SurfaceCard style={styles.summaryCard}>
          <Text style={styles.summaryValue}>{lockedSessions}</Text>
          <Text style={styles.summaryLabel}>Control locked</Text>
        </SurfaceCard>
      </View>

      <View style={styles.actionsRow}>
        <View style={styles.actionButton}>
          <SecondaryButton onPress={() => void loadSessions()} loading={loading}>
            Refresh sessions
          </SecondaryButton>
        </View>
        {selectedSessionId ? (
          <View style={styles.actionButton}>
            <SecondaryButton onPress={() => void loadFrame(selectedSessionId)} loading={refreshingFrame}>
              Refresh frame
            </SecondaryButton>
          </View>
        ) : null}
      </View>

      {errorMessage ? (
        <SurfaceCard>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </SurfaceCard>
      ) : null}

      {requestedSessionId ? (
        <AssistantStatusCard
          eyebrow="Alert"
          title="Focused live session"
          description="This view opened from an automation incident and will focus the matching browser session when it is connected."
          state={requestedRunState || null}
          variant="alert"
          metaItems={[
            requestedRunId ? `Run ${requestedRunId}` : "",
            requestedSessionId ? `Session ${requestedSessionId}` : "",
          ]}
          quickLinks={[
            ...(requestedRunId
              ? [{ label: "Open chat", onPress: () => router.push(`/(tabs)/chat?run_id=${encodeURIComponent(requestedRunId)}`) }]
              : []),
            { label: "Open schedules", onPress: () => router.push("/(tabs)/schedules") },
          ]}
        >
          {requestedRunId ? (
            <IncidentSummaryBlock
              latestReplanEvent={latestReplanEvent}
              latestIncidentEvent={latestIncidentEvent}
              requestedRunId={requestedRunId}
            />
          ) : null}
        </AssistantStatusCard>
      ) : null}

      <SurfaceCard style={styles.flowCard}>
        <Text style={styles.viewerTitle}>Live run handoff</Text>
        <Text style={styles.metaText}>
          Follow the current automation from run state through incident context into the browser session you can take over.
        </Text>
        <View style={styles.flowRow}>
          {livePathSteps.map((step, index) => (
            <View key={step.key} style={styles.flowStep}>
              <View style={styles.flowStepHeader}>
                <Text style={styles.flowLabel}>{step.label}</Text>
                <StatusChip label={step.tone} tone={step.tone} />
              </View>
              <Text style={styles.flowValue}>{step.value}</Text>
              {index < livePathSteps.length - 1 ? <Text style={styles.flowArrow}>→</Text> : null}
            </View>
          ))}
        </View>
      </SurfaceCard>

      {loading && sessions.length === 0 ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      ) : null}

      {!loading && sessions.length === 0 ? (
        <SurfaceCard>
          <Text style={styles.emptyText}>No local or server browser sessions are connected.</Text>
        </SurfaceCard>
      ) : null}

      {sessions.map((session) => {
        const active = session.session_id === selectedSessionId;
        const frameHealth = sessionFrameHealth[session.session_id]?.state ?? "unknown";
        const matchLabel = sessionMatchLabel({
          sessionId: session.session_id,
          selectedSessionId,
          requestedSessionId,
          requestedRunId,
        });
        const activePage = session.pages?.find((page) => page.is_active) ?? session.pages?.[0];
        return (
          <Pressable key={session.session_id} onPress={() => setSelectedSessionId(session.session_id)}>
            <SurfaceCard
              style={[
                styles.sessionCard,
                active ? styles.sessionCardActive : null,
                requestedSessionId === session.session_id ? styles.sessionCardTarget : null,
              ]}
            >
              <View style={styles.sessionHeader}>
                <Text style={styles.sessionTitle}>
                  {session.runner_label || (session.origin === "server_runner" ? "Server runner" : "Local runner")}
                </Text>
                <View style={styles.sessionStatusChips}>
                  {frameHealth === "live" ? <StatusChip label="live frame" tone="success" /> : null}
                  {frameHealth === "empty" && session.status === "ready" ? <StatusChip label="no frame" tone="warning" /> : null}
                  {frameHealth === "error" ? <StatusChip label="frame check failed" tone="danger" /> : null}
                  <StatusChip label={session.status} tone={statusTone(session.status)} />
                </View>
              </View>
              {matchLabel ? (
                <View style={styles.matchRow}>
                  <StatusChip label={matchLabel} tone={requestedSessionId === session.session_id ? "warning" : "brand"} />
                </View>
              ) : null}
              {session.page_id ? <Text style={styles.metaText}>Focused page {session.page_id}</Text> : null}
              <Text style={styles.metaText}>
                {session.origin} · {session.automation_engine}
              </Text>
              <Text style={styles.metaText}>
                {session.pages?.length ?? 0} pages · {session.controller_lock ? "Controller lock active" : "No controller lock"}
              </Text>
              {activePage?.title ? <Text style={styles.pageTitle}>{activePage.title}</Text> : null}
              {activePage?.url ? <Text style={styles.pageUrl}>{activePage.url}</Text> : null}
            </SurfaceCard>
          </Pressable>
        );
      })}

      {selectedSession ? (
        <SurfaceCard style={styles.viewerCard}>
          <View style={styles.viewerHeader}>
            <Text style={styles.viewerTitle}>Live stream</Text>
            <View style={styles.viewerStatusGroup}>
              <StatusChip
                label={
                  frameStreamStatus === "live"
                    ? "stream live"
                    : frameStreamStatus === "reconnecting"
                      ? "stream reconnecting"
                      : "stream connecting"
                }
                tone={frameStreamStatus === "live" ? "success" : frameStreamStatus === "reconnecting" ? "warning" : "brand"}
              />
              <StatusChip
                label={isControlling ? "controlling" : selectedSession.controller_lock ? "locked" : "viewing"}
                tone={isControlling ? "success" : selectedSession.controller_lock ? "warning" : "brand"}
              />
            </View>
          </View>
          <View style={styles.selectedSessionBanner}>
            <View style={styles.selectedSessionBannerCopy}>
              <Text style={styles.selectedSessionBannerTitle}>
                {selectedSessionMatchLabel || "Selected browser session"}
              </Text>
              <Text style={styles.metaText}>
                {selectedSessionSupportsRun
                  ? "This session is the current handoff target for the active run."
                  : "Use this session to inspect the page before taking over or resuming the run."}
              </Text>
              <Text style={styles.metaText}>
                {frameStreamStatus === "live"
                  ? "Frames update as they arrive from the runner."
                  : frameStreamStatus === "reconnecting"
                    ? "The live frame stream is reconnecting."
                    : "Connecting to the live frame stream."}
              </Text>
            </View>
            {requestedRunState ? (
              <StatusChip
                label={requestedRunState.replace(/_/g, " ")}
                tone={runTone(requestedRunState)}
              />
            ) : null}
          </View>

          {frame?.screenshot ? (
            <View
              style={[styles.frameSurface, isControlling ? styles.frameSurfaceInteractive : null]}
              onLayout={(event) => {
                const { width, height } = event.nativeEvent.layout;
                setFrameLayout({ width, height });
              }}
              {...panResponder.panHandlers}
            >
              <Image source={{ uri: frame.screenshot }} style={styles.frameImage} resizeMode="contain" />
            </View>
          ) : (
            <View style={styles.framePlaceholder}>
              <Text style={styles.emptyText}>
                {selectedSessionFrameHealth?.state === "empty" && selectedSession.status === "ready"
                  ? "No cached frame is available for this session. It may be stale or the runner is disconnected. Pick a session tagged live frame or refresh sessions."
                  : selectedSessionFrameHealth?.state === "error"
                    ? "The frame check failed for this session. Refresh sessions or choose another live session."
                    : selectedSession.status === "ready"
                      ? "Waiting for the first cached frame from the runner."
                      : `The session is ${selectedSession.status}. A live frame will appear after the runner becomes ready and publishes one.`}
              </Text>
            </View>
          )}

          <Text style={styles.pageTitle}>{frame?.page_title || "Untitled page"}</Text>
          {frame?.current_url ? <Text style={styles.pageUrl}>{frame.current_url}</Text> : null}
          {frame?.timestamp ? <Text style={styles.metaText}>Updated {prettyTime(frame.timestamp)}</Text> : null}
          <Text style={styles.metaText}>
            {isControlling ? "Tap to click. Drag on the frame to swipe or drag in the remote browser." : "Take control to use touch directly on the live frame."}
          </Text>

          <View style={styles.detailGrid}>
            <View style={styles.detailCard}>
              <Text style={styles.detailLabel}>Runtime</Text>
              <Text style={styles.detailValue}>{selectedSession.origin.replace(/_/g, " ")}</Text>
              <Text style={styles.metaText}>{selectedSession.runner_label || "Unnamed runner"}</Text>
            </View>
            <View style={styles.detailCard}>
              <Text style={styles.detailLabel}>Controller</Text>
              <Text style={styles.detailValue}>
                {isControlling
                  ? "You"
                  : selectedSession.controller_lock?.actor_type
                    ? selectedSession.controller_lock.actor_type.replace(/_/g, " ")
                    : "Open"}
              </Text>
              <Text style={styles.metaText}>
                {selectedSession.controller_lock?.expires_at
                  ? `Until ${prettyTime(selectedSession.controller_lock.expires_at)}`
                  : "No active control lock"}
              </Text>
            </View>
          </View>

          {selectedSession.pages?.length ? (
            <View style={styles.pageList}>
              <Text style={styles.viewerTitle}>Open pages</Text>
              {selectedSession.pages.slice(0, 4).map((page) => (
                <Pressable
                  key={page.page_id}
                  onPress={() => setNavigateUrl(page.url || "")}
                  style={({ pressed }) => [styles.pageListRow, pressed ? styles.pressed : null]}
                >
                  <View style={styles.stepCopy}>
                    <Text style={styles.pageTitle}>{page.title || "Untitled page"}</Text>
                    {page.url ? <Text style={styles.pageUrl}>{page.url}</Text> : null}
                  </View>
                  <View style={styles.pageListChips}>
                    <StatusChip label={page.is_active ? "active" : "idle"} tone={page.is_active ? "success" : "neutral"} />
                    {page.url ? <StatusChip label="Use URL" tone="brand" /> : null}
                  </View>
                </Pressable>
              ))}
              {selectedActivePage?.page_id ? (
                <Text style={styles.metaText}>Focused page id: {selectedActivePage.page_id}</Text>
              ) : null}
            </View>
          ) : null}

          <View style={styles.controlPanel}>
            <Text style={styles.viewerTitle}>Page controls</Text>
            <Text style={styles.metaText}>
              Navigate the browser, seed a URL from the open pages list, or type into the focused field after taking control.
            </Text>
            <View style={styles.controlStack}>
              <TextInput
                value={navigateUrl}
                onChangeText={setNavigateUrl}
                placeholder="https://example.com"
                placeholderTextColor={theme.colors.textSoft}
                style={styles.controlInput}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={styles.actionsRow}>
                <View style={styles.actionButton}>
                  <SecondaryButton
                    onPress={() => void handleSessionControl("navigate", navigateUrl)}
                    loading={sessionActionPending === "navigate"}
                    disabled={!navigateUrl.trim()}
                  >
                    Open page
                  </SecondaryButton>
                </View>
                <View style={styles.actionButton}>
                  <SecondaryButton
                    onPress={() => void handleSessionControl("refresh_stream")}
                    loading={sessionActionPending === "refresh_stream"}
                  >
                    Refresh stream
                  </SecondaryButton>
                </View>
              </View>
            </View>

            <View style={styles.controlStack}>
              <Text style={styles.detailLabel}>Remote keyboard</Text>
              <Text style={styles.metaText}>
                Tap the search bar or input in the live frame first, then type here to send text into the focused browser field.
              </Text>
              <TextInput
                value={remoteInputText}
                onChangeText={setRemoteInputText}
                placeholder="Type into the focused browser field"
                placeholderTextColor={theme.colors.textSoft}
                style={styles.controlInput}
                autoCapitalize="none"
                autoCorrect={false}
                editable={isControlling}
                returnKeyType="send"
                onSubmitEditing={() => void sendRemoteText(remoteInputText)}
              />
              <View style={styles.actionsRow}>
                <View style={styles.actionButton}>
                  <SecondaryButton
                    onPress={() => void sendRemoteText(remoteInputText)}
                    loading={sessionActionPending === "type"}
                    disabled={!isControlling || !remoteInputText.trim()}
                  >
                    Type text
                  </SecondaryButton>
                </View>
                <View style={styles.actionButton}>
                  <SecondaryButton
                    onPress={() => void sendRemoteKeypress("Enter")}
                    loading={sessionActionPending === "keypress"}
                    disabled={!isControlling}
                  >
                    Press Enter
                  </SecondaryButton>
                </View>
                <View style={styles.actionButton}>
                  <SecondaryButton
                    onPress={() => void sendRemoteKeypress("Backspace", "backspace")}
                    loading={sessionActionPending === "backspace"}
                    disabled={!isControlling}
                  >
                    Backspace
                  </SecondaryButton>
                </View>
              </View>
              {!isControlling ? (
                <Text style={styles.metaText}>Take control before sending remote text or key presses.</Text>
              ) : null}
            </View>
          </View>

          <View style={styles.actionsRow}>
            <View style={styles.actionButton}>
              <SecondaryButton
                onPress={() => {
                  setSessionActionPending(isControlling ? "release" : "acquire");
                  void (isControlling
                    ? releaseControl(selectedSession.session_id, actorId)
                    : acquireControl(selectedSession.session_id, actorId))
                    .then(async () => {
                      await loadSessions();
                      await refreshRequestedRunState();
                    })
                    .catch((error) => {
                      setErrorMessage(error instanceof Error ? error.message : "Failed to update control");
                    })
                    .finally(() => {
                      setSessionActionPending("");
                    });
                }}
                loading={sessionActionPending === "acquire" || sessionActionPending === "release"}
              >
                {isControlling ? "Release control" : "Take control"}
              </SecondaryButton>
            </View>
            {requestedRunId ? (
              <View style={styles.actionButton}>
                <SecondaryButton onPress={() => router.push(`/(tabs)/chat?run_id=${encodeURIComponent(requestedRunId)}`)}>
                  Return to run chat
                </SecondaryButton>
              </View>
            ) : null}
          </View>
        </SurfaceCard>
      ) : null}

      {runtimeIncidents.length ? (
        <SurfaceCard style={styles.viewerCard}>
          <Text style={styles.viewerTitle}>Runtime incidents</Text>
          <Text style={styles.metaText}>
            Recent blocker patterns across local and server browser runs.
          </Text>
          {runtimeIncidents.map((incident) => (
            <View key={`${incident.incident_code}:${incident.site}`} style={styles.incidentCard}>
              <View style={styles.sessionHeader}>
                <Text style={styles.pageTitle}>{incident.incident_code.replaceAll("_", " ")}</Text>
                <StatusChip label={incident.category.replaceAll("_", " ")} tone="warning" />
              </View>
              <Text style={styles.pageUrl}>{incident.site}</Text>
              <Text style={styles.metaText}>{incidentGuidance(incident)}</Text>
              <Text style={styles.metaText}>
                Human pause {incident.waiting_for_human_runs} · Reconcile {incident.reconciliation_runs} · Total{" "}
                {incident.total_runs}
              </Text>
              <Text style={styles.metaText}>
                Engines: {Object.entries(incident.engines)
                  .map(([engine, count]) => `${engine} ${count}`)
                  .join(" · ")}
              </Text>
              {incident.last_seen_at ? (
                <Text style={styles.metaText}>Last seen {prettyTime(incident.last_seen_at)}</Text>
              ) : null}
            </View>
          ))}
        </SurfaceCard>
      ) : null}
    </MobileScreen>
  );
}

function getNavigatorStyles(theme: ReturnType<typeof useMobileTheme>) {
  return StyleSheet.create({
  content: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  summaryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  summaryCard: {
    flex: 1,
    minWidth: 104,
    gap: theme.spacing[1],
  },
  summaryValue: {
    fontSize: 26,
    fontWeight: "800",
    color: theme.colors.text,
  },
  summaryLabel: {
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textMuted,
  },
  flowCard: {
    gap: theme.spacing[3],
    borderWidth: 1,
    borderColor: "rgba(15,23,42,0.08)",
    backgroundColor: "#F6F5F1",
  },
  flowRow: {
    gap: theme.spacing[2],
  },
  flowStep: {
    gap: theme.spacing[2],
    borderRadius: theme.radii.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: "rgba(255,255,255,0.88)",
    padding: theme.spacing[3],
  },
  flowStepHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  flowLabel: {
    fontSize: theme.typography.fontSize.xs,
    fontWeight: "700",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  flowValue: {
    fontSize: theme.typography.fontSize.sm,
    fontWeight: "700",
    color: theme.colors.text,
  },
  flowArrow: {
    fontSize: theme.typography.fontSize.base,
    fontWeight: "700",
    color: theme.colors.textSoft,
  },
  actionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  actionButton: {
    minWidth: 140,
  },
  auditSection: {
    gap: theme.spacing[2],
  },
  auditCard: {
    gap: theme.spacing[1],
    borderRadius: theme.radii.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceMuted,
    padding: theme.spacing[3],
  },
  auditTitle: {
    fontSize: theme.typography.fontSize.sm,
    fontWeight: "700",
    color: theme.colors.text,
  },
  controlPanel: {
    gap: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.md,
    backgroundColor: "rgba(255,255,255,0.76)",
    padding: theme.spacing[3],
  },
  controlStack: {
    gap: theme.spacing[2],
  },
  controlInput: {
    minHeight: 48,
    borderRadius: theme.radii.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.text,
  },
  controlInputMultiline: {
    minHeight: 88,
    textAlignVertical: "top",
  },
  controlsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  controlButton: {
    minWidth: 140,
  },
  loadingWrap: {
    paddingVertical: theme.spacing[6],
    alignItems: "center",
  },
  errorText: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.error,
  },
  emptyText: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textMuted,
  },
  sessionCard: {
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  sessionCardActive: {
    borderColor: theme.colors.primary,
    backgroundColor: "#F5F9FF",
  },
  sessionCardTarget: {
    borderColor: "#C88B1E",
    backgroundColor: "#FFF8E8",
  },
  sessionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  matchRow: {
    alignSelf: "flex-start",
  },
  sessionTitle: {
    flex: 1,
    fontSize: theme.typography.fontSize.sm,
    fontWeight: "700",
    color: theme.colors.text,
  },
  sessionStatusChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
  },
  viewerCard: {
    gap: theme.spacing[3],
    borderWidth: 1,
    borderColor: "rgba(15,23,42,0.08)",
    backgroundColor: "#FBFAF7",
  },
  selectedSessionBanner: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    borderRadius: theme.radii.md,
    borderWidth: 1,
    borderColor: "rgba(200,139,30,0.22)",
    backgroundColor: "#FFF8E8",
    padding: theme.spacing[3],
  },
  selectedSessionBannerCopy: {
    flex: 1,
    gap: theme.spacing[1],
  },
  selectedSessionBannerTitle: {
    fontSize: theme.typography.fontSize.sm,
    fontWeight: "800",
    color: theme.colors.text,
  },
  detailGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  detailCard: {
    flex: 1,
    minWidth: 140,
    gap: theme.spacing[1],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.md,
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surfaceMuted,
  },
  detailLabel: {
    fontSize: theme.typography.fontSize.xs,
    fontWeight: "700",
    textTransform: "uppercase",
    color: theme.colors.textSoft,
  },
  detailValue: {
    fontSize: theme.typography.fontSize.sm,
    fontWeight: "700",
    color: theme.colors.text,
  },
  incidentCard: {
    gap: theme.spacing[1],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.md,
    padding: theme.spacing[3],
  },
  viewerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  viewerStatusGroup: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  viewerTitle: {
    fontSize: theme.typography.fontSize.base,
    fontWeight: "800",
    color: theme.colors.text,
  },
  pageList: {
    gap: theme.spacing[2],
  },
  pageListRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingTop: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  pageListChips: {
    gap: theme.spacing[1],
    alignItems: "flex-end",
  },
  quickPageRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  quickPageButton: {
    minHeight: 36,
    justifyContent: "center",
    borderRadius: theme.radii.full,
    backgroundColor: theme.colors.surfaceMuted,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  quickPageButtonText: {
    fontSize: theme.typography.fontSize.sm,
    fontWeight: "700",
    color: theme.colors.primary,
  },
  stepCopy: {
    flex: 1,
    gap: theme.spacing[1],
  },
  frameImage: {
    width: "100%",
    aspectRatio: 16 / 10,
    borderRadius: theme.radii.md,
    backgroundColor: theme.colors.surfaceMuted,
  },
  frameSurface: {
    borderRadius: theme.radii.md,
    overflow: "hidden",
  },
  frameSurfaceInteractive: {
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  framePlaceholder: {
    width: "100%",
    aspectRatio: 16 / 10,
    borderRadius: theme.radii.md,
    backgroundColor: theme.colors.surfaceMuted,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  metaText: {
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textMuted,
  },
  pageTitle: {
    fontSize: theme.typography.fontSize.sm,
    fontWeight: "700",
    color: theme.colors.text,
  },
  pageUrl: {
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textMuted,
  },
  pressed: {
    opacity: 0.84,
  },
});
}
