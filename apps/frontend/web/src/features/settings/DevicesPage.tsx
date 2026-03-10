import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type WheelEvent } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogContent,
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
  connectBrowserSessionStream,
  listBrowserSessions,
  releaseBrowserSessionControl,
  sendBrowserSessionInput,
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
  const res = await authFetch("/api/devices");
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to fetch devices"));
  const data = (await res.json()) as RegisteredDevice[];
  return Array.isArray(data) ? data : [];
}

async function createPairingSession(expiresInSeconds = 300) {
  const res = await authFetch("/api/devices/pairing/session", {
    method: "POST",
    body: JSON.stringify({ expires_in_seconds: expiresInSeconds }),
  });
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to create pairing session"));
  return (await res.json()) as PairingSession;
}

async function fetchPairingStatus(pairingId: string) {
  const res = await authFetch(`/api/devices/pairing/session/${encodeURIComponent(pairingId)}`);
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
  const res = await authFetch("/api/devices/pairing/redeem", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to redeem pairing code"));
}

async function deleteDevice(deviceId: string) {
  const res = await authFetch(`/api/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to remove device"));
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

export function DevicesPage() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
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
  const [sessionViewerExpanded, setSessionViewerExpanded] = useState(false);
  const [latestReplanEvent, setLatestReplanEvent] = useState<RunEventRecord | null>(null);
  const [isRequestedRunActive, setIsRequestedRunActive] = useState(false);
  const [requestedRunState, setRequestedRunState] = useState("");
  const [optimisticControlSessionId, setOptimisticControlSessionId] = useState("");
  const frameDragRef = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
  const frameSurfaceRef = useRef<HTMLDivElement | null>(null);
  const pendingMoveRef = useRef<Parameters<typeof sendBrowserSessionInput>[1] | null>(null);
  const moveFlushInFlightRef = useRef(false);
  const pendingWheelRef = useRef<Parameters<typeof sendBrowserSessionInput>[1] | null>(null);
  const wheelFlushInFlightRef = useRef(false);
  const controllerActorId = useMemo(() => {
    if (typeof window === "undefined") return "web-controller";
    return `web-${window.location.hostname || "client"}`;
  }, []);

  const devicesQuery = useQuery({
    queryKey: ["settings-devices"],
    queryFn: fetchDevices,
  });

  const browserSessionsQuery = useQuery({
    queryKey: ["browser-sessions"],
    queryFn: listBrowserSessions,
    refetchOnWindowFocus: false,
  });

  const pairingStatusQuery = useQuery({
    queryKey: ["pairing-status", activeSession?.pairing_id],
    queryFn: () => fetchPairingStatus(activeSession!.pairing_id),
    enabled: Boolean(activeSession?.pairing_id),
    refetchInterval: 8_000,
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

  const pairingStatus = pairingStatusQuery.data ?? null;
  const browserSessions = browserSessionsQuery.data ?? [];
  const selectedSession = useMemo(
    () => browserSessions.find((session) => session.session_id === selectedSessionId) ?? browserSessions[0] ?? null,
    [browserSessions, selectedSessionId],
  );
  const isLinked = pairingStatus?.status?.toLowerCase() === "linked";
  const expiresText = useMemo(
    () => pretty(activeSession?.expires_at || pairingStatus?.expires_at),
    [activeSession?.expires_at, pairingStatus?.expires_at],
  );
  const requestedSessionId = searchParams.get("session_id") || "";
  const requestedRunId = searchParams.get("run_id") || "";
  const isSessionWorkspace = location.pathname === "/sessions";

  useEffect(() => {
    if (!isLinked) return;
    void queryClient.invalidateQueries({ queryKey: ["settings-devices"] });
  }, [isLinked, queryClient]);

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
      return;
    }
    const disconnect = connectBrowserSessionStream(selectedSession.session_id, (event) => {
      const payload = event.payload;
      if (!payload) return;
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
    });
    return disconnect;
  }, [requestedRunId, selectedSession]);

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
    if (!requestedRunId || !isRequestedRunActive) return;
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
    }, 4000);
    return () => window.clearInterval(timer);
  }, [requestedRunId, isRequestedRunActive]);

  const sessionViewport = sessionFrame?.viewport ?? selectedSession?.viewport;
  const hasControl =
    (selectedSession?.session_id && optimisticControlSessionId === selectedSession.session_id) ||
    selectedSession?.controller_lock?.actor_id === controllerActorId;
  const lockRemainingMs = selectedSession?.controller_lock
    ? Math.max(0, Date.parse(selectedSession.controller_lock.expires_at) - Date.now())
    : 0;

  const sendFrameInput = useCallback(
    async (
      payload: Parameters<typeof sendBrowserSessionInput>[1],
      fallback: string,
    ) => {
      if (!selectedSession || !hasControl) return;
      try {
        await sendBrowserSessionInput(selectedSession.session_id, payload);
      } catch (err) {
        const message = toErrorMessage(err, fallback);
        if (message.includes("Acquire controller lock")) {
          setOptimisticControlSessionId("");
          void browserSessionsQuery.refetch();
        }
        setErrorMessage(message);
      }
    },
    [browserSessionsQuery, hasControl, selectedSession],
  );

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
        {sessionFrame?.screenshot ? (
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
        ) : (
          <Box sx={{ p: 4 }}>
            <Typography variant="body2" color="text.secondary">
              Waiting for session frames.
            </Typography>
          </Box>
        )}
      </Box>
    ),
    [finishFramePointer, handleFramePointerDown, handleFramePointerMove, handleFrameWheel, hasControl, sessionFrame?.screenshot],
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
            This page opened from an automation incident and will focus the matching browser session when it is available.
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
        title="Live local or server browser sessions"
        subtitle="View the latest browser frame from registered runners and send basic control actions."
        actions={
          <Tooltip title="Refresh sessions">
            <Button variant="text" onClick={() => browserSessionsQuery.refetch()}>
              <MaterialSymbol name="refresh" sx={{ fontSize: 20 }} />
            </Button>
          </Tooltip>
        }
      >
        {browserSessions.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No browser sessions are registered yet. Start a local runner to publish one.
          </Typography>
        ) : (
          <Stack spacing={2}>
            <TextField
              select
              label="Active session"
              value={selectedSession?.session_id ?? ""}
              onChange={(event) => setSelectedSessionId(event.target.value)}
            >
              {browserSessions.map((session) => (
                <MenuItem key={session.session_id} value={session.session_id}>
                  {(session.runner_label || session.runner_id || session.session_id).toString()} · {session.status}
                </MenuItem>
              ))}
            </TextField>

            {selectedSession ? (
              <>
                <div style={{ display: "flex", flexDirection: "row", gap: "1.5rem" }}>
                  <StatusPill label={selectedSession.origin.replace("_", " ")} tone="brand" />
                  <StatusPill label={selectedSession.status} tone={selectedSession.status === "ready" ? "success" : "warning"} />
                  {selectedSession.runner_label ? <StatusPill label={selectedSession.runner_label} tone="neutral" /> : null}
                </div>

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
                      Latest adaptation
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

                <Stack spacing={0.75}>
                  <Typography variant="body2">
                    <strong>Title:</strong> {sessionFrame?.page_title || selectedSession.pages[0]?.title || "Unknown"}
                  </Typography>
                  <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
                    <strong>URL:</strong> {sessionFrame?.current_url || selectedSession.pages[0]?.url || "Unknown"}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Last frame: {pretty(sessionFrame?.timestamp)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Viewport: {sessionViewport ? `${sessionViewport.width} x ${sessionViewport.height} @ ${sessionViewport.dpr}x` : "Unknown"}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Controller: {selectedSession.controller_lock?.actor_id || "None"}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Lock expires: {selectedSession.controller_lock ? `${Math.ceil(lockRemainingMs / 1000)}s` : "No lock"}
                  </Typography>
                </Stack>

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
                    {hasControl ? "In control" : "Take control"}
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
