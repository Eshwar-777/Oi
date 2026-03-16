import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type WheelEvent } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogContent,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "react-qr-code";
import { useLocation, useSearchParams } from "react-router-dom";
import {
  MaterialSymbol,
  StatusPill,
  SurfaceCard,
} from "@oi/design-system-web";
import { authFetch } from "@/api/authFetch";
import {
  acquireBrowserSessionControl,
  controlBrowserSession,
  connectBrowserSessionLiveSocket,
  connectBrowserSessionStream,
  fetchManagedRunnerStatus,
  fetchBrowserSessionFrame,
  listBrowserSessions,
  releaseBrowserSessionControl,
  sendBrowserSessionInput,
  startManagedRunner,
  stopManagedRunner,
  type ManagedRunnerStatus,
} from "@/api/browserSessions";

const QRCodeGraphic = QRCode as unknown as (props: {
  value: string;
  size?: number;
}) => JSX.Element;

type DeviceType = "web" | "mobile" | "desktop" | string;

interface RegisteredDevice {
  device_id: string;
  device_type: DeviceType;
  device_name: string;
  is_online?: boolean;
  connected?: boolean;
  last_seen?: string;
}

interface PairingSession {
  pairing_id: string;
  code: string;
  status: string;
  created_at: string;
  expires_at: string;
  pairing_uri: string;
  qr_payload: string;
}

interface PairingSessionStatus {
  pairing_id: string;
  status: string;
  created_at?: string;
  expires_at?: string;
  linked_device_id?: string;
  linked_device_name?: string;
  linked_device_type?: string;
}

interface DesktopRunnerStatus {
  enabled: boolean;
  sessionId: string | null;
  cdpUrl: string | null;
  origin: "local_runner" | "server_runner";
  state: "idle" | "registering" | "ready" | "error";
  error?: string;
}

function toErrorMessage(value: unknown, fallback: string) {
  if (value instanceof Error && value.message) return value.message;
  return fallback;
}

async function parseApiError(res: Response, fallback: string) {
  const body = await res.json().catch(() => ({}));
  if (body && typeof body === "object" && typeof (body as { detail?: unknown }).detail === "string") {
    return (body as { detail: string }).detail;
  }
  return fallback;
}

async function fetchDevices() {
  const res = await authFetch("/devices");
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to fetch devices"));
  const data = (await res.json()) as RegisteredDevice[];
  return Array.isArray(data) ? data : [];
}

async function createPairingSession(expiresInSeconds = 300) {
  const res = await authFetch("/devices/pairing/session", {
    method: "POST",
    body: JSON.stringify({ expires_in_seconds: expiresInSeconds }),
  });
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to create pairing session"));
  return (await res.json()) as PairingSession;
}

async function fetchPairingStatus(pairingId: string) {
  const res = await authFetch(`/devices/pairing/session/${encodeURIComponent(pairingId)}`);
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to fetch pairing status"));
  return (await res.json()) as PairingSessionStatus;
}

