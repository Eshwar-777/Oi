import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  Divider,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { MaterialSymbol, SurfaceCard, StatusPill, useOITheme } from "@oi/design-system-web";
import { useAssistant } from "@/features/assistant/AssistantContext";
import type { AutomationStep, AutomationStreamEvent, ConversationSummary } from "@/domain/automation";
import { StepPresentationStatus } from "./ChatTypes";
import { renderStepRows } from "./ChatUtils";

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

function stepStatusFromPhase(status: string): StepPresentationStatus {
  if (status === "completed") return "completed";
  if (status === "active") return "running";
  if (status === "blocked") return "waiting";
  return "pending";
}

function buildStreamActivityLines(events: AutomationStreamEvent[], activeRunId?: string | null) {
  return events
    .filter((event) => !activeRunId || event.run_id === activeRunId)
    .slice(-20)
    .map((event, index) => {
      const payload = event.payload as Record<string, unknown>;
      let text: string = event.type;
      if (event.type === "run.log") {
        text = String(payload.message ?? event.type);
      } else if (event.type === "run.runtime_incident") {
        const incident = payload.incident as Record<string, unknown> | undefined;
        text = String(incident?.summary ?? incident?.code ?? "Runtime incident");
      } else if (event.type === "run.failed") {
        text = String(payload.message ?? payload.code ?? "Run failed");
      } else if (event.type === "run.completed") {
        text = String(payload.message ?? "Run completed");
      } else if (event.type === "run.waiting_for_user_action" || event.type === "run.waiting_for_human") {
        text = String(payload.reason ?? "Waiting for intervention");
      }
      return {
        id: `${event.event_id}-${index}`,
        text,
        timestamp: event.timestamp,
      };
    });
}

function stepStatusFromRunStep(status?: AutomationStep["status"], runState?: string): StepPresentationStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return runState?.includes("waiting") ? "waiting" : "failed";
  if (status === "running") return runState?.includes("waiting") ? "waiting" : "running";
  if (runState === "paused" || runState === "human_controlling") return "paused";
  return "pending";
}

function buildVisibleStepRows(steps: AutomationStep[], runState?: string) {
  return steps.map((step) => ({
    step_id: step.step_id,
    label: step.label,
    command_payload: step.command_payload,
    description: step.description,
    status: stepStatusFromRunStep(step.status, runState),
    meta: step.status ?? "pending",
  }));
}

