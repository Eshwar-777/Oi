import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import {
  Alert,
  Box,
  Button,
  IconButton,
  Divider,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { MaterialSymbol, SurfaceCard, StatusPill, useOITheme } from "@oi/design-system-web";
import { runStateHeadline, runStateTone } from "@oi/ui-presentation";
import { useAssistant } from "@/features/assistant/AssistantContext";
import type { AutomationStreamEvent,AutomationStep,ConversationSummary } from "@/domain/automation";

function itemText(item: Record<string, unknown>) {
  return typeof item.text === "string"
    ? item.text
    : typeof item.body === "string"
      ? item.body
      : typeof item.title === "string"
        ? item.title
        : "";
}

function itemTimestamp(item: Record<string, unknown>) {
  return typeof item.timestamp === "string" ? item.timestamp : "";
}

function progressEntryText(entry: Record<string, unknown>) {
  const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
  if (summary) return summary;
  const message = typeof entry.message === "string" ? entry.message : "";
  if (message.trim()) return message.trim();
  const label = typeof entry.label === "string" ? entry.label : "";
  if (label.trim()) return label.trim();
  const description = typeof entry.description === "string" ? entry.description : "";
  if (description.trim()) return description.trim();
  const value = typeof entry.value === "string" ? entry.value : "";
  if (value.trim()) return value.trim();
  const command = typeof entry.command === "string" ? entry.command.trim() : "";
  return command || "";
}

function normalizeActivityText(text: string) {
  return text
    .trim()
    .replace(/^I finished:\s*/i, "")
    .replace(/^I’m working on:\s*/i, "")
    .replace(/^I'm working on:\s*/i, "")
    .replace(/^I hit an issue while working on:\s*/i, "")
    .replace(/^I hit an issue during\s*/i, "")
    .replace(/\.\s*$/, "");
}

function activityLineTone(text: string): "default" | "warning" | "danger" {
  const normalized = text.toLowerCase();
  if (
    normalized.includes("failed")
    || normalized.includes("issue")
    || normalized.includes("blocked")
    || normalized.includes("error")
  ) {
    return "danger";
  }
  if (
    normalized.includes("waiting")
    || normalized.includes("pause")
    || normalized.includes("resume")
    || normalized.includes("retry")
  ) {
    return "warning";
  }
  return "default";
}

function isUserFacingActivityText(text: string) {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (
    normalized.startsWith("[runtime/")
    || normalized.startsWith("[agent-browser")
    || normalized.startsWith("at async ")
    || normalized.startsWith("{\"phase\":")
    || normalized.startsWith("{\"text\":")
    || normalized.includes("embedded run prompt end")
    || normalized.includes("prepared runtime session")
    || normalized.includes("seeded runtime config")
    || normalized.includes("/node_modules/")
    || normalized.includes("/users/")
    || normalized.includes("dotenv@")
  ) {
    return false;
  }
  return true;
}

function buildStreamActivityLines(
  events: AutomationStreamEvent[],
  activeRunId?: string | null,
  activeRun?: { execution_progress?: { current_runtime_action?: Record<string, unknown> | null; recent_action_log?: Array<Record<string, unknown>>; interruption?: Record<string, unknown> | null; status_summary?: string | null }; runtime_incident?: { summary?: string | null } | null; last_error?: { message?: string | null } | null; state?: string | null } | null,
) {
  const activityEvents = events
    .filter((event) => event.type === "run.activity" && (!activeRunId || event.run_id === activeRunId))
    .map((event, index) => {
      const payload =
        event.type === "run.activity"
          ? event.payload
          : { run_id: event.run_id ?? "", summary: "", tone: "neutral" as const };
      return {
        id: `${event.event_id}-${index}`,
        text: normalizeActivityText(String(payload.summary || "").trim()),
        timestamp: event.timestamp,
        tone: payload.tone ?? "neutral",
      };
    })
    .filter((entry) => entry.text && isUserFacingActivityText(entry.text));
  if (activityEvents.length > 0) {
    return activityEvents;
  }

  const progress = activeRun?.execution_progress;
  const agentLines: Array<{ id: string; text: string; timestamp: string; tone?: "neutral" | "warning" | "danger" | "success" }> = [];
  const recent = Array.isArray(progress?.recent_action_log) ? progress?.recent_action_log.slice(-6) : [];
  recent.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const text = progressEntryText(entry);
    const normalizedText = normalizeActivityText(text);
    if (!isUserFacingActivityText(normalizedText)) return;
    const timestamp = typeof entry.finished_at === "string" ? entry.finished_at : typeof entry.started_at === "string" ? entry.started_at : "";
    agentLines.push({
      id: `recent-${index}-${timestamp}`,
      text: normalizedText,
      timestamp,
      tone: "neutral",
    });
  });
  if (progress?.current_runtime_action && typeof progress.current_runtime_action === "object") {
    const entry = progress.current_runtime_action;
    const text = progressEntryText(entry);
    const normalizedText = normalizeActivityText(text);
    if (isUserFacingActivityText(normalizedText)) {
      agentLines.push({
        id: `current-${String(entry.step_id ?? entry.label ?? "step")}`,
        text: normalizedText,
        timestamp: typeof entry.started_at === "string" ? entry.started_at : "",
        tone: "neutral",
      });
    }
  }
  if (agentLines.length > 0) {
    return agentLines;
  }
  return [];
}

