import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, Chip, IconButton, Paper, Stack, Typography } from "@mui/material";
import { MaterialSymbol } from "@oi/design-system-web";

type CameraPermissionState = "idle" | "requesting" | "granted" | "denied" | "unsupported";
type CameraPreviewState = "idle" | "loading" | "ready" | "error";
const CAPTURE_MAX_EDGE = 1280;
const STREAM_MAX_EDGE = 896;
const STREAM_BASE_DELAY_MS = 900;
const STREAM_MAX_DELAY_MS = 1800;
const CAMERA_REQUEST_TIMEOUT_MS = 8_000;
const PREVIEW_READY_TIMEOUT_MS = 4_000;

async function getCameraStreamWithTimeout(constraints: MediaStreamConstraints, timeoutMs = CAMERA_REQUEST_TIMEOUT_MS) {
  return await Promise.race([
    navigator.mediaDevices.getUserMedia(constraints),
    new Promise<MediaStream>((_, reject) => {
      window.setTimeout(() => {
        reject(new Error("Timed out waiting for camera access."));
      }, timeoutMs);
    }),
  ]);
}

async function waitForVideoReadiness(video: HTMLVideoElement, timeoutMs = PREVIEW_READY_TIMEOUT_MS) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("Camera preview did not become ready."));
    }, timeoutMs);
    const handleReady = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadedmetadata", handleReady);
      video.removeEventListener("canplay", handleReady);
    };
    video.addEventListener("loadedmetadata", handleReady, { once: true });
    video.addEventListener("canplay", handleReady, { once: true });
  });
}

async function openCameraStream() {
  const attempts: Array<{ constraints: MediaStreamConstraints; deniedMessage?: string }> = [
    { constraints: { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: true, noiseSuppression: true } } },
    { constraints: { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: true, noiseSuppression: true } } },
    { constraints: { video: true, audio: { echoCancellation: true, noiseSuppression: true } } },
  ];
  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      return await getCameraStreamWithTimeout(attempt.constraints);
    } catch (error) {
      lastError = error;
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Camera access failed.");
}

