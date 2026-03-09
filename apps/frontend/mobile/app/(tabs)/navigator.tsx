import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import {
  MobileScreen,
  SecondaryButton,
  SectionHeader,
  StatusChip,
  SurfaceCard,
  mobileTheme,
} from "@oi/design-system-mobile";

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
}

interface SessionFrameResponse {
  session_id: string;
  frame?: {
    session_id?: string;
    screenshot?: string;
    current_url?: string;
    page_title?: string;
    page_id?: string;
    timestamp?: string;
  } | null;
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

interface RunEventRecord {
  event_id: string;
  run_id: string;
  type: string;
  created_at: string;
  payload?: {
    completed_command?: string;
    next_command?: string;
    replan_reasons?: string[];
    [key: string]: unknown;
  } | null;
}

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

async function getBrowserSessionFrame(sessionId: string): Promise<SessionFrameResponse["frame"] | null> {
  const body = await apiJson<SessionFrameResponse>(`/browser/sessions/${encodeURIComponent(sessionId)}/frame`);
  return body.frame ?? null;
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

async function listRunEvents(runId: string): Promise<RunEventRecord[]> {
  const body = await apiJson<{ items?: RunEventRecord[] }>(`/api/events?run_id=${encodeURIComponent(runId)}`);
  return Array.isArray(body.items) ? body.items : [];
}

async function getRunState(runId: string): Promise<string> {
  const body = await apiJson<{ run?: { state?: string }; state?: string }>(`/api/runs/${encodeURIComponent(runId)}`);
  return body.run?.state ?? body.state ?? "";
}

async function controlRun(runId: string, action: "resume" | "retry" | "approve" | "stop"): Promise<void> {
  const path =
    action === "approve"
      ? `/api/runs/${encodeURIComponent(runId)}/approve-sensitive-action`
      : `/api/runs/${encodeURIComponent(runId)}/${action}`;
  await apiJson(path, {
    method: "POST",
    body: JSON.stringify({}),
  });
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
    input_type: "click" | "scroll" | "keypress";
    x?: number;
    y?: number;
    delta_y?: number;
    key?: string;
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

function describeReplanReasons(reasons?: string[]) {
  if (!reasons?.length) return "the agent refreshed the plan against the current page";
  return reasons
    .map((reason) => {
      if (reason === "context_change") return "the page context changed";
      if (reason === "next_step_uses_ref") return "the next step needed fresh refs";
      if (reason === "next_step_interactive") return "the next step was interactive";
      return reason.replace(/_/g, " ");
    })
    .join(", ");
}

export default function NavigatorScreen() {
  const params = useLocalSearchParams<{ session_id?: string; run_id?: string }>();
  const requestedSessionId = Array.isArray(params.session_id) ? params.session_id[0] : params.session_id;
  const requestedRunId = Array.isArray(params.run_id) ? params.run_id[0] : params.run_id;
  const actorId = useRef(`mobile:${Math.random().toString(36).slice(2)}`).current;
  const [sessions, setSessions] = useState<BrowserSessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [frame, setFrame] = useState<SessionFrameResponse["frame"] | null>(null);
  const [runtimeIncidents, setRuntimeIncidents] = useState<RuntimeIncidentAnalyticsItem[]>([]);
  const [latestReplanEvent, setLatestReplanEvent] = useState<RunEventRecord | null>(null);
  const [isRequestedRunActive, setIsRequestedRunActive] = useState(false);
  const [requestedRunState, setRequestedRunState] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshingFrame, setRefreshingFrame] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [runActionPending, setRunActionPending] = useState<"" | "resume" | "retry" | "approve" | "stop">("");

  const selectedSession = useMemo(
    () => sessions.find((session) => session.session_id === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setErrorMessage("");
    try {
      const items = await listBrowserSessions();
      const incidentItems = await listRuntimeIncidentAnalytics();
      setSessions(items);
      setRuntimeIncidents(incidentItems.slice(0, 4));
      setSelectedSessionId((current) => {
        if (requestedSessionId && items.some((item) => item.session_id === requestedSessionId)) {
          return requestedSessionId;
        }
        return current ?? items[0]?.session_id ?? null;
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load browser sessions");
    } finally {
      setLoading(false);
    }
  }, [requestedSessionId]);

  const refreshRequestedRunState = useCallback(async () => {
    if (!requestedRunId) return;
    try {
      const [items, state] = await Promise.all([listRunEvents(requestedRunId), getRunState(requestedRunId)]);
      const latest = [...items].reverse().find((item) => item.type === "run.iterative_replan");
      setLatestReplanEvent(latest ?? null);
      setRequestedRunState(state);
      setIsRequestedRunActive(
        ["queued", "starting", "running", "waiting_for_human", "human_controlling", "resuming", "reconciling"].includes(
          state,
        ),
      );
    } catch {
      // Leave current viewer state intact on refresh failure.
    }
  }, [requestedRunId]);

  const loadFrame = useCallback(async (sessionId: string) => {
    setRefreshingFrame(true);
    try {
      setFrame(await getBrowserSessionFrame(sessionId));
      if (requestedRunId) {
        await refreshRequestedRunState();
      }
    } catch (error) {
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

  useEffect(() => {
    if (!selectedSessionId) {
      setFrame(null);
      return;
    }
    void loadFrame(selectedSessionId);
    const timer = setInterval(() => {
      void loadFrame(selectedSessionId);
    }, 3000);
    return () => clearInterval(timer);
  }, [selectedSessionId, loadFrame]);

  useEffect(() => {
    if (!requestedRunId) {
      setLatestReplanEvent(null);
      setIsRequestedRunActive(false);
      setRequestedRunState("");
      return;
    }
    let cancelled = false;
    void Promise.all([listRunEvents(requestedRunId), getRunState(requestedRunId)])
      .then(([items, state]) => {
        if (cancelled) return;
        const latest = [...items].reverse().find((item) => item.type === "run.iterative_replan");
        setLatestReplanEvent(latest ?? null);
        setRequestedRunState(state);
        setIsRequestedRunActive(
          ["queued", "starting", "running", "waiting_for_human", "human_controlling", "resuming", "reconciling"].includes(
            state,
          ),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setLatestReplanEvent(null);
          setIsRequestedRunActive(false);
          setRequestedRunState("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [requestedRunId]);

  useEffect(() => {
    if (!requestedRunId || !isRequestedRunActive) return;
    const timer = setInterval(() => {
      void Promise.all([listRunEvents(requestedRunId), getRunState(requestedRunId)])
        .then(([items, state]) => {
          const latest = [...items].reverse().find((item) => item.type === "run.iterative_replan");
          setLatestReplanEvent(latest ?? null);
          setRequestedRunState(state);
          setIsRequestedRunActive(
            ["queued", "starting", "running", "waiting_for_human", "human_controlling", "resuming", "reconciling"].includes(
              state,
            ),
          );
        })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [requestedRunId, isRequestedRunActive]);

  const isControlling = selectedSession?.controller_lock?.actor_id === actorId;
  const canResumeRun = ["waiting_for_human", "human_controlling", "reconciling", "resuming"].includes(requestedRunState);
  const canRetryRun = ["failed", "canceled", "timed_out"].includes(requestedRunState);
  const canApproveRun = requestedRunState === "waiting_for_human";
  const canStopRun = ["queued", "starting", "running", "waiting_for_human", "human_controlling", "resuming", "reconciling"].includes(
    requestedRunState,
  );

  const handleRunAction = useCallback(
    async (action: "resume" | "retry" | "approve" | "stop") => {
      if (!requestedRunId) return;
      setRunActionPending(action);
      setErrorMessage("");
      try {
        await controlRun(requestedRunId, action);
        await refreshRequestedRunState();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Failed to update run");
      } finally {
        setRunActionPending("");
      }
    },
    [refreshRequestedRunState, requestedRunId],
  );

  return (
    <MobileScreen scrollable contentContainerStyle={styles.content}>
      <SectionHeader
        eyebrow="Browser sessions"
        title="Live local and server sessions"
        description="View runner-backed Chrome or Chromium sessions and take control from mobile."
      />

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
        <SurfaceCard>
          <Text style={styles.viewerTitle}>Focused live session</Text>
          <Text style={styles.metaText}>
            This view opened from an automation incident and will focus the matching browser session when it is connected.
          </Text>
          {requestedRunId && requestedRunState ? (
            <View style={{ marginTop: 8, alignSelf: "flex-start" }}>
              <StatusChip
                label={`Run ${requestedRunState.replace(/_/g, " ")}`}
                tone={isRequestedRunActive ? "warning" : requestedRunState === "succeeded" ? "success" : "neutral"}
              />
            </View>
          ) : null}
          {requestedRunId ? (
            <Text style={styles.metaText}>
              {latestReplanEvent?.payload
                ? `Latest adaptation for run ${requestedRunId}: after ${latestReplanEvent.payload.completed_command ?? "the last step"}, the agent refreshed the plan because ${describeReplanReasons(latestReplanEvent.payload.replan_reasons)}.`
                : `If the agent adapts the workflow while this run is active, this viewer will show the latest replan reason for run ${requestedRunId} once it is emitted.`}
            </Text>
          ) : null}
        </SurfaceCard>
      ) : null}

      {loading && sessions.length === 0 ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={mobileTheme.colors.primary} />
        </View>
      ) : null}

      {!loading && sessions.length === 0 ? (
        <SurfaceCard>
          <Text style={styles.emptyText}>No local or server browser sessions are connected.</Text>
        </SurfaceCard>
      ) : null}

      {sessions.map((session) => {
        const active = session.session_id === selectedSessionId;
        const activePage = session.pages?.find((page) => page.is_active) ?? session.pages?.[0];
        return (
          <Pressable key={session.session_id} onPress={() => setSelectedSessionId(session.session_id)}>
            <SurfaceCard style={[styles.sessionCard, active ? styles.sessionCardActive : null]}>
              <View style={styles.sessionHeader}>
                <Text style={styles.sessionTitle}>
                  {session.runner_label || (session.origin === "server_runner" ? "Server runner" : "Local runner")}
                </Text>
                <StatusChip label={session.status} tone={statusTone(session.status)} />
              </View>
              <Text style={styles.metaText}>
                {session.origin} · {session.automation_engine}
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
            <StatusChip
              label={isControlling ? "controlling" : selectedSession.controller_lock ? "locked" : "viewing"}
              tone={isControlling ? "success" : selectedSession.controller_lock ? "warning" : "brand"}
            />
          </View>

          {frame?.screenshot ? (
            <Image source={{ uri: frame.screenshot }} style={styles.frameImage} resizeMode="contain" />
          ) : (
            <View style={styles.framePlaceholder}>
              <Text style={styles.emptyText}>Waiting for a live frame from the runner.</Text>
            </View>
          )}

          <Text style={styles.pageTitle}>{frame?.page_title || "Untitled page"}</Text>
          {frame?.current_url ? <Text style={styles.pageUrl}>{frame.current_url}</Text> : null}
          {frame?.timestamp ? <Text style={styles.metaText}>Updated {prettyTime(frame.timestamp)}</Text> : null}
          {requestedRunId ? (
            <View style={styles.incidentCard}>
              <Text style={styles.viewerTitle}>Latest adaptation</Text>
              {requestedRunState ? <Text style={styles.metaText}>Run state: {requestedRunState.replace(/_/g, " ")}</Text> : null}
              {requestedRunId && (canResumeRun || canRetryRun || canApproveRun || canStopRun) ? (
                <View style={styles.actionsRow}>
                  {canApproveRun ? (
                    <View style={styles.actionButton}>
                      <SecondaryButton onPress={() => void handleRunAction("approve")} loading={runActionPending === "approve"}>
                        Approve once
                      </SecondaryButton>
                    </View>
                  ) : null}
                  {canResumeRun ? (
                    <View style={styles.actionButton}>
                      <SecondaryButton onPress={() => void handleRunAction("resume")} loading={runActionPending === "resume"}>
                        Resume
                      </SecondaryButton>
                    </View>
                  ) : null}
                  {canRetryRun ? (
                    <View style={styles.actionButton}>
                      <SecondaryButton onPress={() => void handleRunAction("retry")} loading={runActionPending === "retry"}>
                        Retry
                      </SecondaryButton>
                    </View>
                  ) : null}
                  {canStopRun ? (
                    <View style={styles.actionButton}>
                      <SecondaryButton onPress={() => void handleRunAction("stop")} loading={runActionPending === "stop"}>
                        Cancel run
                      </SecondaryButton>
                    </View>
                  ) : null}
                </View>
              ) : null}
              <Text style={styles.metaText}>
                {latestReplanEvent?.payload
                  ? `After ${latestReplanEvent.payload.completed_command ?? "the last step"}, the agent replanned because ${describeReplanReasons(latestReplanEvent.payload.replan_reasons)}. Next command: ${latestReplanEvent.payload.next_command ?? "unknown"}.`
                  : `If the agent replans from the current UI state for run ${requestedRunId}, the reason will appear here. Use this viewer to inspect the live page before resuming.`}
              </Text>
            </View>
          ) : null}

          <View style={styles.actionsRow}>
            <View style={styles.actionButton}>
              <SecondaryButton
                onPress={() =>
                  void (isControlling
                    ? releaseControl(selectedSession.session_id, actorId)
                    : acquireControl(selectedSession.session_id, actorId))
                      .then(async () => {
                        await loadSessions();
                        await refreshRequestedRunState();
                      })
                }
              >
                {isControlling ? "Release control" : "Take control"}
              </SecondaryButton>
            </View>
          </View>

          <View style={styles.controlsGrid}>
            <View style={styles.controlButton}>
              <SecondaryButton
                onPress={() =>
                  selectedSessionId &&
                  void sendSessionInput(selectedSessionId, {
                    actor_id: actorId,
                    input_type: "click",
                    x: 640,
                    y: 360,
                  }).then(() => loadFrame(selectedSessionId))
                }
                disabled={!isControlling}
              >
                Click center
              </SecondaryButton>
            </View>
            <View style={styles.controlButton}>
              <SecondaryButton
                onPress={() =>
                  selectedSessionId &&
                  void sendSessionInput(selectedSessionId, {
                    actor_id: actorId,
                    input_type: "scroll",
                    x: 640,
                    y: 360,
                    delta_y: 480,
                  }).then(() => loadFrame(selectedSessionId))
                }
                disabled={!isControlling}
              >
                Scroll down
              </SecondaryButton>
            </View>
            <View style={styles.controlButton}>
              <SecondaryButton
                onPress={() =>
                  selectedSessionId &&
                  void sendSessionInput(selectedSessionId, {
                    actor_id: actorId,
                    input_type: "keypress",
                    key: "Enter",
                  }).then(() => loadFrame(selectedSessionId))
                }
                disabled={!isControlling}
              >
                Press Enter
              </SecondaryButton>
            </View>
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

const styles = StyleSheet.create({
  content: {
    gap: mobileTheme.spacing[4],
    paddingBottom: mobileTheme.spacing[6],
  },
  actionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: mobileTheme.spacing[2],
  },
  actionButton: {
    minWidth: 140,
  },
  controlsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: mobileTheme.spacing[2],
  },
  controlButton: {
    minWidth: 140,
  },
  loadingWrap: {
    paddingVertical: mobileTheme.spacing[6],
    alignItems: "center",
  },
  errorText: {
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.error,
  },
  emptyText: {
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.textMuted,
  },
  sessionCard: {
    gap: mobileTheme.spacing[2],
  },
  sessionCardActive: {
    borderColor: mobileTheme.colors.primary,
  },
  sessionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: mobileTheme.spacing[2],
  },
  sessionTitle: {
    flex: 1,
    fontSize: mobileTheme.typography.fontSize.sm,
    fontWeight: "700",
    color: mobileTheme.colors.text,
  },
  viewerCard: {
    gap: mobileTheme.spacing[2],
  },
  incidentCard: {
    gap: mobileTheme.spacing[1],
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    borderRadius: mobileTheme.radii.md,
    padding: mobileTheme.spacing[3],
  },
  viewerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: mobileTheme.spacing[2],
  },
  viewerTitle: {
    fontSize: mobileTheme.typography.fontSize.base,
    fontWeight: "800",
    color: mobileTheme.colors.text,
  },
  frameImage: {
    width: "100%",
    aspectRatio: 16 / 10,
    borderRadius: mobileTheme.radii.md,
    backgroundColor: mobileTheme.colors.surfaceMuted,
  },
  framePlaceholder: {
    width: "100%",
    aspectRatio: 16 / 10,
    borderRadius: mobileTheme.radii.md,
    backgroundColor: mobileTheme.colors.surfaceMuted,
    alignItems: "center",
    justifyContent: "center",
    padding: mobileTheme.spacing[4],
  },
  metaText: {
    fontSize: mobileTheme.typography.fontSize.xs,
    color: mobileTheme.colors.textMuted,
  },
  pageTitle: {
    fontSize: mobileTheme.typography.fontSize.sm,
    fontWeight: "700",
    color: mobileTheme.colors.text,
  },
  pageUrl: {
    fontSize: mobileTheme.typography.fontSize.xs,
    color: mobileTheme.colors.textMuted,
  },
});
