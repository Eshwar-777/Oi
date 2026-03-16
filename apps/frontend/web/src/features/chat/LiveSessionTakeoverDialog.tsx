import { useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Link,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { StatusPill } from "@oi/design-system-web";
import {
  acquireBrowserSessionControl,
  connectBrowserSessionStream,
  controlBrowserSession,
  releaseBrowserSessionControl,
  sendBrowserSessionInput,
} from "@/api/browserSessions";
import type { BrowserSessionRecord } from "@/domain/automation";

interface SessionFrameState {
  screenshot?: string;
  current_url?: string;
  page_title?: string;
  timestamp?: string;
}

function toErrorMessage(value: unknown, fallback: string) {
  if (value instanceof Error && value.message) return value.message;
  return fallback;
}

function pretty(value?: string) {
  if (!value) return "Never";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
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

export function LiveSessionTakeoverDialog({
  open,
  session,
  runState,
  runId,
  onClose,
  onResume,
}: {
  open: boolean;
  session: BrowserSessionRecord | null;
  runState?: string | null;
  runId?: string | null;
  onClose: () => void;
  onResume: () => Promise<void> | void;
}) {
  const [frame, setFrame] = useState<SessionFrameState | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [navigateUrl, setNavigateUrl] = useState("");
  const [typeText, setTypeText] = useState("");
  const [pendingAction, setPendingAction] = useState<"" | "acquire" | "release" | "resume" | "navigate" | "type" | "keypress">("");
  const controllerActorId = useMemo(() => {
    if (typeof window === "undefined") return "web-controller";
    return `chat-web-${window.location.hostname || "client"}`;
  }, []);

  useEffect(() => {
    if (!open || !session) {
      setFrame(null);
      setNavigateUrl("");
      setTypeText("");
      setErrorMessage("");
      return;
    }
    const disconnect = connectBrowserSessionStream(session.session_id, (event) => {
      const payload = event.payload;
      if (!payload) return;
      setFrame({
        screenshot: payload.screenshot,
        current_url: payload.current_url,
        page_title: payload.page_title,
        timestamp: payload.timestamp,
      });
    });
    return disconnect;
  }, [open, session]);

  useEffect(() => {
    if (!open) return;
    setNavigateUrl(frame?.current_url || session?.pages[0]?.url || "");
  }, [frame?.current_url, open, session?.pages]);

  const hasControl = session?.controller_lock?.actor_id === controllerActorId;
  const lockRemainingMs = session?.controller_lock
    ? Math.max(0, Date.parse(session.controller_lock.expires_at) - Date.now())
    : 0;
  const currentUrl = frame?.current_url || session?.pages[0]?.url || "";
  const currentTitle = frame?.page_title || session?.pages[0]?.title || "Current page";
  const clickX = session?.viewport ? Math.round(session.viewport.width / 2) : 640;
  const clickY = session?.viewport ? Math.round(session.viewport.height / 2) : 360;

  async function withPending<T>(action: typeof pendingAction, work: () => Promise<T>) {
    setPendingAction(action);
    setErrorMessage("");
    try {
      return await work();
    } catch (error) {
      setErrorMessage(toErrorMessage(error, "Action failed"));
      throw error;
    } finally {
      setPendingAction("");
    }
  }

  async function handleResume() {
    await withPending("resume", async () => {
      if (!session) return;
      if (hasControl) {
        await releaseBrowserSessionControl(session.session_id, { actor_id: controllerActorId });
      }
      await onResume();
      onClose();
    }).catch(() => {});
  }

  return (
    <Dialog
      open={open}
      onClose={pendingAction ? undefined : onClose}
      fullWidth
      maxWidth="lg"
      PaperProps={{
        sx: {
          borderRadius: "22px",
          overflow: "hidden",
        },
      }}
    >
      <DialogTitle sx={{ pb: 1.25 }}>
        <Stack direction={{ xs: "column", md: "row" }} spacing={1.25} justifyContent="space-between">
          <Box>
            <Typography variant="h6">Take control</Typography>
            <Typography variant="body2" color="text.secondary">
              Fix the live page, then resume the run from the current browser state.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
            {runState ? (
              <StatusPill label={runState.replaceAll("_", " ")} tone="warning" />
            ) : null}
            {session?.origin ? <StatusPill label={session.origin.replaceAll("_", " ")} tone="neutral" /> : null}
          </Stack>
        </Stack>
      </DialogTitle>
      <DialogContent dividers sx={{ py: 2 }}>
        {!session ? (
          <Typography variant="body2" color="text.secondary">
            No live browser session is attached to this run.
          </Typography>
        ) : (
          <Stack spacing={2}>
            {errorMessage ? (
              <Typography variant="body2" color="error.main">
                {errorMessage}
              </Typography>
            ) : null}

            <Stack direction={{ xs: "column", lg: "row" }} spacing={2} alignItems="stretch">
              <Box
                sx={{
                  flex: 1.5,
                  borderRadius: "20px",
                  border: "1px solid var(--border-subtle)",
                  backgroundColor: "var(--surface-card-muted)",
                  overflow: "hidden",
                  minHeight: 360,
                }}
              >
                {frame?.screenshot ? (
                  <Box
                    component="img"
                    src={frame.screenshot}
                    alt="Live browser session"
                    onClick={(event: MouseEvent<HTMLImageElement>) => {
                      if (!hasControl) return;
                      const point = mapImageClickToViewport(event, session.viewport);
                      if (!point) return;
                      void sendBrowserSessionInput(session.session_id, {
                        actor_id: controllerActorId,
                        input_type: "click",
                        x: point.x,
                        y: point.y,
                      }).catch((error) => setErrorMessage(toErrorMessage(error, "Failed to click session")));
                    }}
                    sx={{
                      width: "100%",
                      display: "block",
                      height: "100%",
                      minHeight: 360,
                      objectFit: "contain",
                      backgroundColor: "#111",
                      cursor: hasControl ? "crosshair" : "default",
                    }}
                  />
                ) : (
                  <Stack sx={{ p: 3, minHeight: 360 }} justifyContent="center" alignItems="center">
                    <Typography variant="body2" color="text.secondary">
                      Waiting for the live frame.
                    </Typography>
                  </Stack>
                )}
              </Box>

              <Stack sx={{ flex: 1, minWidth: 300 }} spacing={1.5}>
                <Box>
                  <Typography variant="body2" fontWeight={700}>
                    {currentTitle}
                  </Typography>
                  {currentUrl ? (
                    <Link href={currentUrl} target="_blank" rel="noreferrer" underline="hover" sx={{ wordBreak: "break-all" }}>
                      {currentUrl}
                    </Link>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      Current page URL is not available yet.
                    </Typography>
                  )}
                </Box>

                <Typography variant="caption" color="text.secondary">
                  Last frame: {pretty(frame?.timestamp)}. {hasControl ? "You can click directly on the frame." : "Acquire control to interact with the frame."}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Controller: {session.controller_lock?.actor_id || "None"} · Lock: {session.controller_lock ? `${Math.ceil(lockRemainingMs / 1000)}s left` : "Not held"}
                </Typography>

                <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                  <Button
                    variant={hasControl ? "outlined" : "contained"}
                    disabled={pendingAction !== ""}
                    onClick={() =>
                      void withPending("acquire", async () => {
                        await acquireBrowserSessionControl(session.session_id, {
                          actor_id: controllerActorId,
                          actor_type: "web",
                          priority: 100,
                          ttl_seconds: 300,
                        });
                      }).catch(() => {})
                    }
                  >
                    {hasControl ? "In control" : "Take control"}
                  </Button>
                  <Button
                    variant="text"
                    disabled={!hasControl || pendingAction !== ""}
                    onClick={() =>
                      void withPending("release", async () => {
                        await releaseBrowserSessionControl(session.session_id, {
                          actor_id: controllerActorId,
                        });
                      }).catch(() => {})
                    }
                  >
                    Release
                  </Button>
                  <Button
                    href={runId ? `/sessions?session_id=${encodeURIComponent(session.session_id)}&run_id=${encodeURIComponent(runId)}` : `/sessions?session_id=${encodeURIComponent(session.session_id)}`}
                    variant="outlined"
                  >
                    Full viewer
                  </Button>
                </Stack>

                <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                  <TextField
                    label="Open a page"
                    value={navigateUrl}
                    onChange={(event) => setNavigateUrl(event.target.value)}
                    fullWidth
                    size="small"
                  />
                  <Button
                    variant="outlined"
                    disabled={!navigateUrl.trim() || pendingAction !== ""}
                    onClick={() =>
                      void withPending("navigate", async () => {
                        await controlBrowserSession(session.session_id, {
                          action: "navigate",
                          url: navigateUrl,
                        });
                      }).catch(() => {})
                    }
                  >
                    Go
                  </Button>
                </Stack>

                <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                  <TextField
                    label="Type into focused field"
                    value={typeText}
                    onChange={(event) => setTypeText(event.target.value)}
                    fullWidth
                    size="small"
                  />
                  <Button
                    variant="contained"
                    disabled={!hasControl || !typeText.trim() || pendingAction !== ""}
                    onClick={() =>
                      void withPending("type", async () => {
                        await sendBrowserSessionInput(session.session_id, {
                          actor_id: controllerActorId,
                          input_type: "type",
                          text: typeText,
                        });
                        setTypeText("");
                      }).catch(() => {})
                    }
                  >
                    Type
                  </Button>
                </Stack>

                <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                  <Button
                    variant="outlined"
                    disabled={!hasControl || pendingAction !== ""}
                    onClick={() =>
                      void withPending("keypress", async () => {
                        await sendBrowserSessionInput(session.session_id, {
                          actor_id: controllerActorId,
                          input_type: "keypress",
                          key: "Enter",
                        });
                      }).catch(() => {})
                    }
                  >
                    Enter
                  </Button>
                  <Button
                    variant="outlined"
                    disabled={!hasControl || pendingAction !== ""}
                    onClick={() =>
                      void withPending("keypress", async () => {
                        await sendBrowserSessionInput(session.session_id, {
                          actor_id: controllerActorId,
                          input_type: "keypress",
                          key: "Escape",
                        });
                      }).catch(() => {})
                    }
                  >
                    Escape
                  </Button>
                  <Button
                    variant="outlined"
                    disabled={!hasControl || pendingAction !== ""}
                    onClick={() =>
                      void sendBrowserSessionInput(session.session_id, {
                        actor_id: controllerActorId,
                        input_type: "click",
                        x: clickX,
                        y: clickY,
                      }).catch((error) => setErrorMessage(toErrorMessage(error, "Failed to click center")))
                    }
                  >
                    Click center
                  </Button>
                </Stack>
              </Stack>
            </Stack>
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} disabled={pendingAction !== ""}>
          Close
        </Button>
        <Button
          variant="contained"
          onClick={() => void handleResume()}
          disabled={!session || pendingAction !== ""}
        >
          {runState === "failed" ? "Retry from here" : runState === "waiting_for_human" ? "Approve and resume" : "Resume from here"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
