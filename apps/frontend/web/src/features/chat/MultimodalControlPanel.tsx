import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, IconButton, Paper, Stack, Typography } from "@mui/material";
import { MaterialSymbol } from "@oi/design-system-web";
import { bootstrapServerBrowserSession, listBrowserSessions } from "@/api/browserSessions";
import type { BrowserSessionRecord } from "@/domain/automation";
import type { SessionReadinessSummary } from "@/domain/automation";
import type { LiveMultimodalState } from "@/features/chat/useLiveMultimodal";
import { CameraCapturePanel } from "@/features/chat/CameraCapturePanel";

interface DesktopRunnerStatus {
  enabled: boolean;
  sessionId: string | null;
  cdpUrl: string | null;
  origin: "local_runner" | "server_runner";
  state: "idle" | "registering" | "ready" | "error";
  error?: string;
}

function orbCaption(live: LiveMultimodalState) {
  if (live.connectionState === "connecting") return "Opening live mode.";
  if (live.isAssistantResponding) return "Replying.";
  if (live.isSessionActive) return "Listening.";
  return "Ready when you are.";
}

function haloTone(live: LiveMultimodalState) {
  const intensity = live.isRecording ? 1 : live.isAssistantResponding ? 0.84 : live.isSessionActive ? 0.68 : 0.42;
  return {
    ring: `rgba(96, 165, 250, ${0.14 + intensity * 0.16})`,
    ringSoft: `rgba(191, 219, 254, ${0.10 + intensity * 0.1})`,
    glow: `rgba(96, 165, 250, ${0.14 + intensity * 0.2})`,
    core: `radial-gradient(circle, rgba(245,249,255,0.98) 0%, rgba(191,219,254,${0.48 + intensity * 0.18}) 44%, rgba(96,165,250,${0.18 + intensity * 0.1}) 100%)`,
    pulseScale: live.isRecording ? 1.08 : live.isAssistantResponding ? 1.05 : live.isSessionActive ? 1.02 : 1,
    orbitDuration: live.isRecording ? "10s" : live.isAssistantResponding ? "14s" : "18s",
  };
}

function stageAccent(isDarkMode: boolean, cameraOpen: boolean) {
  if (isDarkMode) {
    return cameraOpen
      ? "linear-gradient(180deg, rgba(8,12,18,0.04), rgba(8,12,18,0.24))"
      : "linear-gradient(180deg, rgba(8,12,18,0.08), rgba(8,12,18,0.14))";
  }
  return cameraOpen
    ? "linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,248,240,0.22))"
    : "linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,248,240,0.12))";
}

function hasRunnableBrowserSession(sessions: BrowserSessionRecord[]) {
  return sessions.some((session) => {
    const cdpUrl = String(session.metadata?.cdp_url || "").trim();
    return Boolean(cdpUrl) && (session.status === "ready" || session.status === "busy");
  });
}