function stateTokenForRun(state?: string | null) {
  switch (state) {
    case "running":
    case "starting":
    case "resuming":
      return "Running";
    case "paused":
      return "Paused";
    case "waiting_for_user_action":
      return "Waiting for login";
    case "waiting_for_human":
      return "Needs confirmation";
    case "retrying":
      return "Retrying after rate limit";
    case "failed":
      return "Failed";
    case "completed":
    case "succeeded":
      return "Completed";
    default:
      return "Planning";
  }
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

function ConversationRail({
  conversations,
  selectedConversationId,
  onSelect,
  onCreate,
}: {
  conversations: ConversationSummary[];
  selectedConversationId: string | null;
  onSelect: (conversationId: string) => void;
  onCreate: () => void;
}) {
  return (
    <SurfaceCard>
      <Stack spacing={2}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            Conversations
          </Typography>
          <Button size="small" variant="contained" onClick={onCreate}>
            New chat
          </Button>
        </Stack>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {["All", "Needs attention", "Running", "Scheduled"].map((label) => (
            <Chip key={label} size="small" label={label} variant="outlined" />
          ))}
        </Stack>
        <Stack spacing={1}>
          {conversations.map((conversation) => {
            const selected = conversation.conversation_id === selectedConversationId;
            return (
              <Paper
                key={conversation.conversation_id}
                variant="outlined"
                onClick={() => onSelect(conversation.conversation_id)}
                sx={{
                  p: 1.5,
                  cursor: "pointer",
                  borderRadius: "18px",
                  borderColor: selected ? "var(--brand-500)" : "var(--border-subtle)",
                  backgroundColor: selected ? "rgba(227,238,255,0.72)" : "transparent",
                }}
              >
                <Stack spacing={0.75}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                    {conversation.title}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {conversation.summary || conversation.last_assistant_text || "No messages yet."}
                  </Typography>
                  <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap alignItems="center">
                    {conversation.badges.map((badge) => (
                      <StatusPill
                        key={badge}
                        label={badge}
                        tone={badge === "Running" ? "brand" : badge === "Scheduled" ? "success" : "warning"}
                      />
                    ))}
                    <Typography variant="caption" color="text.secondary">
                      {new Date(conversation.updated_at).toLocaleString()}
                    </Typography>
                  </Stack>
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      </Stack>
    </SurfaceCard>
  );
}

export function ChatPage() {
  const { mode } = useOITheme();
  const isDarkMode = mode === "dark";
  const {
    activeRun,
    conversations,
    createConversation,
    dismissError,
    errorMessage,
    isThinking,
    modelOptions,
    pauseActiveRun,
    resumeActiveRun,
    retryActiveRun,
    runDetails,
    schedules,
    selectConversation,
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
  const [detailsOpen, setDetailsOpen] = useState(true);
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
  const activeRunDetail = activeRun ? runDetails[activeRun.run_id] : null;
  const runtimeSteps = activeRunDetail?.plan.steps ?? [];
  const stepRows =
    runtimeSteps.length > 0
      ? buildVisibleStepRows(runtimeSteps, activeRun?.state)
      : (activeRun?.execution_progress?.predicted_phases ?? []).map((phase) => ({
          step_id: `${phase.phase_index}-${phase.label}`,
          label: phase.label,
          status: stepStatusFromPhase(phase.status),
          meta: phase.status,
        }));
  const streamActivityLines = useMemo(
    () => buildStreamActivityLines(streamEvents, activeRun?.run_id),
    [activeRun?.run_id, streamEvents],
  );
  const lastEvent = streamActivityLines.at(-1);

  useEffect(() => {
    if (!timelineRef.current) return;
    timelineRef.current.scrollTo({ top: timelineRef.current.scrollHeight, behavior: "smooth" });
  }, [transcriptItems.length, isThinking, activeRun?.updated_at]);

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
          gridTemplateColumns: { xs: "1fr", xl: "320px minmax(0, 1fr) 360px" },
          gap: 2.5,
          alignItems: "start",
        }}
      >
        <ConversationRail
          conversations={conversations}
          selectedConversationId={selectedConversationId}
          onSelect={(conversationId) => void selectConversation(conversationId)}
          onCreate={() => void createConversation()}
        />

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

            <Box
              ref={timelineRef}
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
                        backgroundColor: isUser ? "rgba(220,232,255,0.95)" : "rgba(255,255,255,0.9)",
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
                          p: 2,
                          borderRadius: "22px",
                          backgroundColor: "rgba(255,255,255,0.74)",
                        }}
                      >
                        <Stack spacing={1.5}>
                          <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" spacing={1}>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <StatusPill label={stateTokenForRun(activeRun.state)} tone={sessionTone(activeRun.state === "failed" ? "degraded" : "browser_attached")} />
                              <Typography variant="body2" color="text.secondary">
                                {lastEvent ? `Last event ${new Date(lastEvent.timestamp).toLocaleTimeString()}` : "Waiting for first event"}
                              </Typography>
                            </Stack>
                            <Stack direction="row" spacing={1}>
                              {(activeRun.state === "running" || activeRun.state === "starting" || activeRun.state === "resuming") ? (
                                <>
                                  <Button size="small" variant="outlined" onClick={() => void pauseActiveRun()}>
                                    Pause
                                  </Button>
                                  <Button size="small" color="error" variant="outlined" onClick={() => void stopActiveRun()}>
                                    Stop
                                  </Button>
                                </>
                              ) : null}
                              {(activeRun.state === "paused" || activeRun.state === "waiting_for_human" || activeRun.state === "waiting_for_user_action") ? (
                                <>
                                  <Button size="small" variant="outlined" onClick={() => void resumeActiveRun()}>
                                    Resume
                                  </Button>
                                  <Button
                                    size="small"
                                    variant="outlined"
                                    href={`/sessions${activeRun.browser_session_id ? `?session_id=${encodeURIComponent(activeRun.browser_session_id)}&run_id=${encodeURIComponent(activeRun.run_id)}` : ""}`}
                                  >
                                    Take over
                                  </Button>
                                </>
                              ) : null}
                              {(activeRun.state === "failed" || activeRun.state === "timed_out" || activeRun.state === "cancelled" || activeRun.state === "canceled") ? (
                                <Button size="small" variant="contained" onClick={() => void retryActiveRun()}>
                                  Retry
                                </Button>
                              ) : null}
                            </Stack>
                          </Stack>

                          <Typography variant="body2" color="text.secondary">
                            {activeRun.runtime_incident?.summary
                              || activeRun.last_error?.message
                              || sessionReadiness?.detail
                              || "Event stream is primary. Polling only resumes if the stream stalls."}
                          </Typography>

                          {stepRows.length > 0 ? renderStepRows(stepRows) : null}

                          <Button size="small" variant="text" onClick={() => setDetailsOpen((value) => !value)}>
                            {detailsOpen ? "Hide details" : "Show details"}
                          </Button>
                          <Collapse in={detailsOpen}>
                            <Stack spacing={1}>
                              {streamActivityLines.map((entry, entryIndex) => (
                                <Typography key={`${entry.id}-${entryIndex}`} variant="body2">
                                  {entry.text}
                                </Typography>
                              ))}
                            </Stack>
                          </Collapse>
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

            <Divider />

            <Paper
              variant="outlined"
              sx={{ display: "flex", borderRadius: "24px", p: 1, backgroundColor: "rgba(255,255,255,0.88)" }}
            >
              <Box
                component="textarea"
                value={text}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)}
                onKeyDown={onComposerKeyDown}
                placeholder="Describe the task, blocking state, or schedule. The run card will show the latest event, blocking reason, and controls."
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