function sessionTone(status?: string | null): "neutral" | "brand" | "warning" | "success" | "danger" | "info" {
  switch (status) {
    case "browser_attached":
      return "success";
    case "local_ready":
    case "server_ready":
      return "brand";
    case "waiting_for_login":
    case "takeover_active":
      return "warning";
    case "degraded":
      return "danger";
    default:
      return "neutral";
  }
}

export function ChatPage() {
  const { mode } = useOITheme();
  const isDarkMode = mode === "dark";
  const {
    activeRun,
    createConversation,
    dismissError,
    errorMessage,
    isThinking,
    modelOptions,
    pauseActiveRun,
    resumeActiveRun,
    retryActiveRun,
    schedules,
    selectedConversationId,
    selectedModel,
    selectModel,
    sendTurn,
    sessionReadiness,
    stopActiveRun,
    streamEvents,
    timeline,
  } = useAssistant();
  const [text, setText] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const transcriptItems = useMemo(
    () => timeline.filter((item) => ["user", "assistant"].includes(String(item.type ?? ""))),
    [timeline],
  );
  const lastAssistantItemId = useMemo(
    () => {
      const assistantItems = transcriptItems.filter((item) => String(item.type) === "assistant");
      return assistantItems.length > 0 ? String(assistantItems[assistantItems.length - 1]?.id ?? "") : "";
    },
    [transcriptItems],
  );
  const streamActivityLines = useMemo(
    () => buildStreamActivityLines(streamEvents, activeRun?.run_id, activeRun),
    [activeRun, streamEvents],
  );
  const lastEvent = streamActivityLines.at(-1);
  const runSummary =
    activeRun?.execution_progress?.status_summary
    || activeRun?.runtime_incident?.summary
    || activeRun?.last_error?.message
    || sessionReadiness?.detail
    || "I’ll keep posting meaningful progress updates here.";
  const visibleRunSummary = isUserFacingActivityText(runSummary) ? runSummary : "I’ll keep posting meaningful progress updates here.";

  const scrollToLatest = (behavior: ScrollBehavior = "smooth") => {
    if (!timelineRef.current) return;
    timelineRef.current.scrollTo({ top: timelineRef.current.scrollHeight, behavior });
  };

  useEffect(() => {
    if (!isNearBottom) return;
    scrollToLatest(transcriptItems.length <= 1 ? "auto" : "smooth");
  }, [activeRun?.updated_at, isNearBottom, isThinking, transcriptItems.length]);

  const handleTimelineScroll = () => {
    if (!timelineRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = timelineRef.current;
    setIsNearBottom(scrollHeight - (scrollTop + clientHeight) < 56);
  };

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || isThinking) return;
    setText("");
    await sendTurn(trimmed, []);
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void submit();
  };

  return (
    <Box
      sx={{
        minHeight: "100%",
        background: isDarkMode
          ? "linear-gradient(180deg, rgba(17,20,26,0.96), rgba(10,13,18,1))"
          : "linear-gradient(180deg, #f6f4ef 0%, #efe8dd 100%)",
        px: { xs: 2, md: 3 },
        py: { xs: 2, md: 3 },
      }}
    >
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", xl: "minmax(0, 1fr) 360px" },
          gap: 2.5,
          alignItems: "start",
        }}
      >
        <SurfaceCard>
          <Stack spacing={2}>
            <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" spacing={1.5}>
              <Box>
                <Typography variant="overline" sx={{ color: "text.secondary", letterSpacing: 1.2, fontWeight: 700 }}>
                  Chat
                </Typography>
                <Typography variant="h5" sx={{ fontWeight: 700 }}>
                  {selectedConversationId ? "Operational conversation" : "Create a conversation"}
                </Typography>
              </Box>
              <Stack direction="row" spacing={1} alignItems="center">
                <Button size="small" variant="outlined" onClick={() => void createConversation()}>
                  New chat
                </Button>
                {sessionReadiness ? (
                  <Button
                    href={`/sessions${sessionReadiness.browser_session_id ? `?session_id=${encodeURIComponent(sessionReadiness.browser_session_id)}` : ""}`}
                    variant="outlined"
                    size="small"
                  >
                    <StatusPill label={sessionReadiness.label} tone={sessionTone(sessionReadiness.status)} />
                  </Button>
                ) : null}
                <Select
                  size="small"
                  value={selectedModel}
                  onChange={(event) => selectModel(String(event.target.value))}
                  sx={{ minWidth: 220, borderRadius: "16px", backgroundColor: "rgba(255,255,255,0.72)" }}
                >
                  <MenuItem value="auto">Auto</MenuItem>
                  {modelOptions.map((item, index) => (
                    <MenuItem key={`${item.id}-${index}`} value={item.id}>
                      {item.label}
                    </MenuItem>
                  ))}
                </Select>
              </Stack>
            </Stack>

            {errorMessage ? (
              <Alert severity="error" onClose={dismissError}>
                {errorMessage}
              </Alert>
            ) : null}

            <Box sx={{ position: "relative" }}>
              <Box
                ref={timelineRef}
                onScroll={handleTimelineScroll}
                sx={{
                  minHeight: "62vh",
                  maxHeight: "68vh",
                  overflowY: "auto",
                  display: "flex",
                  flexDirection: "column",
                  gap: 1.5,
                  pr: 1,
                }}
              >
              {transcriptItems.map((item, index) => {
                const isUser = String(item.type) === "user";
                return (
                  <Stack
                    key={`${String(item.id)}-${String(item.type)}-${index}`}
                    spacing={1}
                    alignItems={isUser ? "flex-end" : "flex-start"}
                  >
                    <Paper
                      sx={{
                        maxWidth: { xs: "96%", md: "84%" },
                        px: 2.25,
                        py: 1.5,
                        borderRadius: isUser ? "22px 22px 8px 22px" : "22px 22px 22px 8px",
                        backgroundColor: isUser
                          ? (isDarkMode ? "rgba(101, 140, 221, 0.26)" : "rgba(220,232,255,0.95)")
                          : (isDarkMode ? "rgba(20,24,31,0.96)" : "rgba(255,255,255,0.9)"),
                        border: "1px solid var(--border-subtle)",
                        boxShadow: "none",
                      }}
                    >
                      <Typography variant="body1">{itemText(item)}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {itemTimestamp(item) ? new Date(itemTimestamp(item)).toLocaleString() : ""}
                      </Typography>
                    </Paper>

                    {!isUser && activeRun && String(item.id) === lastAssistantItemId ? (
                      <Paper
                        variant="outlined"
                        sx={{
                          width: "100%",
                          p: 1.5,
                          borderRadius: "24px",
                          boxShadow: "0 10px 30px rgba(15, 23, 42, 0.06)",
                          backgroundColor: isDarkMode ? "rgba(18,22,28,0.94)" : "rgba(255,255,255,0.74)",
                          background:
                            isDarkMode ? "linear-gradient(180deg, rgba(18,22,28,0.94), rgba(18,22,28,0.8))" : "linear-gradient(180deg, rgba(255,255,255,0.84), rgba(255,255,255,0.7))",
                          borderColor: "var(--border-default)",
                        }}
                      >
                        <Stack spacing={1.25}>
                          <Stack
                            direction={{ xs: "column", lg: "row" }}
                            justifyContent="space-between"
                            spacing={1.25}
                            alignItems={{ xs: "stretch", lg: "flex-start" }}
                          >
                            <Box
                              sx={{
                                minWidth: 0,
                                flex: 1,
                                borderRadius: "20px",
                                px: 1.5,
                                py: 1.25,
                                backgroundColor: "rgba(246, 248, 251, 0.9)",
                                border: "1px solid rgba(15, 23, 42, 0.08)",
                              }}
                            >
                              <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>
                                Agent activity
                              </Typography>
                              <Typography
                                variant="body1"
                                sx={{ mt: 0.5, fontWeight: 500, color: "text.primary" }}
                              >
                                {lastEvent?.text || visibleRunSummary}
                              </Typography>
                            </Box>
                            <Stack
                              direction="row"
                              spacing={1}
                              useFlexGap
                              flexWrap="wrap"
                              justifyContent={{ xs: "flex-start", lg: "flex-end" }}
                            >
                              {(activeRun.state === "running" || activeRun.state === "starting" || activeRun.state === "resuming") ? (
                                <>
                                  <Button size="small" variant="outlined" sx={{ borderRadius: "999px", px: 2 }} onClick={() => void pauseActiveRun()}>
                                    Pause
                                  </Button>
                                  <Button size="small" color="error" variant="outlined" sx={{ borderRadius: "999px", px: 2 }} onClick={() => void stopActiveRun()}>
                                    Stop
                                  </Button>
                                </>
                              ) : null}
                              {(activeRun.state === "paused" || activeRun.state === "waiting_for_human" || activeRun.state === "waiting_for_user_action") ? (
                                <>
                                  <Button size="small" variant="outlined" sx={{ borderRadius: "999px", px: 2 }} onClick={() => void resumeActiveRun()}>
                                    Resume
                                  </Button>
                                  <Button
                                    size="small"
                                    variant="outlined"
                                    sx={{ borderRadius: "999px", px: 2 }}
                                    href={`/sessions${activeRun.browser_session_id ? `?session_id=${encodeURIComponent(activeRun.browser_session_id)}&run_id=${encodeURIComponent(activeRun.run_id)}` : ""}`}
                                  >
                                    Take over
                                  </Button>
                                </>
                              ) : null}
                              {(activeRun.state === "failed" || activeRun.state === "timed_out" || activeRun.state === "cancelled" || activeRun.state === "canceled") ? (
                                <Button size="small" variant="contained" sx={{ borderRadius: "999px", px: 2.25 }} onClick={() => void retryActiveRun()}>
                                  Retry
                                </Button>
                              ) : null}
                            </Stack>
                          </Stack>

                          <Paper
                            variant="outlined"
                            sx={{
                              borderRadius: "20px",
                              overflow: "hidden",
                              borderColor: "rgba(15, 23, 42, 0.08)",
                              backgroundColor: "rgba(252, 252, 251, 0.82)",
                            }}
                          >
                            <Button
                              size="small"
                              variant="text"
                              onClick={() => setDetailsOpen((value) => !value)}
                              sx={{
                                width: "100%",
                                justifyContent: "space-between",
                                px: 1.5,
                                py: 1.1,
                                borderRadius: 0,
                                color: "text.primary",
                                fontWeight: 700,
                              }}
                            >
                              <span>Live stream</span>
                              <MaterialSymbol name={detailsOpen ? "chevron_left" : "chevron_right"} sx={{ fontSize: 20, transform: detailsOpen ? "rotate(90deg)" : "none", transition: "transform 160ms ease" }} />
                            </Button>

                            {detailsOpen ? (
                              <Box
                                sx={{
                                  px: 1.5,
                                  py: 1.25,
                                  maxHeight: 190,
                                  overflowY: "auto",
                                  borderTop: "1px solid rgba(15, 23, 42, 0.08)",
                                }}
                              >
                                <Stack spacing={1.1}>
                                  {streamActivityLines.length > 0 ? (
                                    streamActivityLines.map((entry, entryIndex) => {
                                      const tone =
                                        entry.tone === "warning" || entry.tone === "danger"
                                          ? entry.tone
                                          : activityLineTone(entry.text);
                                      return (
                                        <Stack
                                          key={`${entry.id}-${entryIndex}`}
                                          direction="row"
                                          spacing={1}
                                          alignItems="flex-start"
                                        >
                                          <Box
                                            sx={{
                                              mt: 0.6,
                                              width: 10,
                                              minWidth: 10,
                                              display: "flex",
                                              justifyContent: "center",
                                              flexShrink: 0,
                                            }}
                                          >
                                            {tone === "warning" || tone === "danger" ? (
                                              <Box
                                                sx={{
                                                  width: 8,
                                                  height: 8,
                                                  borderRadius: "999px",
                                                  backgroundColor:
                                                    tone === "danger" ? "error.main" : "warning.main",
                                                  boxShadow:
                                                    tone === "danger"
                                                      ? "0 0 0 4px rgba(211, 47, 47, 0.12)"
                                                      : "0 0 0 4px rgba(237, 108, 2, 0.12)",
                                                }}
                                              />
                                            ) : null}
                                          </Box>
                                          <Typography
                                            variant="body2"
                                            sx={{
                                              lineHeight: 1.45,
                                              color: tone === "default" ? "text.secondary" : "text.primary",
                                            }}
                                          >
                                            {entry.text}
                                          </Typography>
                                        </Stack>
                                      );
                                    })
                                  ) : (
                                    <Typography variant="body2" color="text.secondary">
                                      {visibleRunSummary}
                                    </Typography>
                                  )}
                                </Stack>
                              </Box>
                            ) : null}
                          </Paper>
                        </Stack>
                      </Paper>
                    ) : null}
                  </Stack>
                );
              })}

              {isThinking ? (
                <Paper sx={{ alignSelf: "flex-start", px: 2, py: 1.2, borderRadius: "20px 20px 20px 8px" }}>
                  <Typography variant="body2" color="text.secondary">
                    Planning
                  </Typography>
                </Paper>
              ) : null}
              </Box>
              {!isNearBottom ? (
                <IconButton
                  aria-label="Scroll to latest message"
                  onClick={() => {
                    setIsNearBottom(true);
                    scrollToLatest();
                  }}
                  sx={{
                    position: "absolute",
                    right: 16,
                    bottom: 16,
                    width: 52,
                    height: 52,
                    borderRadius: "16px",
                    backgroundColor: isDarkMode ? "rgba(24, 28, 36, 0.94)" : "rgba(255, 255, 255, 0.96)",
                    border: "1px solid var(--border-default)",
                    boxShadow: "var(--shadow-md)",
                    "&:hover": {
                      backgroundColor: isDarkMode ? "rgba(31, 37, 46, 0.98)" : "rgba(255, 255, 255, 1)",
                    },
                  }}
                >
                  <MaterialSymbol name="expand_more" sx={{ fontSize: 26, transform: "rotate(180deg)" }} />
                </IconButton>
              ) : null}
            </Box>

            <Divider />

            <Paper
              variant="outlined"
              sx={{
                display: "flex",
                borderRadius: "24px",
                p: 1,
                backgroundColor: isDarkMode ? "rgba(18,22,28,0.92)" : "rgba(255,255,255,0.88)",
                borderColor: "var(--border-default)",
              }}
            >
              <Box
                component="textarea"
                value={text}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)}
                onKeyDown={onComposerKeyDown}
                placeholder="Describe the task or reply to unblock the run. I’ll keep progress updates in the chat as the agent works."
                sx={{
                  width: "100%",
                  border: 0,
                  outline: "none",
                  resize: "none",
                  minHeight: 78,
                  px: 1.25,
                  py: 1,
                  background: "transparent",
                  font: "inherit",
                }}
              />
              <Button variant="contained" onClick={() => void submit()} disabled={isThinking || !text.trim()} sx={{ borderRadius: "999px", px: 2.5 }}>
                <MaterialSymbol name="send" sx={{ fontSize: 20 }} />
              </Button>
            </Paper>
          </Stack>
        </SurfaceCard>

        <SurfaceCard>
            <Stack spacing={1}>
              <Typography variant="subtitle2">Schedules</Typography>
              {schedules.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No schedules attached to this conversation.
                </Typography>
              ) : (
                schedules.map((schedule, index) => (
                  <Paper key={`${schedule.schedule_id}-${index}`} variant="outlined" sx={{ p: 1.25, borderRadius: "16px" }}>
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>
                      {schedule.user_goal}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {schedule.run_times.join(", ")}
                    </Typography>
                  </Paper>
                ))
              )}
            </Stack>
          
        </SurfaceCard>
      </Box>
    </Box>
  );
}