export function CameraCapturePanel({
  embedded = false,
  isDarkMode,
  open,
  onCapture,
  onClose,
  onStreamReady,
  onStreamFrame,
  onStartStream,
  onStopStream,
  isStreaming,
}: {
  embedded?: boolean;
  isDarkMode: boolean;
  open: boolean;
  onCapture: (payload: { dataUrl: string; label: string }) => void;
  onClose: () => void;
  onStreamReady?: (stream: MediaStream | null) => void;
  onStreamFrame: (payload: { dataUrl: string; mimeType: string }) => Promise<void>;
  onStartStream: () => void;
  onStopStream: () => void;
  isStreaming: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [permissionState, setPermissionState] = useState<CameraPermissionState>("idle");
  const [previewState, setPreviewState] = useState<CameraPreviewState>("idle");
  const [error, setError] = useState("");
  const frameTimerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamingInFlightRef = useRef(false);
  const onStreamReadyRef = useRef(onStreamReady);
  const onStopStreamRef = useRef(onStopStream);
  const onStartStreamRef = useRef(onStartStream);
  const onStreamFrameRef = useRef(onStreamFrame);
  const [retryNonce, setRetryNonce] = useState(0);

  const unsupported = useMemo(
    () => typeof navigator === "undefined" || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function",
    [],
  );

  useEffect(() => {
    onStreamReadyRef.current = onStreamReady;
  }, [onStreamReady]);

  useEffect(() => {
    onStopStreamRef.current = onStopStream;
  }, [onStopStream]);

  useEffect(() => {
    onStartStreamRef.current = onStartStream;
  }, [onStartStream]);

  useEffect(() => {
    onStreamFrameRef.current = onStreamFrame;
  }, [onStreamFrame]);

  useEffect(() => {
    if (!open) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      setPermissionState((current) => (current === "unsupported" ? current : "idle"));
      setPreviewState("idle");
      setError("");
      onStreamReadyRef.current?.(null);
      if (isStreaming) {
        onStopStreamRef.current();
      }
      return;
    }
    if (unsupported) {
      setPermissionState("unsupported");
      setError("Camera capture is not supported in this browser.");
      return;
    }

    let cancelled = false;
    setPermissionState("requesting");
    setPreviewState("loading");
    setError("");
    void openCameraStream()
      .then(async (stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        onStreamReadyRef.current?.(stream);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
          await waitForVideoReadiness(videoRef.current);
        }
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        setPermissionState("granted");
        setPreviewState("ready");
      })
      .catch((cameraError) => {
        const nextMessage = cameraError instanceof Error ? cameraError.message : "Camera access failed.";
        if (isStreaming) {
          onStopStreamRef.current();
        }
        onStreamReadyRef.current?.(null);
        setPermissionState(cameraError instanceof DOMException && cameraError.name === "NotAllowedError" ? "denied" : "idle");
        setPreviewState("error");
        setError(
          cameraError instanceof DOMException && cameraError.name === "NotAllowedError"
            ? "Camera access is blocked. Allow camera access in the browser and try again."
            : nextMessage,
        );
      });

    return () => {
      if (frameTimerRef.current) {
        window.clearTimeout(frameTimerRef.current);
        frameTimerRef.current = null;
      }
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [isStreaming, open, retryNonce, unsupported]);

  const frameToDataUrl = async (maxEdge: number, quality: number) => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const sourceWidth = video.videoWidth || 1280;
    const sourceHeight = video.videoHeight || 720;
    const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = canvasRef.current || document.createElement("canvas");
    canvasRef.current = canvas;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      setError("Could not access the camera frame buffer.");
      return;
    }
    context.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/jpeg", quality);
    });
    if (!blob) {
      setError("Could not encode the current camera frame.");
      return;
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => reject(new Error("Could not read the camera frame."));
      reader.readAsDataURL(blob);
    });
    return {
      dataUrl,
      label: `Camera capture ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    };
  };

  const captureFrame = async () => {
    const frame = await frameToDataUrl(CAPTURE_MAX_EDGE, 0.82);
    if (!frame) return;
    onCapture(frame);
    onClose();
  };

  useEffect(() => {
    if (!open || !isStreaming || permissionState !== "granted" || previewState !== "ready") return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled || streamingInFlightRef.current) return;
      streamingInFlightRef.current = true;
      const startedAt = window.performance.now();
      try {
        const frame = await frameToDataUrl(STREAM_MAX_EDGE, 0.62);
        if (frame && !cancelled) {
          await onStreamFrameRef.current({ dataUrl: frame.dataUrl, mimeType: "image/jpeg" });
        }
      } catch (streamError) {
        onStopStreamRef.current();
        setError(streamError instanceof Error ? streamError.message : "Live camera streaming failed.");
      } finally {
        streamingInFlightRef.current = false;
        if (!cancelled) {
          const elapsed = window.performance.now() - startedAt;
          const nextDelay = Math.min(STREAM_MAX_DELAY_MS, Math.max(STREAM_BASE_DELAY_MS, STREAM_BASE_DELAY_MS + Math.max(0, elapsed - 250)));
          frameTimerRef.current = window.setTimeout(() => {
            void tick();
          }, nextDelay);
        }
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (frameTimerRef.current) {
        window.clearTimeout(frameTimerRef.current);
        frameTimerRef.current = null;
      }
    };
  }, [isStreaming, open, permissionState, previewState]);

  if (!open) return null;
  const preview = (
    <Box
      sx={{
        position: "relative",
        overflow: "hidden",
        borderRadius: embedded ? "30px" : "22px",
        border: embedded ? "none" : "1px solid var(--border-default)",
        minHeight: embedded ? "100%" : 260,
        height: embedded ? "100%" : "auto",
        background: isDarkMode ? "rgba(8,10,14,0.92)" : "rgba(245, 240, 230, 0.9)",
      }}
    >
      <Box
        component="video"
        ref={videoRef}
        muted
        playsInline
        autoPlay
        sx={{
          width: "100%",
          height: "100%",
          minHeight: embedded ? "100%" : 260,
          objectFit: "cover",
          display: "block",
          opacity: permissionState === "granted" && previewState === "ready" ? 1 : 0,
          transition: "opacity 320ms cubic-bezier(0.22, 1, 0.36, 1)",
          willChange: "opacity",
        }}
      />
      {permissionState !== "granted" || previewState !== "ready" ? (
        <Stack
          spacing={1}
          alignItems="center"
          justifyContent="center"
          sx={{ minHeight: embedded ? "100%" : 260, px: 3, textAlign: "center" }}
        >
          <Typography variant="body1" sx={{ fontWeight: 700 }}>
            {permissionState === "requesting" || previewState === "loading"
              ? "Opening camera preview."
              : "Camera preview will appear here."}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {error
              ? "Retry the camera or attach an image while camera access is unavailable."
              : "Capture a live frame and send it into the conversation without leaving the thread."}
          </Typography>
        </Stack>
      ) : null}
      {embedded ? (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            background: "linear-gradient(180deg, rgba(8,12,18,0.06), rgba(8,12,18,0.18))",
            pointerEvents: "none",
          }}
        />
      ) : null}
      {embedded ? (
        <Stack
          direction="row"
          spacing={1}
          sx={{
            position: "absolute",
            right: 16,
            bottom: 16,
            zIndex: 2,
          }}
        >
          <IconButton
            sx={{
              border: "1px solid rgba(255,255,255,0.18)",
              backgroundColor: "rgba(12,16,24,0.34)",
              backdropFilter: "blur(14px)",
              color: "#fff",
            }}
            disabled={permissionState !== "granted" || previewState !== "ready"}
            onClick={() => void captureFrame()}
          >
            <MaterialSymbol name="stop" sx={{ fontSize: 20 }} />
          </IconButton>
          <IconButton
            sx={{
              border: "1px solid rgba(255,255,255,0.18)",
              backgroundColor: "rgba(12,16,24,0.34)",
              backdropFilter: "blur(14px)",
              color: "#fff",
            }}
            disabled={permissionState === "requesting" || previewState === "loading"}
            onClick={() => setRetryNonce((value) => value + 1)}
          >
            <MaterialSymbol name="refresh" sx={{ fontSize: 20 }} />
          </IconButton>
        </Stack>
      ) : null}
    </Box>
  );

  if (embedded) {
    return (
      <Box sx={{ position: "relative", width: "100%", height: "100%" }}>
        {error ? (
          <Alert severity="warning" sx={{ position: "absolute", top: 16, left: 16, right: 16, zIndex: 2 }}>
            {error}
          </Alert>
        ) : null}
        {preview}
      </Box>
    );
  }

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.5,
        borderRadius: "24px",
        borderColor: "var(--border-default)",
        background: isDarkMode
          ? "linear-gradient(180deg, rgba(10,14,20,0.94), rgba(18,22,28,0.9))"
          : "linear-gradient(180deg, rgba(255,255,255,0.96), rgba(243,236,224,0.9))",
      }}
    >
      <Stack spacing={1.25}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography variant="overline" sx={{ color: "text.secondary", fontWeight: 800, letterSpacing: 1.1 }}>
              Camera
            </Typography>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              Show the agent what you see
            </Typography>
          </Box>
          <Chip
            label={
              permissionState === "granted"
                ? previewState === "loading"
                  ? "Opening camera"
                  : isStreaming
                    ? "Camera live"
                    : "Camera ready"
                : permissionState === "requesting"
                  ? "Opening camera"
                  : permissionState === "denied"
                    ? "Camera blocked"
                    : permissionState === "unsupported"
                      ? "Unsupported"
                      : "Standby"
            }
            color={permissionState === "granted" ? "success" : permissionState === "denied" ? "warning" : "default"}
            variant="outlined"
          />
        </Stack>

        {error ? <Alert severity="warning">{error}</Alert> : null}

        {preview}

        <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
          <Button
            variant="contained"
            sx={{ borderRadius: "999px", px: 2.5 }}
            disabled={permissionState !== "granted" || previewState !== "ready"}
            onClick={() => void captureFrame()}
          >
            Capture frame
          </Button>
          <Button
            variant={isStreaming ? "contained" : "outlined"}
            color={isStreaming ? "success" : "inherit"}
            sx={{ borderRadius: "999px", px: 2.5 }}
            disabled={permissionState !== "granted" || previewState !== "ready"}
            onClick={() => (isStreaming ? onStopStreamRef.current() : onStartStreamRef.current())}
          >
            {isStreaming ? "Stop live camera" : "Start live camera"}
          </Button>
          <Button
            variant="outlined"
            sx={{ borderRadius: "999px", px: 2.5 }}
            disabled={permissionState === "requesting" || previewState === "loading"}
            onClick={() => setRetryNonce((value) => value + 1)}
          >
            Retry camera
          </Button>
          <Button variant="outlined" sx={{ borderRadius: "999px", px: 2.5 }} onClick={onClose}>
            Close camera
          </Button>
        </Stack>
      </Stack>
    </Paper>
  );
}