export function MultimodalControlPanel({
  isDarkMode,
  live,
  sessionReadiness,
  onAddImage,
  onCapture,
}: {
  isDarkMode: boolean;
  live: LiveMultimodalState;
  sessionReadiness: SessionReadinessSummary | null;
  onAddImage: () => void;
  onCapture: (payload: { dataUrl: string; label: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [browserSessions, setBrowserSessions] = useState<BrowserSessionRecord[]>([]);
  const [desktopRunner, setDesktopRunner] = useState<DesktopRunnerStatus | null>(null);
  const [navigatorError, setNavigatorError] = useState("");
  const [bootstrappingNavigator, setBootstrappingNavigator] = useState(false);
  const autoStartedRef = useRef(false);
  const autoResumeRef = useRef(false);
  const halo = useMemo(() => haloTone(live), [live]);
  const stageBackground = useMemo(() => stageAccent(isDarkMode, cameraOpen), [cameraOpen, isDarkMode]);
  const runnableBrowserSession = useMemo(() => hasRunnableBrowserSession(browserSessions), [browserSessions]);
  const navigatorReady = sessionReadiness?.browser_attached || runnableBrowserSession;
  const navigatorLabel = navigatorReady
    ? "Navigator ready"
    : desktopRunner?.state === "registering"
      ? "Connecting navigator"
      : "Navigator required";
  const navigatorDetail = navigatorReady
    ? "Browser control is attached, so live commands can act in the UI."
    : desktopRunner?.enabled
      ? desktopRunner?.state === "error"
        ? desktopRunner.error || "The local navigator runner is installed but not ready yet."
        : "The desktop runner is available. Open the navigator session to attach a browser."
      : "Voice and camera work now, but browser actions still need a connected navigator runner.";

  useEffect(() => {
    let cancelled = false;
    const refreshBrowserSupport = async () => {
      try {
        const [sessions, runner] = await Promise.all([
          listBrowserSessions().catch(() => []),
          window.electronAPI?.getRunnerStatus?.().catch(() => null) ?? Promise.resolve(null),
        ]);
        if (cancelled) return;
        setBrowserSessions(Array.isArray(sessions) ? sessions : []);
        setDesktopRunner((runner && typeof runner === "object" ? runner : null) as DesktopRunnerStatus | null);
        setNavigatorError("");
      } catch (error) {
        if (cancelled) return;
        setNavigatorError(error instanceof Error ? error.message : "Failed to inspect navigator readiness.");
      }
    };
    void refreshBrowserSupport();
    const interval = window.setInterval(() => {
      void refreshBrowserSupport();
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const refreshBrowserSupport = async () => {
    const [sessions, runner] = await Promise.all([
      listBrowserSessions().catch(() => []),
      window.electronAPI?.getRunnerStatus?.().catch(() => null) ?? Promise.resolve(null),
    ]);
    setBrowserSessions(Array.isArray(sessions) ? sessions : []);
    setDesktopRunner((runner && typeof runner === "object" ? runner : null) as DesktopRunnerStatus | null);
    return Array.isArray(sessions) ? sessions : [];
  };

  const handleOpenLive = async () => {
    setNavigatorError("");
    if (!navigatorReady && !desktopRunner?.enabled) {
      setBootstrappingNavigator(true);
      try {
        await bootstrapServerBrowserSession();
        await refreshBrowserSupport();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to start the server browser session.";
        setNavigatorError(message);
      } finally {
        setBootstrappingNavigator(false);
      }
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) {
      autoStartedRef.current = false;
      autoResumeRef.current = false;
      return;
    }
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    autoResumeRef.current = true;
    void live.startSession().then(() => live.startRecording({ mediaStream: cameraStream }));
  }, [cameraStream, live, open]);

  useEffect(() => {
    if (!open || !autoResumeRef.current) return;
    if (!live.isSessionActive || live.connectionState !== "ready") return;
    if (live.isRecording || live.isAssistantResponding) return;
    const timer = window.setTimeout(() => {
      void live.startRecording({ mediaStream: cameraStream });
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [
    cameraStream,
    live.connectionState,
    live.isAssistantResponding,
    live.isRecording,
    live.isSessionActive,
    open,
  ]);

  const handleModalClose = () => {
    setOpen(false);
    autoResumeRef.current = false;
    live.stopVisionStream();
    void live.stopSession();
    setCameraOpen(false);
    setCameraStream(null);
  };

  const handleLiveToggle = () => {
    if (cameraOpen) {
      live.stopVisionStream();
      setCameraOpen(false);
      return;
    }
    setCameraOpen(true);
    if (!live.isVisionStreaming) {
      live.startVisionStream();
    }
  };

  const handleOrbToggle = () => {
    if (open) {
      handleModalClose();
      return;
    }
    void handleOpenLive();
  };

  return (
    <>
      <Box
        sx={{
          position: "fixed",
          right: { xs: 20, md: 28 },
          bottom: { xs: 20, md: 28 },
          zIndex: 1400,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 1.25,
          pointerEvents: "none",
        }}
      >
        {open ? (
          <Paper
            sx={{
              position: "relative",
              overflow: "hidden",
              borderRadius: "28px",
              border: "1px solid rgba(255,255,255,0.14)",
              boxShadow: isDarkMode
                ? "0 28px 80px rgba(0,0,0,0.34)"
                : "0 28px 80px rgba(30,41,59,0.16)",
              width: cameraOpen ? { xs: "min(92vw, 420px)", md: 460 } : { xs: 280, md: 320 },
              height: cameraOpen ? { xs: 420, md: 500 } : { xs: 280, md: 320 },
              px: { xs: 1.5, md: 2 },
              py: { xs: 1.5, md: 1.75 },
              pointerEvents: "auto",
              transition: "width 360ms cubic-bezier(0.22, 1, 0.36, 1), height 360ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 240ms ease",
              background: isDarkMode
                ? "linear-gradient(180deg, rgba(9,12,19,0.98) 0%, rgba(13,16,24,0.98) 100%)"
                : "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,243,235,0.98) 100%)",
            }}
          >
            <Stack spacing={1.25} sx={{ height: "100%" }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 0.5 }}>
                <Typography variant="overline" sx={{ color: "text.secondary", fontWeight: 800, letterSpacing: 1.2, opacity: 0.72 }}>
                  Live
                </Typography>
                <IconButton onClick={handleModalClose} size="small">
                  <Typography component="span" sx={{ fontSize: 24, lineHeight: 1, fontWeight: 300 }}>
                    ×
                  </Typography>
                </IconButton>
              </Stack>

              <Box
                sx={{
                  position: "relative",
                  flex: 1,
                  minHeight: 0,
                  borderRadius: "24px",
                  overflow: "hidden",
                  background: stageBackground,
                  border: isDarkMode ? "1px solid rgba(255,255,255,0.05)" : "1px solid rgba(148,163,184,0.10)",
                }}
              >
                <Box
                  sx={{
                    position: "absolute",
                    inset: 0,
                    background: cameraOpen
                      ? "radial-gradient(circle at 18% 82%, rgba(96,165,250,0.12), transparent 24%)"
                      : "radial-gradient(circle at 50% 50%, rgba(96,165,250,0.07), transparent 36%)",
                    opacity: cameraOpen ? 0.9 : 1,
                    transition: "opacity 360ms cubic-bezier(0.22, 1, 0.36, 1), background 420ms cubic-bezier(0.22, 1, 0.36, 1)",
                    pointerEvents: "none",
                  }}
                />
                <Box
                  sx={{
                    position: "absolute",
                    inset: 0,
                    opacity: cameraOpen ? 1 : 0,
                    transform: cameraOpen ? "scale(1)" : "scale(0.975)",
                    transition: "opacity 380ms cubic-bezier(0.22, 1, 0.36, 1), transform 420ms cubic-bezier(0.22, 1, 0.36, 1)",
                    pointerEvents: cameraOpen ? "auto" : "none",
                    willChange: "opacity, transform",
                  }}
                >
                  <CameraCapturePanel
                    embedded
                    isDarkMode={isDarkMode}
                    open={cameraOpen}
                    onCapture={onCapture}
                    onStreamReady={setCameraStream}
                    onStreamFrame={live.sendLiveImage}
                    onStartStream={live.startVisionStream}
                    onStopStream={live.stopVisionStream}
                    isStreaming={live.isVisionStreaming}
                    onClose={() => {
                      live.stopVisionStream();
                      setCameraStream(null);
                      setCameraOpen(false);
                    }}
                  />
                </Box>

                <Box
                  onClick={handleOrbToggle}
                  sx={{
                    position: "absolute",
                    left: cameraOpen ? { xs: 14, md: 18 } : "50%",
                    bottom: cameraOpen ? { xs: 14, md: 18 } : "50%",
                    top: cameraOpen ? "auto" : "50%",
                    transform: cameraOpen
                      ? "translate(0, 0)"
                      : "translate(-50%, -50%)",
                    width: cameraOpen ? { xs: 92, md: 108 } : { xs: 188, md: 210 },
                    height: cameraOpen ? { xs: 92, md: 108 } : { xs: 188, md: 210 },
                    borderRadius: "999px",
                    display: "grid",
                    placeItems: "center",
                    cursor: "pointer",
                    transition: "left 420ms cubic-bezier(0.22, 1, 0.36, 1), bottom 420ms cubic-bezier(0.22, 1, 0.36, 1), top 420ms cubic-bezier(0.22, 1, 0.36, 1), width 420ms cubic-bezier(0.22, 1, 0.36, 1), height 420ms cubic-bezier(0.22, 1, 0.36, 1), transform 420ms cubic-bezier(0.22, 1, 0.36, 1)",
                    willChange: "left, bottom, width, height, transform",
                    "@keyframes haloPulse": {
                      "0%": { transform: "scale(0.985)", opacity: 0.72 },
                      "50%": { transform: `scale(${halo.pulseScale})`, opacity: 0.92 },
                      "100%": { transform: "scale(0.985)", opacity: 0.72 },
                    },
                    "@keyframes haloOrbit": {
                      "0%": { transform: "rotate(0deg)" },
                      "100%": { transform: "rotate(360deg)" },
                    },
                  }}
                >
                  <Box
                    sx={{
                      position: "absolute",
                      inset: cameraOpen ? 6 : 10,
                      borderRadius: "999px",
                      border: `1px solid ${halo.ringSoft}`,
                      animation: `haloOrbit ${halo.orbitDuration} linear infinite`,
                      opacity: 0.54,
                    }}
                  />
                  <Box
                    sx={{
                      position: "absolute",
                      inset: cameraOpen ? 16 : 28,
                      borderRadius: "999px",
                      border: `1px solid ${halo.ring}`,
                      animation: live.isSessionActive ? "haloPulse 2.4s ease-in-out infinite" : "none",
                      opacity: live.isSessionActive ? 0.58 : 0.38,
                    }}
                  />
                  <Box
                    sx={{
                      position: "absolute",
                      inset: cameraOpen ? 20 : 34,
                      borderRadius: "999px",
                      background: halo.core,
                      boxShadow: `0 0 ${cameraOpen ? 20 : 40}px ${halo.glow}`,
                      transition: "box-shadow 280ms ease, background 280ms ease",
                    }}
                  />
                  <Stack spacing={0.45} alignItems="center" sx={{ position: "relative", zIndex: 1, px: 2 }}>
                    <Typography
                      variant={cameraOpen ? "subtitle2" : "h6"}
                      sx={{ fontWeight: 800, letterSpacing: cameraOpen ? 0.2 : 0.4 }}
                    >
                      Live
                    </Typography>
                    {!cameraOpen ? (
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ maxWidth: 170, textAlign: "center", minHeight: 20, fontSize: 13 }}
                      >
                        {orbCaption(live)}
                      </Typography>
                    ) : null}
                  </Stack>
                </Box>
              </Box>

              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Stack spacing={0.5} direction="row" alignItems="center">
                  <IconButton
                    onClick={onAddImage}
                    sx={{
                      border: "1px solid rgba(255,255,255,0.12)",
                      backgroundColor: "rgba(255,255,255,0.05)",
                      backdropFilter: "blur(14px)",
                      transition: "background-color 220ms ease, border-color 220ms ease, transform 220ms ease",
                      "&:hover": {
                        transform: "translateY(-1px)",
                      },
                    }}
                  >
                    <MaterialSymbol name="add" sx={{ fontSize: 20 }} />
                  </IconButton>
                </Stack>
                <Stack direction="row" spacing={1}>
                  <IconButton
                    onClick={handleLiveToggle}
                    sx={{
                      border: "1px solid rgba(255,255,255,0.14)",
                      backgroundColor: cameraOpen ? "rgba(96,165,250,0.12)" : "rgba(255,255,255,0.05)",
                      backdropFilter: "blur(14px)",
                      transition: "background-color 220ms ease, border-color 220ms ease, transform 220ms ease",
                      "&:hover": {
                        transform: "translateY(-1px)",
                      },
                    }}
                  >
                    <MaterialSymbol name="devices" sx={{ fontSize: 22 }} />
                  </IconButton>
                </Stack>
              </Stack>
            </Stack>
          </Paper>
        ) : null}

        <IconButton
          onClick={handleOrbToggle}
          disabled={bootstrappingNavigator}
          aria-label={bootstrappingNavigator ? "Starting live" : "Open live"}
          sx={{
            width: 64,
            height: 64,
            border: "1px solid rgba(255,255,255,0.14)",
            background: isDarkMode
              ? "linear-gradient(180deg, rgba(13,16,24,0.94), rgba(9,12,18,0.98))"
              : "linear-gradient(180deg, rgba(255,255,255,0.96), rgba(244,238,227,0.96))",
            boxShadow: isDarkMode
              ? "0 16px 40px rgba(0,0,0,0.32)"
              : "0 16px 40px rgba(30,41,59,0.16)",
            backdropFilter: "blur(16px)",
            pointerEvents: "auto",
            transition: "transform 220ms ease, box-shadow 220ms ease, background-color 220ms ease",
            "&:hover": {
              transform: "translateY(-2px) scale(1.02)",
            },
          }}
        >
          <Box
            sx={{
              position: "relative",
              width: 34,
              height: 34,
              borderRadius: "999px",
              background: halo.core,
              boxShadow: `0 0 18px ${halo.glow}`,
              "&::before": {
                content: '""',
                position: "absolute",
                inset: -6,
                borderRadius: "999px",
                border: `1px solid ${halo.ringSoft}`,
                opacity: 0.64,
              },
            }}
          />
        </IconButton>
      </Box>

    </>
  );
}