async function redeemPairing(payload: {
  pairing_id: string;
  code: string;
  device_type: DeviceType;
  device_name: string;
  device_id?: string;
  fcm_token?: string;
}) {
  const res = await authFetch("/devices/pairing/redeem", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to redeem pairing code"));
}

async function deleteDevice(deviceId: string) {
  const res = await authFetch(`/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to remove device"));
}

async function fetchDesktopRunnerStatus(): Promise<DesktopRunnerStatus | null> {
  if (typeof window === "undefined" || !window.electronAPI?.getRunnerStatus) {
    return null;
  }
  return (await window.electronAPI.getRunnerStatus()) as DesktopRunnerStatus;
}

async function startDesktopRunner(): Promise<DesktopRunnerStatus> {
  if (typeof window === "undefined" || !window.electronAPI?.startRunner) {
    throw new Error("Desktop runner controls are not available in this environment.");
  }
  return (await window.electronAPI.startRunner()) as DesktopRunnerStatus;
}

async function fetchRunEvents(runId: string) {
  const res = await authFetch(`/api/events?run_id=${encodeURIComponent(runId)}`);
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to fetch run events"));
  const data = (await res.json()) as { items?: RunEventRecord[] };
  return Array.isArray(data.items) ? data.items : [];
}

async function fetchRunStatus(runId: string) {
  const res = await authFetch(`/api/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to fetch run status"));
  const data = (await res.json()) as { run?: { state?: string }; state?: string };
  return data.run?.state ?? data.state ?? "";
}

function pretty(value?: string) {
  if (!value) return "Never";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

interface SessionFrameState {
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

function mapImageClickToViewport(
  event: MouseEvent<HTMLImageElement>,
  viewport?: { width: number; height: number; dpr: number } | null,
) {
  const image = event.currentTarget;
  const rect = image.getBoundingClientRect();
  const naturalWidth = image.naturalWidth || rect.width;
  const naturalHeight = image.naturalHeight || rect.height;
  if (!rect.width || !rect.height || !naturalWidth || !naturalHeight) return null;

  const containerAspect = rect.width / rect.height;
  const imageAspect = naturalWidth / naturalHeight;
  let renderWidth = rect.width;
  let renderHeight = rect.height;
  let offsetX = 0;
  let offsetY = 0;

  if (containerAspect > imageAspect) {
    renderWidth = rect.height * imageAspect;
    offsetX = (rect.width - renderWidth) / 2;
  } else {
    renderHeight = rect.width / imageAspect;
    offsetY = (rect.height - renderHeight) / 2;
  }

  const localX = event.clientX - rect.left - offsetX;
  const localY = event.clientY - rect.top - offsetY;
  if (localX < 0 || localY < 0 || localX > renderWidth || localY > renderHeight) return null;

  const bitmapX = (localX / renderWidth) * naturalWidth;
  const bitmapY = (localY / renderHeight) * naturalHeight;
  const targetWidth = viewport?.width ?? naturalWidth;
  const targetHeight = viewport?.height ?? naturalHeight;

  return {
    x: Math.round((bitmapX / naturalWidth) * targetWidth),
    y: Math.round((bitmapY / naturalHeight) * targetHeight),
  };
}

function describeSessionLocation(origin: "local_runner" | "server_runner") {
  return origin === "local_runner" ? "This computer" : "Remote browser";
}

function describeSessionSupportText(origin: "local_runner" | "server_runner") {
  return origin === "local_runner"
    ? "Runs close to the user and can work with local sign-ins or apps behind your network."
    : "Runs remotely and is better suited for shared, always-available browser work.";
}

function describeSessionState(status: "idle" | "starting" | "ready" | "busy" | "stopped" | "error") {
  if (status === "ready") return "Ready";
  if (status === "busy") return "In use";
  if (status === "starting") return "Connecting";
  if (status === "stopped") return "Stopped";
  if (status === "error") return "Needs attention";
  return "Idle";
}

function describeSessionName(session: {
  runner_label?: string | null;
  runner_id?: string | null;
  session_id: string;
}) {
  return session.runner_label || session.runner_id || `Browser ${session.session_id.slice(0, 8)}`;
}

function describeTabLabel(page?: { title?: string; url?: string } | null) {
  if (!page) return "New tab";
  const title = page.title?.trim();
  if (title) return title;
  const url = page.url?.trim();
  if (!url || url === "about:blank") return "New tab";
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}

function describeRunnerState(status?: DesktopRunnerStatus | null) {
  if (!status) return "Unavailable";
  if (status.state === "ready") return "Ready";
  if (status.state === "registering") return "Starting";
  if (status.state === "error") return "Needs attention";
  return "Idle";
}

function describeManagedRunnerState(status?: ManagedRunnerStatus | null) {
  if (!status) return "Unavailable";
  if (status.state === "ready") return "Ready";
  if (status.state === "starting") {
    if (status.phase === "provisioning") return status.is_retrying ? "Retrying" : "Setting up";
    if (status.phase === "booting_browser") return "Starting browser";
    if (status.phase === "connecting") return "Connecting";
    return "Starting";
  }
  if (status.state === "stopping") return "Stopping";
  if (status.state === "error") return "Needs attention";
  if (status.state === "disabled") return "Unavailable";
  return "Idle";
}

function describeManagedRunnerBody(status?: ManagedRunnerStatus | null) {
  if (!status) {
    return "Checking whether remote session creation is available for this workspace.";
  }
  if (status.state === "disabled") {
    return "This workspace is not configured to create remote sessions yet. Add the remote browser worker settings to enable it.";
  }
  if (status.state === "error") {
    return status.error || "We couldn’t start your remote browser right now. Retry or use this computer instead.";
  }
  if (status.state === "ready") {
    return "Your remote browser is ready. You can open it here, take control when needed, and stop it when you are done.";
  }
  if (status.state === "starting") {
    if (status.phase === "provisioning") {
      return status.is_retrying
        ? "We hit a startup issue and are trying again automatically."
        : "Creating your private remote browser workspace now.";
    }
    if (status.phase === "booting_browser") {
      return "The worker is live. Chromium is starting in the background.";
    }
    if (status.phase === "connecting") {
      return "The browser is coming online and connecting back to Oye.";
    }
    return "Creating your remote browser now. This usually takes a few seconds.";
  }
  return "Create a remote session when you want a browser that stays available away from this computer.";
}

function managedRunnerPhaseStepState(
  current: ManagedRunnerStatus["phase"] | undefined,
  step: "provisioning" | "booting_browser" | "connecting",
) {
  const order = ["provisioning", "booting_browser", "connecting"] as const;
  const currentIndex = current ? order.indexOf(current as (typeof order)[number]) : -1;
  const stepIndex = order.indexOf(step);
  if (current === "ready") return "done";
  if (current === "failed") return stepIndex < order.length ? "failed" : "pending";
  if (currentIndex > stepIndex) return "done";
  if (currentIndex === stepIndex) return "active";
  return "pending";
}

export function DevicesPage() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [isPageVisible, setIsPageVisible] = useState(
    typeof document === "undefined" ? true : document.visibilityState === "visible",
  );
  const [activeSession, setActiveSession] = useState<PairingSession | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [redeemPairingId, setRedeemPairingId] = useState("");
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemType, setRedeemType] = useState<DeviceType>("desktop");
  const [redeemName, setRedeemName] = useState("");
  const [redeemDeviceId, setRedeemDeviceId] = useState("");
  const [redeemFcm, setRedeemFcm] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [sessionFrame, setSessionFrame] = useState<SessionFrameState | null>(null);
  const [isLiveViewActive, setIsLiveViewActive] = useState(false);
  const [isSessionFrameLoading, setIsSessionFrameLoading] = useState(false);
  const [isRefreshingFrame, setIsRefreshingFrame] = useState(false);
  const [previewPageIndex, setPreviewPageIndex] = useState<number | null>(null);
  const [sessionViewerExpanded, setSessionViewerExpanded] = useState(false);
  const [latestReplanEvent, setLatestReplanEvent] = useState<RunEventRecord | null>(null);
  const [isRequestedRunActive, setIsRequestedRunActive] = useState(false);
  const [requestedRunState, setRequestedRunState] = useState("");
  const [optimisticControlSessionId, setOptimisticControlSessionId] = useState("");
  const [remoteTextInput, setRemoteTextInput] = useState("");
  const [remoteUrlInput, setRemoteUrlInput] = useState("");
  const frameDragRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
  const frameSurfaceRef = useRef<HTMLDivElement | null>(null);
  const pendingMoveRef = useRef<Parameters<typeof sendBrowserSessionInput>[1] | null>(null);
  const moveFlushInFlightRef = useRef(false);
  const pendingWheelRef = useRef<Parameters<typeof sendBrowserSessionInput>[1] | null>(null);
  const wheelFlushInFlightRef = useRef(false);
  const liveSocketRef = useRef<Awaited<ReturnType<typeof connectBrowserSessionLiveSocket>> | null>(null);
  const requestedSessionId = searchParams.get("session_id") || "";
  const requestedRunId = searchParams.get("run_id") || "";
  const isSessionWorkspace = location.pathname === "/sessions";
  const isTouchClient = useMemo(
    () => typeof navigator !== "undefined" && navigator.maxTouchPoints > 0,
    [],
  );
  const controllerActorId = useMemo(() => {
    if (typeof window === "undefined") return "web-controller";
    return `web-${window.location.hostname || "client"}`;
  }, []);

  const devicesQuery = useQuery({
    queryKey: ["settings-devices"],
    queryFn: fetchDevices,
    refetchOnWindowFocus: false,
  });

  const browserSessionsQuery = useQuery({
    queryKey: ["browser-sessions"],
    queryFn: listBrowserSessions,
    refetchOnWindowFocus: false,
  });

  const runnerStatusQuery = useQuery({
    queryKey: ["desktop-runner-status"],
    queryFn: fetchDesktopRunnerStatus,
    refetchInterval: isSessionWorkspace && isPageVisible
      ? (query) => {
          const state = (query.state.data as DesktopRunnerStatus | null)?.state;
          if (state === "registering") return 3_000;
          if (state === "ready") return 20_000;
          return 15_000;
        }
      : false,
  });

  const managedRunnerQuery = useQuery({
    queryKey: ["managed-runner-status"],
    queryFn: fetchManagedRunnerStatus,
    refetchInterval: isSessionWorkspace && isPageVisible
      ? (query) => {
          const state = (query.state.data as ManagedRunnerStatus | null)?.state;
          if (state === "starting" || state === "stopping") return 3_000;
          if (state === "ready") return 20_000;
          if (state === "disabled") return 60_000;
          return 15_000;
        }
      : false,
    retry: false,
  });

  const pairingStatusQuery = useQuery({
    queryKey: ["pairing-status", activeSession?.pairing_id],
    queryFn: () => fetchPairingStatus(activeSession!.pairing_id),
    enabled: Boolean(activeSession?.pairing_id),
    refetchInterval: isPageVisible ? 15_000 : false,
  });

  const createPairingMutation = useMutation({
    mutationFn: createPairingSession,
    onSuccess: (session) => {
      setActiveSession(session);
      setRedeemPairingId(session.pairing_id);
      setRedeemCode(session.code);
      setErrorMessage("");
    },
    onError: (err) => setErrorMessage(toErrorMessage(err, "Failed to create pairing session")),
  });

  const redeemMutation = useMutation({
    mutationFn: redeemPairing,
    onSuccess: async () => {
      setErrorMessage("");
      await queryClient.invalidateQueries({ queryKey: ["settings-devices"] });
      if (activeSession?.pairing_id) {
        await queryClient.invalidateQueries({ queryKey: ["pairing-status", activeSession.pairing_id] });
      }
    },
    onError: (err) => setErrorMessage(toErrorMessage(err, "Failed to redeem code")),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteDevice,
    onSuccess: async () => {
      setErrorMessage("");
      await queryClient.invalidateQueries({ queryKey: ["settings-devices"] });
    },
    onError: (err) => setErrorMessage(toErrorMessage(err, "Failed to remove device")),
  });

  const startRunnerMutation = useMutation({
    mutationFn: startDesktopRunner,
    onSuccess: async () => {
      setErrorMessage("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["desktop-runner-status"] }),
        queryClient.invalidateQueries({ queryKey: ["browser-sessions"] }),
      ]);
    },
    onError: (err) => setErrorMessage(toErrorMessage(err, "Failed to start browser runner")),
  });

  const startManagedRunnerMutation = useMutation({
    mutationFn: startManagedRunner,
    onSuccess: async () => {
      setErrorMessage("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["managed-runner-status"] }),
        queryClient.invalidateQueries({ queryKey: ["browser-sessions"] }),
      ]);
    },
    onError: (err) => setErrorMessage(toErrorMessage(err, "Failed to create remote session")),
  });

  const stopManagedRunnerMutation = useMutation({
    mutationFn: stopManagedRunner,
    onSuccess: async () => {
      setErrorMessage("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["managed-runner-status"] }),
        queryClient.invalidateQueries({ queryKey: ["browser-sessions"] }),
      ]);
    },
    onError: (err) => setErrorMessage(toErrorMessage(err, "Failed to stop remote session")),
  });

  const pairingStatus = pairingStatusQuery.data ?? null;
  const browserSessions = browserSessionsQuery.data ?? [];
  const runnerStatus = runnerStatusQuery.data ?? null;
  const managedRunnerStatus = managedRunnerQuery.data ?? null;
  const selectedSession = useMemo(
    () => browserSessions.find((session) => session.session_id === selectedSessionId) ?? browserSessions[0] ?? null,
    [browserSessions, selectedSessionId],
  );
  const isLinked = pairingStatus?.status?.toLowerCase() === "linked";
  const expiresText = useMemo(
    () => pretty(activeSession?.expires_at || pairingStatus?.expires_at),
    [activeSession?.expires_at, pairingStatus?.expires_at],
  );
  const canControlDesktopRunner = typeof window !== "undefined" && Boolean(window.electronAPI?.startRunner);
  const canInspectManagedRunner = managedRunnerStatus !== null;
  const canControlManagedRunner = managedRunnerStatus?.enabled === true;
  const runnerPrimaryLabel = runnerStatus?.origin === "server_runner" ? "Create remote session" : "Start browser here";
  const runnerSecondaryLabel = runnerStatus?.origin === "server_runner" ? "Remote session worker" : "Desktop runner";

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const handleVisibilityChange = () => {
      setIsPageVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!isLinked) return;
    void queryClient.invalidateQueries({ queryKey: ["settings-devices"] });
  }, [isLinked, queryClient]);

  useEffect(() => {
    if (!runnerStatus?.sessionId) return;
    void queryClient.invalidateQueries({ queryKey: ["browser-sessions"] });
  }, [queryClient, runnerStatus?.sessionId, runnerStatus?.state]);

  useEffect(() => {
    if (!managedRunnerStatus?.session_id) return;
    void queryClient.invalidateQueries({ queryKey: ["browser-sessions"] });
  }, [managedRunnerStatus?.session_id, managedRunnerStatus?.state, queryClient]);

  useEffect(() => {
    if (requestedSessionId && browserSessions.some((session) => session.session_id === requestedSessionId)) {
      setSelectedSessionId(requestedSessionId);
      return;
    }
    if (!selectedSession && browserSessions.length > 0) {
      setSelectedSessionId(browserSessions[0].session_id);
    }
  }, [browserSessions, requestedSessionId, selectedSession]);

  useEffect(() => {
    if (!selectedSession) {
      setSessionFrame(null);
      setIsLiveViewActive(false);
      setPreviewPageIndex(null);
      setRemoteUrlInput("");
      return;
    }
    setRemoteUrlInput((current) => current || selectedSession.pages[0]?.url || "");
    if (!isLiveViewActive) return;

    let cancelled = false;
    let fallbackDisconnect: (() => void) | null = null;
    void connectBrowserSessionLiveSocket(selectedSession.session_id, {
      onFrame: (event) => {
        const payload = event.payload;
        if (!payload || cancelled) return;
        setSessionFrame({
          screenshot: payload.screenshot,
          current_url: payload.current_url,
          page_title: payload.page_title,
          page_id: payload.page_id,
          timestamp: payload.timestamp,
          viewport: payload.viewport,
        });
        if (requestedRunId) {
          void refreshRequestedRunState();
        }
      },
      onError: () => {
        if (cancelled || fallbackDisconnect) return;
        fallbackDisconnect = connectBrowserSessionStream(selectedSession.session_id, (event) => {
          const payload = event.payload;
          if (!payload || cancelled) return;
          setSessionFrame({
            screenshot: payload.screenshot,
            current_url: payload.current_url,
            page_title: payload.page_title,
            page_id: payload.page_id,
            timestamp: payload.timestamp,
            viewport: payload.viewport,
          });
        });
      },
      onClose: () => {
        liveSocketRef.current = null;
      },
    })
      .then((socket) => {
        if (cancelled) {
          socket.close();
          return;
        }
        liveSocketRef.current = socket;
      })
      .catch(() => {
        if (cancelled || fallbackDisconnect) return;
        fallbackDisconnect = connectBrowserSessionStream(selectedSession.session_id, (event) => {
          const payload = event.payload;
          if (!payload || cancelled) return;
          setSessionFrame({
            screenshot: payload.screenshot,
            current_url: payload.current_url,
            page_title: payload.page_title,
            page_id: payload.page_id,
            timestamp: payload.timestamp,
            viewport: payload.viewport,
          });
        });
      });

    return () => {
      cancelled = true;
      liveSocketRef.current?.close();
      liveSocketRef.current = null;
      fallbackDisconnect?.();
    };
  }, [isLiveViewActive, requestedRunId, selectedSession]);

  useEffect(() => {
    if (!selectedSession) return;
    let cancelled = false;
    setIsSessionFrameLoading(true);
    void fetchBrowserSessionFrame(selectedSession.session_id)
      .then((payload) => {
        if (cancelled || !payload) return;
        setSessionFrame({
          screenshot: payload.screenshot,
          current_url: payload.current_url,
          page_title: payload.page_title,
          page_id: payload.page_id,
          timestamp: payload.timestamp,
          viewport: payload.viewport,
        });
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setIsSessionFrameLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSession?.session_id]);

  useEffect(() => {
    setPreviewPageIndex(null);
  }, [selectedSession?.session_id]);

  useEffect(() => {
    if (!requestedRunId) {
      setLatestReplanEvent(null);
      setIsRequestedRunActive(false);
      setRequestedRunState("");
      return;
    }
    let cancelled = false;
    void Promise.all([fetchRunEvents(requestedRunId), fetchRunStatus(requestedRunId)])
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
    if (!requestedRunId || !isRequestedRunActive || !isPageVisible) return;
    const timer = window.setInterval(() => {
      void Promise.all([fetchRunEvents(requestedRunId), fetchRunStatus(requestedRunId)])
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
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [requestedRunId, isPageVisible, isRequestedRunActive]);

  const sessionViewport = sessionFrame?.viewport ?? selectedSession?.viewport;
  const isWholeWindowSession = selectedSession?.metadata?.capture_mode === "browser_window";
  const hasControl =
    (selectedSession?.session_id && optimisticControlSessionId === selectedSession.session_id) ||
    selectedSession?.controller_lock?.actor_id === controllerActorId;
  const lockRemainingMs = selectedSession?.controller_lock
    ? Math.max(0, Date.parse(selectedSession.controller_lock.expires_at) - Date.now())
    : 0;
  const actualPageIndex = useMemo(() => {
    if (!selectedSession?.pages.length) return -1;
    const framePageId = sessionFrame?.page_id?.trim();
    if (framePageId) {
      const frameIndex = selectedSession.pages.findIndex((page) => page.page_id === framePageId);
      if (frameIndex >= 0) return frameIndex;
    }
    const explicitPageId = selectedSession.page_id?.trim();
    if (explicitPageId) {
      const explicitIndex = selectedSession.pages.findIndex((page) => page.page_id === explicitPageId);
      if (explicitIndex >= 0) return explicitIndex;
    }
    const markedIndex = selectedSession.pages.findIndex((page) => page.is_active);
    return markedIndex >= 0 ? markedIndex : 0;
  }, [selectedSession?.page_id, selectedSession?.pages, sessionFrame?.page_id]);
  const activePageIndex =
    selectedSession && previewPageIndex !== null && previewPageIndex >= 0 && previewPageIndex < selectedSession.pages.length
      ? previewPageIndex
      : actualPageIndex;
  const activePage = activePageIndex >= 0 && selectedSession ? selectedSession.pages[activePageIndex] : null;
  const isPreviewingDifferentPage = activePageIndex >= 0 && actualPageIndex >= 0 && activePageIndex !== actualPageIndex;
  const canMoveToPreviousPage = activePageIndex > 0;
  const canMoveToNextPage = selectedSession ? activePageIndex >= 0 && activePageIndex < selectedSession.pages.length - 1 : false;

  const loadLatestSessionFrame = useCallback(
    async (sessionId: string) => {
      const payload = await fetchBrowserSessionFrame(sessionId);
      if (!payload) return;
      setSessionFrame({
        screenshot: payload.screenshot,
        current_url: payload.current_url,
        page_title: payload.page_title,
        page_id: payload.page_id,
        timestamp: payload.timestamp,
        viewport: payload.viewport,
      });
    },
    [],
  );

  const refreshSelectedSession = useCallback(async () => {
    await browserSessionsQuery.refetch();
  }, [browserSessionsQuery]);

  const refreshSessionPreview = useCallback(async () => {
    if (!selectedSession) return;
    setIsRefreshingFrame(true);
    try {
      const sent = liveSocketRef.current?.sendControl({ action: "refresh_stream" }) ?? false;
      if (!sent) {
        await controlBrowserSession(selectedSession.session_id, { action: "refresh_stream" });
      }
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      await refreshSelectedSession();
      await loadLatestSessionFrame(selectedSession.session_id);
      setErrorMessage("");
    } catch (err) {
      setErrorMessage(toErrorMessage(err, "Failed to refresh preview"));
    } finally {
      setIsRefreshingFrame(false);
    }
  }, [loadLatestSessionFrame, refreshSelectedSession, selectedSession]);

  const handleSwitchPage = useCallback(
    async (direction: -1 | 1) => {
      if (!selectedSession || activePageIndex < 0) return;
      const nextPage = selectedSession.pages[activePageIndex + direction];
      if (!nextPage) return;
      try {
        setPreviewPageIndex(activePageIndex + direction);
        const sent = liveSocketRef.current?.sendControl({
          action: hasControl ? "activate_page" : "preview_page",
          page_id: nextPage.page_id,
          page_title: nextPage.title,
          url: nextPage.url,
          tab_index: activePageIndex + direction,
        }) ?? false;
        if (!sent) {
          await controlBrowserSession(selectedSession.session_id, {
            action: hasControl ? "activate_page" : "preview_page",
            page_id: nextPage.page_id,
            page_title: nextPage.title,
            url: nextPage.url,
            tab_index: activePageIndex + direction,
          });
        }
        await new Promise((resolve) => window.setTimeout(resolve, hasControl ? 350 : 250));
        await refreshSelectedSession();
        if (!isLiveViewActive || hasControl) {
          await loadLatestSessionFrame(selectedSession.session_id);
        }
        setErrorMessage("");
      } catch (err) {
        setErrorMessage(toErrorMessage(err, "Failed to preview tab"));
      }
    },
    [activePageIndex, hasControl, isLiveViewActive, loadLatestSessionFrame, refreshSelectedSession, selectedSession],
  );

  const handleSelectPage = useCallback(
    async (pageIndex: number) => {
      if (!selectedSession) return;
      const targetPage = selectedSession.pages[pageIndex];
      if (!targetPage) return;
      try {
        setPreviewPageIndex(pageIndex);
        const sent = liveSocketRef.current?.sendControl({
          action: hasControl ? "activate_page" : "preview_page",
          page_id: targetPage.page_id,
          page_title: targetPage.title,
          url: targetPage.url,
          tab_index: pageIndex,
        }) ?? false;
        if (!sent) {
          await controlBrowserSession(selectedSession.session_id, {
            action: hasControl ? "activate_page" : "preview_page",
            page_id: targetPage.page_id,
            page_title: targetPage.title,
            url: targetPage.url,
            tab_index: pageIndex,
          });
        }
        await new Promise((resolve) => window.setTimeout(resolve, hasControl ? 350 : 250));
        await refreshSelectedSession();
        if (!isLiveViewActive || hasControl) {
          await loadLatestSessionFrame(selectedSession.session_id);
        }
        setErrorMessage("");
      } catch (err) {
        setErrorMessage(toErrorMessage(err, "Failed to switch tabs"));
      }
    },
    [hasControl, isLiveViewActive, loadLatestSessionFrame, refreshSelectedSession, selectedSession],
  );

  const handleOpenTab = useCallback(async () => {
    if (!selectedSession || !hasControl) return;
    try {
      const sent = liveSocketRef.current?.sendControl({
        action: "open_tab",
        url: "about:blank",
      }) ?? false;
      if (!sent) {
        await controlBrowserSession(selectedSession.session_id, {
          action: "open_tab",
          url: "about:blank",
        });
      }
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      await refreshSelectedSession();
      await loadLatestSessionFrame(selectedSession.session_id);
      setPreviewPageIndex(null);
      setIsLiveViewActive(true);
      setErrorMessage("");
    } catch (err) {
      setErrorMessage(toErrorMessage(err, "Failed to open a new tab"));
    }
  }, [hasControl, loadLatestSessionFrame, refreshSelectedSession, selectedSession]);

  useEffect(() => {
    if (!selectedSession?.session_id || hasControl || previewPageIndex === null) return;
    const sent = liveSocketRef.current?.sendControl({ action: "clear_preview_page" }) ?? false;
    if (!sent) {
      void controlBrowserSession(selectedSession.session_id, { action: "clear_preview_page" }).catch(() => {});
    }
    setPreviewPageIndex(null);
  }, [hasControl, previewPageIndex, selectedSession?.session_id]);

  const sendFrameInput = useCallback(
    async (
      payload: Parameters<typeof sendBrowserSessionInput>[1],
      fallback: string,
    ) => {
      if (!selectedSession || !hasControl) return;
      try {
        const nextPayload = {
          ...payload,
          page_id: activePage?.page_id ?? payload.page_id,
        };
        const sent = liveSocketRef.current?.sendInput(nextPayload) ?? false;
        if (!sent) {
          await sendBrowserSessionInput(selectedSession.session_id, nextPayload);
        }
      } catch (err) {
        const message = toErrorMessage(err, fallback);
        if (message.includes("Acquire controller lock")) {
          setOptimisticControlSessionId("");
          void browserSessionsQuery.refetch();
        }
        setErrorMessage(message);
      }
    },
    [activePage?.page_id, browserSessionsQuery, hasControl, selectedSession],
  );

  const submitRemoteText = useCallback(async () => {
    const text = remoteTextInput.trim();
    if (!text || !hasControl) return;
    await sendFrameInput(
      {
        actor_id: controllerActorId,
        input_type: "type",
        text,
      },
      "Failed to type into the remote browser",
    );
    setRemoteTextInput("");
  }, [controllerActorId, hasControl, remoteTextInput, sendFrameInput]);

  const sendRemoteKey = useCallback(
    async (key: string) => {
      if (!hasControl) return;
      await sendFrameInput(
        {
          actor_id: controllerActorId,
          input_type: "keypress",
          key,
        },
        `Failed to send ${key} to the remote browser`,
      );
    },
    [controllerActorId, hasControl, sendFrameInput],
  );

  const submitRemoteNavigation = useCallback(async () => {
    if (!selectedSession) return;
    const raw = remoteUrlInput.trim();
    if (!raw) return;
    const looksLikeUrl = /^[a-z]+:\/\//i.test(raw) || /^[\w.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(raw);
    const targetUrl = looksLikeUrl
      ? (/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`)
      : `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
    const sent = liveSocketRef.current?.sendControl({
      action: "navigate",
      url: targetUrl,
    }) ?? false;
    if (!sent) {
      await controlBrowserSession(selectedSession.session_id, {
        action: "navigate",
        url: targetUrl,
      });
    }
    setIsLiveViewActive(true);
    setErrorMessage("");
  }, [remoteUrlInput, selectedSession]);

  const handleFramePointerDown = useCallback(
    async (event: PointerEvent<HTMLImageElement>) => {
      if (!selectedSession || !hasControl) return;
      if (event.button !== 0) return;
      const point = mapImageClickToViewport(event as unknown as MouseEvent<HTMLImageElement>, selectedSession.viewport);
      if (!point) return;
      frameDragRef.current = {
        pointerId: event.pointerId,
        startX: point.x,
        startY: point.y,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      await sendFrameInput(
        {
          actor_id: controllerActorId,
          input_type: "mouse_down",
          x: point.x,
          y: point.y,
          button: "left",
        },
        "Failed to start frame gesture",
      );
    },
    [controllerActorId, hasControl, selectedSession, sendFrameInput],
  );

  const handleFramePointerMove = useCallback(
    async (event: PointerEvent<HTMLImageElement>) => {
      if (!selectedSession || !hasControl) return;
      const point = mapImageClickToViewport(event as unknown as MouseEvent<HTMLImageElement>, selectedSession.viewport);
      if (!point) return;
      if (!frameDragRef.current || frameDragRef.current.pointerId !== event.pointerId) return;
      pendingMoveRef.current = {
        actor_id: controllerActorId,
        input_type: "move",
        x: point.x,
        y: point.y,
      };
      if (moveFlushInFlightRef.current) return;
      moveFlushInFlightRef.current = true;
      while (pendingMoveRef.current) {
        const nextPayload = pendingMoveRef.current;
        pendingMoveRef.current = null;
        await sendFrameInput(nextPayload, "Failed to move pointer");
      }
      moveFlushInFlightRef.current = false;
    },
    [controllerActorId, hasControl, selectedSession, sendFrameInput],
  );

  const finishFramePointer = useCallback(
    async (event: PointerEvent<HTMLImageElement>, button: "left" | "right") => {
      if (!selectedSession || !hasControl) return;
      const activeDrag = frameDragRef.current;
      frameDragRef.current = null;
      const point = mapImageClickToViewport(event as unknown as MouseEvent<HTMLImageElement>, selectedSession.viewport);
      if (!point) return;
      if (activeDrag && activeDrag.pointerId === event.pointerId && button === "left") {
        await sendFrameInput(
          {
            actor_id: controllerActorId,
            input_type: "mouse_up",
            x: point.x,
            y: point.y,
            button: "left",
          },
          "Failed to finish frame gesture",
        );
        return;
      }
      await sendFrameInput(
        {
          actor_id: controllerActorId,
          input_type: "click",
          x: point.x,
          y: point.y,
          button,
        },
        button === "right" ? "Failed to right click session" : "Failed to click session",
      );
    },
    [controllerActorId, hasControl, selectedSession, sendFrameInput],
  );

  const handleFrameWheel = useCallback(
    async (
      event:
        | WheelEvent<HTMLImageElement>
        | globalThis.WheelEvent,
    ) => {
      if (!selectedSession || !hasControl) return;
      event.preventDefault();
      const point = mapImageClickToViewport(event as unknown as MouseEvent<HTMLImageElement>, selectedSession.viewport);
      if (!point) return;
      const deltaX = Math.round(event.deltaX);
      const deltaY = Math.round(event.deltaY);
      const queued = pendingWheelRef.current;
      pendingWheelRef.current = {
        actor_id: controllerActorId,
        input_type: "scroll",
        x: point.x,
        y: point.y,
        delta_x: (queued?.delta_x ?? 0) + deltaX,
        delta_y: (queued?.delta_y ?? 0) + deltaY,
      };
      if (wheelFlushInFlightRef.current) return;
      wheelFlushInFlightRef.current = true;
      while (pendingWheelRef.current) {
        const nextPayload = pendingWheelRef.current;
        pendingWheelRef.current = null;
        await sendFrameInput(nextPayload, "Failed to scroll session");
      }
      wheelFlushInFlightRef.current = false;
    },
    [controllerActorId, hasControl, selectedSession, sendFrameInput],
  );

  useEffect(() => {
    const element = frameSurfaceRef.current;
    if (!element) return;

    const nativeWheelHandler = (event: globalThis.WheelEvent) => {
      if (!hasControl) return;
      event.preventDefault();
      event.stopPropagation();
      void handleFrameWheel(event);
    };

    element.addEventListener("wheel", nativeWheelHandler, { passive: false });
    return () => {
      element.removeEventListener("wheel", nativeWheelHandler);
    };
  }, [handleFrameWheel, hasControl, sessionFrame?.screenshot, selectedSession?.session_id]);

  const renderLiveFrame = useCallback(
    (options?: { expanded?: boolean }) => (
      <Box
        ref={frameSurfaceRef}
        sx={{
          borderRadius: options?.expanded ? "0" : "20px",
          border: options?.expanded ? "none" : "1px solid var(--border-subtle)",
          backgroundColor: "var(--surface-card-muted)",
          overflow: "hidden",
          overscrollBehavior: "contain",
          width: "100%",
        }}
      >
        <Box
          sx={{
            px: { xs: 1, md: 1.5 },
            pt: { xs: 1, md: 1.25 },
            pb: 1,
            borderBottom: "1px solid var(--border-subtle)",
            background:
              "linear-gradient(180deg, rgba(244,241,233,0.96) 0%, rgba(239,235,226,0.94) 100%)",
          }}
        >
          <Stack spacing={1}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1.5}>
              <Stack direction="row" spacing={0.8} alignItems="center">
                <Box sx={{ width: 10, height: 10, borderRadius: "999px", bgcolor: "#F26B5E" }} />
                <Box sx={{ width: 10, height: 10, borderRadius: "999px", bgcolor: "#F4BF4F" }} />
                <Box sx={{ width: 10, height: 10, borderRadius: "999px", bgcolor: "#61C554" }} />
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ letterSpacing: "0.06em", textTransform: "uppercase" }}>
                {isWholeWindowSession
                  ? hasControl
                    ? "Live browser window"
                    : "Browser window preview"
                  : hasControl
                    ? "Remote browser window"
                    : "Remote browser preview"}
              </Typography>
            </Stack>
            {!isWholeWindowSession ? (
              <Box
                sx={{
                  display: "flex",
                  gap: 1,
                  overflowX: "auto",
                  pb: 0.25,
                  scrollbarWidth: "thin",
                }}
              >
                {selectedSession?.pages.map((page, pageIndex) => {
                  const isSelected = pageIndex === activePageIndex;
                  const isLive = pageIndex === actualPageIndex;
                  return (
                    <Button
                      key={page.page_id}
                      variant={isSelected ? "contained" : "outlined"}
                      size="small"
                      onClick={() => {
                        void handleSelectPage(pageIndex);
                      }}
                      sx={{
                        flexShrink: 0,
                        minWidth: 0,
                        maxWidth: { xs: 180, md: 220 },
                        borderRadius: "14px 14px 10px 10px",
                        px: 1.5,
                        py: 0.8,
                        justifyContent: "flex-start",
                        textTransform: "none",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        boxShadow: isSelected ? "0 10px 20px rgba(24,32,52,0.12)" : "none",
                        backgroundColor: isSelected ? "var(--surface-card)" : "rgba(255,255,255,0.68)",
                        borderColor: isSelected ? "var(--border-strong)" : "var(--border-subtle)",
                        color: "var(--text-primary)",
                      }}
                    >
                      <Box sx={{ minWidth: 0, textAlign: "left" }}>
                        <Typography variant="body2" sx={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis" }}>
                          {describeTabLabel(page)}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {isSelected ? (isLive ? "Live tab" : hasControl ? "Selected" : "Previewing") : isLive ? "Current" : "Tab"}
                        </Typography>
                      </Box>
                    </Button>
                  );
                })}
                {hasControl ? (
                  <Tooltip title="Open a new remote tab">
                    <IconButton
                      aria-label="Open a new tab"
                      onClick={() => {
                        void handleOpenTab();
                      }}
                      sx={{
                        flexShrink: 0,
                        width: 40,
                        height: 40,
                        borderRadius: "14px",
                        border: "1px solid var(--border-default)",
                        bgcolor: "rgba(255,255,255,0.75)",
                      }}
                    >
                      <MaterialSymbol name="add" sx={{ fontSize: 20 }} />
                    </IconButton>
                  </Tooltip>
                ) : null}
              </Box>
            ) : (
              <Typography variant="body2" color="text.secondary">
                This stream shows the full browser window, including the tab strip and address bar. Take control to use it directly.
              </Typography>
            )}
            <Box
              sx={{
                minWidth: 0,
                px: 1.4,
                py: 1,
                borderRadius: "999px",
                backgroundColor: "rgba(255,255,255,0.76)",
                border: "1px solid rgba(109,118,138,0.18)",
              }}
            >
              <Typography variant="body2" sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {sessionFrame?.current_url || activePage?.url || selectedSession?.pages[0]?.url || "about:blank"}
              </Typography>
            </Box>
          </Stack>
        </Box>
        {sessionFrame?.screenshot ? (
          <Box sx={{ position: "relative" }}>
            <Box
              component="img"
              src={sessionFrame.screenshot}
              alt="Live browser session"
              onPointerDown={(event: PointerEvent<HTMLImageElement>) => {
                void handleFramePointerDown(event);
              }}
              onPointerMove={(event: PointerEvent<HTMLImageElement>) => {
                void handleFramePointerMove(event);
              }}
              onPointerUp={(event: PointerEvent<HTMLImageElement>) => {
                void finishFramePointer(event, "left");
              }}
              onPointerCancel={() => {
                frameDragRef.current = null;
              }}
              onContextMenu={(event: MouseEvent<HTMLImageElement>) => {
                event.preventDefault();
                void finishFramePointer(event as unknown as PointerEvent<HTMLImageElement>, "right");
              }}
              sx={{
                width: "100%",
                display: "block",
                maxHeight: options?.expanded ? "calc(100vh - 120px)" : 420,
                objectFit: "contain",
                backgroundColor: "#111",
                cursor: hasControl ? "crosshair" : "default",
                touchAction: "none",
                overscrollBehavior: "contain",
              }}
            />
            {!isWholeWindowSession && hasControl && selectedSession && selectedSession.pages.length > 1 ? (
              <>
                <IconButton
                  aria-label="Preview previous tab"
                  onClick={() => {
                    void handleSwitchPage(-1);
                  }}
                  disabled={!canMoveToPreviousPage}
                  sx={{
                    position: "absolute",
                    left: 16,
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: 44,
                    height: 44,
                    borderRadius: "999px",
                    backgroundColor: "rgba(255,255,255,0.9)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-default)",
                    boxShadow: "0 12px 24px rgba(0,0,0,0.18)",
                    "&:hover": {
                      backgroundColor: "rgba(255,255,255,0.98)",
                    },
                    "&.Mui-disabled": {
                      backgroundColor: "rgba(255,255,255,0.55)",
                    },
                  }}
                >
                  <MaterialSymbol name="chevron_left" sx={{ fontSize: 24 }} />
                </IconButton>
                <IconButton
                  aria-label="Preview next tab"
                  onClick={() => {
                    void handleSwitchPage(1);
                  }}
                  disabled={!canMoveToNextPage}
                  sx={{
                    position: "absolute",
                    right: 16,
                    top: "50%",
                    transform: "translateY(-50%)",
                    width: 44,
                    height: 44,
                    borderRadius: "999px",
                    backgroundColor: "rgba(255,255,255,0.9)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-default)",
                    boxShadow: "0 12px 24px rgba(0,0,0,0.18)",
                    "&:hover": {
                      backgroundColor: "rgba(255,255,255,0.98)",
                    },
                    "&.Mui-disabled": {
                      backgroundColor: "rgba(255,255,255,0.55)",
                    },
                  }}
                >
                  <MaterialSymbol name="chevron_right" sx={{ fontSize: 24 }} />
                </IconButton>
              </>
            ) : null}
          </Box>
        ) : (
          <Box sx={{ p: 4 }}>
            <Typography variant="body2" color="text.secondary">
              {isSessionFrameLoading
                ? "Loading the latest browser preview."
                : isLiveViewActive
                  ? "Waiting for the live frame."
                  : "Live view is paused. Open it when you want to watch the browser."}
            </Typography>
          </Box>
        )}
      </Box>
    ),
    [
      activePage?.url,
      activePageIndex,
      actualPageIndex,
      handleOpenTab,
      finishFramePointer,
      handleFramePointerDown,
      handleFramePointerMove,
      handleSelectPage,
      handleFrameWheel,
      handleSwitchPage,
      hasControl,
      isWholeWindowSession,
      isLiveViewActive,
      isSessionFrameLoading,
      selectedSession?.pages,
      sessionFrame?.screenshot,
      sessionFrame?.current_url,
    ],
  );

  const refreshRequestedRunState = useCallback(async () => {
    if (!requestedRunId) return;
    try {
      const [items, state] = await Promise.all([fetchRunEvents(requestedRunId), fetchRunStatus(requestedRunId)]);
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

  useEffect(() => {
    const handleRunStateChanged = (event: Event) => {
      const runId = (event as CustomEvent<{ runId?: string }>).detail?.runId;
      if (!requestedRunId || runId !== requestedRunId) return;
      void refreshRequestedRunState();
    };
    window.addEventListener("oi:run-state-changed", handleRunStateChanged);
    return () => {
      window.removeEventListener("oi:run-state-changed", handleRunStateChanged);
    };
  }, [refreshRequestedRunState, requestedRunId]);

  return (
    <Stack spacing={3}>
      {errorMessage ? (
        <SurfaceCard>
          <Typography variant="body2" color="error.main">
            {errorMessage}
          </Typography>
        </SurfaceCard>
      ) : null}
      {requestedSessionId ? (
        <SurfaceCard>
          <Typography variant="body2" fontWeight={700}>
            Focused live session
          </Typography>
          <Typography variant="body2" color="text.secondary">
            This page opened from an incident and will focus the matching browser session as soon as it is available.
          </Typography>
          {requestedRunId && requestedRunState ? (
            <Box sx={{ mt: 1 }}>
              <StatusPill
                label={`Run ${requestedRunState.replace(/_/g, " ")}`}
                tone={isRequestedRunActive ? "warning" : requestedRunState === "succeeded" ? "success" : "neutral"}
              />
            </Box>
          ) : null}
          {requestedRunId ? (
            <Typography variant="body2" color="text.secondary" mt={1}>
              {latestReplanEvent?.payload
                ? `Latest adaptation for run ${requestedRunId}: after ${latestReplanEvent.payload.completed_command ?? "the last step"}, the agent refreshed the plan because ${describeReplanReasons(latestReplanEvent.payload.replan_reasons)}.`
                : `If the run adapts to the page during takeover or resume, this viewer will show the latest replan reason for run ${requestedRunId} once it is emitted.`}
            </Typography>
          ) : null}
        </SurfaceCard>
      ) : null}

      {!isSessionWorkspace ? (
        <SurfaceCard
          eyebrow="Pairing"
          title="Link a new device"
          subtitle="Generate a short-lived code and QR payload for desktop, mobile, or browser clients."
          actions={
            <Button
              variant="contained"
              onClick={() => createPairingMutation.mutate(300)}
              disabled={createPairingMutation.isPending}
            >
              {createPairingMutation.isPending ? "Generating..." : "Generate code"}
            </Button>
          }
        >
        {activeSession ? (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", lg: "320px minmax(0, 1fr)" },
              gap: 2,
            }}
          >
            <Box
              sx={{
                p: 3,
                borderRadius: "20px",
                backgroundColor: "var(--surface-card-muted)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <Typography variant="overline" color="text.secondary">
                Pairing code
              </Typography>
              <Typography variant="h2" sx={{ fontSize: "2.5rem", mt: 1 }}>
                {activeSession.code}
              </Typography>
              <Typography variant="body2" color="text.secondary" mt={1.5}>
                Expires: {expiresText}
              </Typography>
              <Stack direction="row" spacing={1} alignItems="center" mt={1.5}>
                <Typography variant="body2" color="text.secondary">
                  Status
                </Typography>
                <StatusPill label={pairingStatus?.status || activeSession.status} tone={isLinked ? "success" : "warning"} />
              </Stack>
              {isLinked ? (
                <Typography variant="body2" color="success.main" mt={1.5}>
                  Linked: {pairingStatus?.linked_device_name} ({pairingStatus?.linked_device_type})
                </Typography>
              ) : null}
            </Box>

            <Box
              sx={{
                p: 3,
                borderRadius: "20px",
                backgroundColor: "var(--surface-card-muted)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <Typography variant="overline" color="text.secondary">
                QR payload
              </Typography>
              <Box
                sx={{
                  mt: 2,
                  mb: 2,
                  p: 2,
                  display: "inline-flex",
                  borderRadius: "18px",
                  backgroundColor: "var(--surface-card)",
                }}
              >
                <QRCodeGraphic value={activeSession.qr_payload} size={176} />
              </Box>
              <Typography
                variant="body2"
                sx={{
                  p: 2,
                  borderRadius: "16px",
                  backgroundColor: "var(--surface-card)",
                  wordBreak: "break-word",
                }}
              >
                {activeSession.qr_payload}
              </Typography>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25} mt={2}>
                <Button
                  variant="outlined"
                  onClick={async () => navigator.clipboard.writeText(activeSession.qr_payload)}
                >
                  Copy payload
                </Button>
                <Button
                  variant="outlined"
                  onClick={async () => navigator.clipboard.writeText(activeSession.code)}
                >
                  Copy code
                </Button>
                <Button variant="text" onClick={() => pairingStatusQuery.refetch()}>
                  Refresh status
                </Button>
              </Stack>
            </Box>
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No active pairing session yet. Generate one to display its QR payload and code.
          </Typography>
        )}
        </SurfaceCard>
      ) : null}

      <SurfaceCard
        eyebrow="Sessions"
        title="Connected browsers"
        subtitle="Pick a browser, inspect the latest page, and only open live view when you want to step in."
        actions={
          <Stack direction="row" spacing={1} alignItems="center">
            {canControlManagedRunner ? (
              <Button
                variant="contained"
                onClick={() => startManagedRunnerMutation.mutate()}
                disabled={
                  startManagedRunnerMutation.isPending ||
                  managedRunnerStatus?.state === "ready" ||
                  managedRunnerStatus?.state === "starting" ||
                  managedRunnerStatus?.state === "stopping"
                }
              >
                {startManagedRunnerMutation.isPending
                  ? "Starting..."
                  : managedRunnerStatus?.state === "ready"
                    ? "Remote session ready"
                    : managedRunnerStatus?.state === "error" && managedRunnerStatus?.can_retry
                      ? "Retry remote session"
                    : "Create remote session"}
              </Button>
            ) : null}
            <Tooltip title="Refresh sessions">
              <Button variant="text" onClick={() => browserSessionsQuery.refetch()}>
                <MaterialSymbol name="refresh" sx={{ fontSize: 20 }} />
              </Button>
            </Tooltip>
          </Stack>
        }
      >
        {browserSessions.length === 0 ? (
          <Box
            sx={{
              p: 3,
              borderRadius: "24px",
              border: "1px solid var(--border-subtle)",
              background:
                "linear-gradient(135deg, color-mix(in srgb, var(--brand-primary) 10%, transparent), var(--surface-card-muted))",
            }}
          >
            <Typography variant="h6" sx={{ mb: 1 }}>
              No browser is connected yet
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 720 }}>
              To make a browser appear here, start a trusted runner on this computer or connect a remote runner that can
              register with Oye. Once it connects, this page becomes the handoff surface for preview, live view, and manual control.
            </Typography>
            {canControlDesktopRunner ? (
              <Box
                sx={{
                  mt: 2.5,
                  p: 2,
                  borderRadius: "20px",
                  backgroundColor: "var(--surface-card)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <Stack
                  direction={{ xs: "column", md: "row" }}
                  justifyContent="space-between"
                  alignItems={{ xs: "flex-start", md: "center" }}
                  gap={1.5}
                >
                  <Box>
                    <Typography variant="body1" fontWeight={700}>
                      {runnerSecondaryLabel}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      {runnerStatus?.state === "error"
                        ? runnerStatus.error || "The runner could not start with its current configuration."
                        : runnerStatus?.state === "registering"
                          ? "The runner is launching the browser and registering the session now."
                          : "Use the desktop host to launch and register the browser without leaving this screen."}
                    </Typography>
                  </Box>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <StatusPill
                      label={describeRunnerState(runnerStatus)}
                      tone={runnerStatus?.state === "ready" ? "success" : runnerStatus?.state === "error" ? "danger" : "warning"}
                    />
                    <Button
                      variant="contained"
                      onClick={() => startRunnerMutation.mutate()}
                      disabled={startRunnerMutation.isPending || runnerStatus?.state === "registering"}
                    >
                      {startRunnerMutation.isPending
                        ? "Starting..."
                        : runnerStatus?.state === "ready"
                          ? "Restart runner"
                          : runnerPrimaryLabel}
                    </Button>
                  </Stack>
                </Stack>
              </Box>
            ) : null}
            {canInspectManagedRunner ? (
              <Box
                sx={{
                  mt: 2.5,
                  p: 2,
                  borderRadius: "20px",
                  backgroundColor: "var(--surface-card)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <Stack
                  direction={{ xs: "column", md: "row" }}
                  justifyContent="space-between"
                  alignItems={{ xs: "flex-start", md: "center" }}
                  gap={1.5}
                >
                  <Box>
                    <Typography variant="body1" fontWeight={700}>
                      Remote session
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      {describeManagedRunnerBody(managedRunnerStatus)}
                    </Typography>
                    {managedRunnerStatus?.detail && managedRunnerStatus.state === "error" ? (
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.75 }}>
                        Details: {managedRunnerStatus.detail}
                      </Typography>
                    ) : null}
                    {managedRunnerStatus?.state === "starting" ? (
                      <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ mt: 1.5 }}>
                        {([
                          ["provisioning", "Create workspace"],
                          ["booting_browser", "Start browser"],
                          ["connecting", "Connect to Oye"],
                        ] as const).map(([phase, label]) => {
                          const stepState = managedRunnerPhaseStepState(managedRunnerStatus.phase, phase);
                          return (
                            <Box
                              key={phase}
                              sx={{
                                px: 1.5,
                                py: 1,
                                borderRadius: "999px",
                                border: "1px solid var(--border-subtle)",
                                backgroundColor:
                                  stepState === "done"
                                    ? "color-mix(in srgb, var(--status-success) 16%, transparent)"
                                    : stepState === "active"
                                      ? "color-mix(in srgb, var(--brand-primary) 12%, transparent)"
                                      : "var(--surface-card-muted)",
                              }}
                            >
                              <Typography variant="caption" fontWeight={700} color="text.primary">
                                {label}
                              </Typography>
                            </Box>
                          );
                        })}
                      </Stack>
                    ) : null}
                    {managedRunnerStatus?.retry_count ? (
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.75 }}>
                        Attempt {managedRunnerStatus.retry_count + 1} of {(managedRunnerStatus.max_retries ?? 1) + 1}
                      </Typography>
                    ) : null}
                  </Box>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <StatusPill
                      label={describeManagedRunnerState(managedRunnerStatus)}
                      tone={
                        managedRunnerStatus?.state === "ready"
                          ? "success"
                          : managedRunnerStatus?.state === "error"
                            ? "danger"
                            : managedRunnerStatus?.state === "disabled"
                              ? "neutral"
                              : "warning"
                      }
                    />
                    <Button
                      variant="contained"
                      onClick={() => startManagedRunnerMutation.mutate()}
                      disabled={
                        !canControlManagedRunner ||
                        startManagedRunnerMutation.isPending ||
                        managedRunnerStatus?.state === "ready" ||
                        managedRunnerStatus?.state === "starting" ||
                        managedRunnerStatus?.state === "stopping"
                      }
                    >
                      {startManagedRunnerMutation.isPending
                        ? "Starting..."
                        : managedRunnerStatus?.state === "ready"
                          ? "Ready"
                          : managedRunnerStatus?.state === "error" && managedRunnerStatus?.can_retry
                            ? "Retry remote session"
                            : "Create remote session"}
                    </Button>
                    <Button
                      variant="text"
                      onClick={() => stopManagedRunnerMutation.mutate()}
                      disabled={
                        !canControlManagedRunner ||
                        stopManagedRunnerMutation.isPending ||
                        (managedRunnerStatus?.state !== "ready" && managedRunnerStatus?.state !== "starting")
                      }
                    >
                      {stopManagedRunnerMutation.isPending
                        ? "Stopping..."
                        : managedRunnerStatus?.state === "starting"
                          ? "Cancel startup"
                          : "Stop remote session"}
                    </Button>
                  </Stack>
                </Stack>
              </Box>
            ) : null}
            <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} mt={2.5}>
              <Box
                sx={{
                  flex: 1,
                  p: 2,
                  borderRadius: "20px",
                  backgroundColor: "var(--surface-card)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <Typography variant="body2" fontWeight={700}>
                  This computer
                </Typography>
                <Typography variant="body2" color="text.secondary" mt={0.75}>
                  Start the paired local runner and the browser will appear here automatically.
                </Typography>
              </Box>
              <Box
                sx={{
                  flex: 1,
                  p: 2,
                  borderRadius: "20px",
                  backgroundColor: "var(--surface-card)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <Typography variant="body2" fontWeight={700}>
                  Remote browser
                </Typography>
                <Typography variant="body2" color="text.secondary" mt={0.75}>
                  Use a remote runner when you want a browser that stays available outside the user's machine.
                </Typography>
              </Box>
            </Stack>
          </Box>
        ) : (
          <Stack spacing={2}>
            <TextField
              select
              label="Choose a browser"
              value={selectedSession?.session_id ?? ""}
              onChange={(event) => setSelectedSessionId(event.target.value)}
            >
              {browserSessions.map((session) => (
                <MenuItem key={session.session_id} value={session.session_id}>
                  {describeSessionName(session)} · {describeSessionState(session.status)}
                </MenuItem>
              ))}
            </TextField>

            {selectedSession ? (
              <>
                <Box
                  sx={{
                    p: { xs: 2, md: 2.5 },
                    borderRadius: "24px",
                    border: "1px solid var(--border-subtle)",
                    background:
                      "linear-gradient(160deg, color-mix(in srgb, var(--brand-primary) 9%, transparent), var(--surface-card-muted))",
                  }}
                >
                  <Stack spacing={2}>
                    <Stack
                      direction={{ xs: "column", md: "row" }}
                      justifyContent="space-between"
                      alignItems={{ xs: "flex-start", md: "flex-start" }}
                      gap={2}
                    >
                      <Box sx={{ maxWidth: 720 }}>
                        <Typography variant="overline" color="text.secondary">
                          {describeSessionLocation(selectedSession.origin)}
                        </Typography>
                        <Typography variant="h5" sx={{ mt: 0.5 }}>
                          {describeSessionName(selectedSession)}
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                          {describeSessionSupportText(selectedSession.origin)}
                        </Typography>
                      </Box>
                      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                        <StatusPill
                          label={describeSessionState(selectedSession.status)}
                          tone={selectedSession.status === "ready" ? "success" : selectedSession.status === "error" ? "danger" : "warning"}
                        />
                        <StatusPill label={selectedSession.automation_engine.replace("_", " ")} tone="brand" />
                        {selectedSession.runner_label ? <StatusPill label={selectedSession.runner_label} tone="neutral" /> : null}
                      </Stack>
                    </Stack>

                    <Box
                      sx={{
                        p: 2,
                        borderRadius: "20px",
                        border: "1px solid var(--border-subtle)",
                        backgroundColor: "var(--surface-card)",
                      }}
                    >
                      <Stack
                        direction={{ xs: "column", lg: "row" }}
                        justifyContent="space-between"
                        alignItems={{ xs: "flex-start", lg: "center" }}
                        gap={2}
                      >
                        <Box sx={{ maxWidth: 680 }}>
                          <Typography variant="body1" fontWeight={700}>
                            {isLiveViewActive ? "Live view is on" : "Live view is off"}
                          </Typography>
                          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                            {isLiveViewActive
                              ? "You are watching the browser in real time. Turn live view off when you no longer need it."
                              : "You are looking at the latest saved preview. Turn on live view only when you need continuous updates."}
                          </Typography>
                        </Box>
                        <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                          <Button
                            variant={isLiveViewActive ? "outlined" : "contained"}
                            onClick={() => setIsLiveViewActive((value) => !value)}
                          >
                            {isLiveViewActive ? "Turn off live view" : "Turn on live view"}
                          </Button>
                          <Button
                            variant="text"
                            onClick={() => {
                              void refreshSessionPreview();
                            }}
                            disabled={isRefreshingFrame}
                          >
                            {isRefreshingFrame ? "Refreshing..." : "Refresh snapshot"}
                          </Button>
                          <Button
                            variant="text"
                            onClick={() => {
                              setIsLiveViewActive(true);
                              setSessionViewerExpanded(true);
                            }}
                            disabled={!sessionFrame?.screenshot}
                          >
                            Expand
                          </Button>
                        </Stack>
                      </Stack>
                    </Box>
                  </Stack>
                </Box>

                {requestedRunId ? (
                  <Box
                    sx={{
                      px: 2,
                      py: 1.5,
                      borderRadius: "16px",
                      backgroundColor: "var(--surface-card)",
                      border: "1px solid var(--border-subtle)",
                    }}
                  >
                    <Typography variant="body2" fontWeight={700}>
                      Latest change in plan
                    </Typography>
                    {requestedRunState ? (
                      <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                        Run state: {requestedRunState.replace(/_/g, " ")}
                      </Typography>
                    ) : null}
                    <Typography variant="body2" color="text.secondary">
                      {latestReplanEvent?.payload
                        ? `After ${latestReplanEvent.payload.completed_command ?? "the last step"}, the agent replanned because ${describeReplanReasons(latestReplanEvent.payload.replan_reasons)}. Next command: ${latestReplanEvent.payload.next_command ?? "unknown"}.`
                        : `When this run replans from the current UI state, the reason will appear here for run ${requestedRunId}. Use this viewer to inspect the live page before resuming.`}
                    </Typography>
                  </Box>
                ) : null}

                {renderLiveFrame()}

                {hasControl ? (
                  <Box
                    sx={{
                      p: 2,
                      borderRadius: "20px",
                      border: "1px solid var(--border-subtle)",
                      backgroundColor: "var(--surface-card)",
                    }}
                  >
                    <Stack spacing={2}>
                      <Box>
                        <Typography variant="body1" fontWeight={700}>
                          Faster remote controls
                        </Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                          Open pages directly and send text or key presses without relying on the browser’s native address bar focus.
                        </Typography>
                      </Box>
                      <Stack direction={{ xs: "column", md: "row" }} spacing={1.25}>
                        <TextField
                          label="Open URL or search"
                          value={remoteUrlInput}
                          onChange={(event) => setRemoteUrlInput(event.target.value)}
                          placeholder="example.com or search query"
                          fullWidth
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void submitRemoteNavigation();
                            }
                          }}
                        />
                        <Button variant="contained" onClick={() => void submitRemoteNavigation()}>
                          Open
                        </Button>
                      </Stack>
                      <Stack direction={{ xs: "column", md: "row" }} spacing={1.25}>
                        <TextField
                          label={isTouchClient ? "Type into remote browser" : "Send text"}
                          value={remoteTextInput}
                          onChange={(event) => setRemoteTextInput(event.target.value)}
                          placeholder="Email, password, search text, or form input"
                          fullWidth
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                              event.preventDefault();
                              void submitRemoteText();
                            }
                          }}
                        />
                        <Button variant="contained" onClick={() => void submitRemoteText()} disabled={!remoteTextInput.trim()}>
                          Type
                        </Button>
                      </Stack>
                      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                        <Button variant="outlined" onClick={() => void sendRemoteKey("Enter")}>Enter</Button>
                        <Button variant="outlined" onClick={() => void sendRemoteKey("Backspace")}>Backspace</Button>
                        <Button variant="outlined" onClick={() => void sendRemoteKey("Tab")}>Tab</Button>
                        <Button variant="outlined" onClick={() => void sendRemoteKey("Escape")}>Esc</Button>
                      </Stack>
                    </Stack>
                  </Box>
                ) : null}

                <Box
                  sx={{
                    p: 2,
                    borderRadius: "20px",
                    border: "1px solid var(--border-subtle)",
                    backgroundColor: "var(--surface-card-muted)",
                  }}
                >
                  <Stack spacing={1}>
                    <Typography variant="body2">
                      <strong>Page:</strong> {sessionFrame?.page_title || activePage?.title || selectedSession.pages[0]?.title || "Unknown"}
                    </Typography>
                    <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
                      <strong>URL:</strong> {sessionFrame?.current_url || activePage?.url || selectedSession.pages[0]?.url || "Unknown"}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      Last preview: {pretty(sessionFrame?.timestamp)}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      Viewport: {sessionViewport ? `${sessionViewport.width} x ${sessionViewport.height} @ ${sessionViewport.dpr}x` : "Unknown"}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      Controller: {selectedSession.controller_lock?.actor_id || "Nobody"}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      Lock expires: {selectedSession.controller_lock ? `${Math.ceil(lockRemainingMs / 1000)}s` : "Not held"}
                    </Typography>
                  </Stack>
                </Box>

                <Box
                  sx={{
                    p: 2,
                    borderRadius: "20px",
                    border: "1px solid var(--border-subtle)",
                    backgroundColor: "var(--surface-card)",
                  }}
                >
                  {isWholeWindowSession ? (
                    <Stack spacing={1}>
                      <Typography variant="body1" fontWeight={700}>
                        Browser window
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        The stream includes Chrome’s real tab strip, navigation controls, and address bar. Users can create tabs, switch tabs, and sign in directly inside the window once they take control.
                      </Typography>
                    </Stack>
                  ) : (
                    <>
                      <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" alignItems={{ xs: "flex-start", md: "center" }} gap={2}>
                        <Box>
                          <Typography variant="body1" fontWeight={700}>
                            Tabs
                          </Typography>
                          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                            The live view now carries its own browser chrome, so you can switch tabs from the window itself and open a new tab when you take control.
                          </Typography>
                        </Box>
                        <Typography variant="body2" color="text.secondary" sx={{ minWidth: 120, textAlign: { xs: "left", md: "right" } }}>
                          {selectedSession.pages.length
                            ? `${Math.max(activePageIndex + 1, 1)} of ${selectedSession.pages.length}`
                            : "No tabs"}
                        </Typography>
                      </Stack>
                      <Typography variant="body2" sx={{ mt: 1.5 }}>
                        <strong>{isPreviewingDifferentPage ? "Selected tab:" : "Current tab:"}</strong> {activePage?.title || sessionFrame?.page_title || "Unknown"}
                      </Typography>
                      {isPreviewingDifferentPage ? (
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
                          {hasControl
                            ? "This tab is now active in the remote browser window."
                            : "The browser itself stays on the current tab until you take control."}
                        </Typography>
                      ) : null}
                    </>
                  )}
                </Box>

                <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
                  <Button
                    variant={hasControl ? "outlined" : "contained"}
                    onClick={() =>
                      acquireBrowserSessionControl(selectedSession.session_id, {
                        actor_id: controllerActorId,
                        actor_type: "web",
                        priority: 100,
                        ttl_seconds: 300,
                      })
                        .then(async () => {
                          setOptimisticControlSessionId(selectedSession.session_id);
                          setErrorMessage("");
                          await browserSessionsQuery.refetch();
                          await refreshRequestedRunState();
                      })
                        .catch((err) => setErrorMessage(toErrorMessage(err, "Failed to acquire control")))
                    }
                    disabled={hasControl}
                  >
                    {hasControl ? "You're in control" : "Take control"}
                  </Button>
                  <Button
                    variant="text"
                    onClick={() =>
                      releaseBrowserSessionControl(selectedSession.session_id, {
                        actor_id: controllerActorId,
                      })
                        .then(async () => {
                          setOptimisticControlSessionId("");
                          setErrorMessage("");
                          await browserSessionsQuery.refetch();
                          await refreshRequestedRunState();
                        })
                        .catch((err) => setErrorMessage(toErrorMessage(err, "Failed to release control")))
                    }
                    disabled={!hasControl}
                  >
                    Release control
                  </Button>
                </Stack>

              </>
            ) : null}
          </Stack>
        )}
      </SurfaceCard>

      {!isSessionWorkspace ? (
        <SurfaceCard
          eyebrow="Redeem"
          title="Manual pairing"
          subtitle="Use this when a device needs the pairing ID and code pasted directly."
        >
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" },
            gap: 2,
          }}
        >
          <TextField value={redeemPairingId} onChange={(event) => setRedeemPairingId(event.target.value)} label="Pairing ID" />
          <TextField value={redeemCode} onChange={(event) => setRedeemCode(event.target.value.toUpperCase())} label="Pairing code" />
          <TextField select value={redeemType} onChange={(event) => setRedeemType(event.target.value)} label="Device type">
            <MenuItem value="mobile">Mobile</MenuItem>
            <MenuItem value="desktop">Desktop</MenuItem>
            <MenuItem value="web">Web</MenuItem>
          </TextField>
          <TextField value={redeemName} onChange={(event) => setRedeemName(event.target.value)} label="Device name" />
          <TextField value={redeemDeviceId} onChange={(event) => setRedeemDeviceId(event.target.value)} label="Optional device ID" />
          <TextField value={redeemFcm} onChange={(event) => setRedeemFcm(event.target.value)} label="Optional FCM token" />
        </Box>

        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} mt={3}>
          <Button
            variant="contained"
            disabled={redeemMutation.isPending}
            onClick={() => {
              if (!redeemPairingId.trim() || !redeemCode.trim() || !redeemName.trim()) {
                setErrorMessage("Pairing ID, code, and device name are required.");
                return;
              }

              redeemMutation.mutate({
                pairing_id: redeemPairingId.trim(),
                code: redeemCode.trim(),
                device_type: redeemType,
                device_name: redeemName.trim(),
                device_id: redeemDeviceId.trim() || undefined,
                fcm_token: redeemFcm.trim() || undefined,
              });
            }}
          >
            {redeemMutation.isPending ? "Linking..." : "Redeem and link"}
          </Button>
        </Stack>
        </SurfaceCard>
      ) : null}

      {!isSessionWorkspace ? (
        <SurfaceCard
          eyebrow="Inventory"
          title="Registered devices"
          subtitle="All currently linked clients show here with their last-seen state."
          actions={
            <Button variant="text" onClick={() => devicesQuery.refetch()}>
              Refresh
            </Button>
          }
        >
        <Stack spacing={1.5}>
          {devicesQuery.isLoading ? (
            <Typography variant="body2" color="text.secondary">
              Loading devices...
            </Typography>
          ) : null}

          {!devicesQuery.isLoading && (devicesQuery.data ?? []).length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No devices linked yet.
            </Typography>
          ) : null}

          {(devicesQuery.data ?? []).map((device) => {
            const online = Boolean(device.connected ?? device.is_online);
            return (
              <Box
                key={device.device_id}
                sx={{
                  p: 2.5,
                  borderRadius: "18px",
                  border: "1px solid var(--border-subtle)",
                  backgroundColor: "var(--surface-card-muted)",
                }}
              >
                <Stack
                  direction={{ xs: "column", md: "row" }}
                  justifyContent="space-between"
                  alignItems={{ xs: "flex-start", md: "center" }}
                  gap={2}
                >
                  <Stack spacing={0.75}>
                    <Typography fontWeight={700}>{device.device_name}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {device.device_type} · {pretty(device.last_seen)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {device.device_id}
                    </Typography>
                  </Stack>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <StatusPill label={online ? "Online" : "Offline"} tone={online ? "success" : "neutral"} />
                    <Button
                      variant="outlined"
                      color="error"
                      disabled={deleteMutation.isPending}
                      onClick={() => {
                        if (!window.confirm(`Remove device "${device.device_name}"?`)) return;
                        deleteMutation.mutate(device.device_id);
                      }}
                    >
                      Remove
                    </Button>
                  </Stack>
                </Stack>
              </Box>
            );
          })}
        </Stack>
        </SurfaceCard>
      ) : null}

      <Dialog
        open={sessionViewerExpanded}
        onClose={() => setSessionViewerExpanded(false)}
        fullScreen
        maxWidth={false}
      >
        <DialogContent
          sx={{
            p: 2,
            background: "#05070b",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
            <Stack spacing={0.5}>
              <Typography variant="h6" color="#fff">
                Expanded session viewer
              </Typography>
              <Typography variant="body2" color="rgba(255,255,255,0.72)">
                {hasControl
                  ? "Interact here for better targeting: click, drag, right-click, and scroll stay on the remote frame."
                  : "Acquire control first, then use this larger surface for accurate input."}
              </Typography>
            </Stack>
            <Button variant="contained" onClick={() => setSessionViewerExpanded(false)}>
              Close
            </Button>
          </Stack>
          {renderLiveFrame({ expanded: true })}
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
