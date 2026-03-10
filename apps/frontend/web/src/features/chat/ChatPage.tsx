import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import {
  Alert,
  Box,
  Button,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import {
  MaterialSymbol,
  SurfaceCard,
  useOITheme,
} from "@oi/design-system-web";
import { useAssistant } from "@/features/assistant/AssistantContext";
import type { AutomationStep } from "@/domain/automation";
import { runStateLabel } from "@/features/assistant/uiCopy";
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

function buildActivityLines(entries: Array<Record<string, unknown>>) {
  return entries.map((entry, index) => ({
    id: `${index}-${String(entry.label ?? entry.message ?? entry.command ?? "activity")}`,
    text: String(entry.message ?? entry.label ?? entry.command ?? "Step update"),
  }));
}

function stepStatusFromRunStep(
  status?: AutomationStep["status"],
  runState?: string,
): StepPresentationStatus {
  if (status === "completed") return "completed";
  if (status === "failed") {
    return runState === "waiting_for_user_action" || runState === "waiting_for_human" ? "waiting" : "failed";
  }
  if (status === "running") {
    return runState === "waiting_for_user_action" || runState === "waiting_for_human" ? "waiting" : "running";
  }
  if (runState === "paused" || runState === "human_controlling") return "paused";
  return "pending";
}

function buildVisibleStepRows(
  steps: AutomationStep[],
  runState?: string,
) {
  if (steps.length === 0) return [];

  const completedCount = steps.filter((step) => step.status === "completed").length;
  const runningIndex = steps.findIndex((step) => step.status === "running" || step.status === "failed");
  const firstPendingIndex = steps.findIndex((step) => !step.status || step.status === "pending");

  let visibleCount = 1;
  if (completedCount > 0) {
    visibleCount = completedCount + 1;
  }
  if (runningIndex >= 0) {
    visibleCount = Math.max(visibleCount, runningIndex + 1);
  } else if (firstPendingIndex >= 0) {
    visibleCount = Math.max(visibleCount, firstPendingIndex + 1);
  } else {
    visibleCount = steps.length;
  }
  if (runState === "completed" || runState === "succeeded" || runState === "failed" || runState === "cancelled" || runState === "canceled") {
    visibleCount = steps.length;
  }

  return steps.slice(0, visibleCount).map((step, index) => ({
    step_id: step.step_id,
    label: step.label,
    command_payload: step.command_payload,
    description: step.description,
    status: stepStatusFromRunStep(step.status, runState),
    meta:
      index === visibleCount - 1 && step.status !== "completed" && visibleCount < steps.length
        ? "active"
        : step.status ?? "pending",
  }));
}

export function ChatPage() {
  const { mode } = useOITheme();
  const isDarkMode = mode === "dark";
  const {
    activeRun,
    errorMessage,
    dismissError,
    isThinking,
    modelOptions,
    runDetails,
    selectedModel,
    selectModel,
    sendTurn,
    timeline,
  } = useAssistant();
  const [text, setText] = useState("");
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const liveActivityRef = useRef<HTMLDivElement | null>(null);
  const textHistoryRef = useRef<string[]>([]);
  const [loaderTick, setLoaderTick] = useState(0);

  const suggestedActions = [
    {
      title: "Create a release schedule",
      description: "Set up a one-time or recurring rollout for a feature, review, or team workflow.",
      prompt:
        "Create a schedule for our next release review every Tuesday at 10:00 AM and remind me one hour before it starts.",
      icon: "schedule",
      tone: "brand" as const,
    },
    {
      title: "Design a UI navigation flow",
      description: "Draft the path, screens, and decision points for a product journey before building it.",
      prompt:
        "Create a UI navigation flow for a first-time user setting up devices, joining the mesh, and confirming connection health.",
      icon: "settings",
      tone: "info" as const,
    },
    {
      title: "Plan device mesh onboarding",
      description: "Map pairing, status checks, recovery states, and success criteria for setup.",
      prompt:
        "Outline a device mesh onboarding workflow with pairing, permission checks, retry states, and success criteria.",
      icon: "hub",
      tone: "success" as const,
    },
    {
      title: "Schedule automation QA checks",
      description: "Create repeated runs for smoke checks, UI audits, and workflow validation.",
      prompt:
        "Set up a recurring QA automation to verify the chat flow, schedule creation, and device status every weekday at 9:30 AM.",
      icon: "check_circle",
      tone: "warning" as const,
    },
  ] as const;

  const transcriptItems = useMemo(
    () =>
      timeline.filter((item) => {
        const type = String(item.type ?? "");
        return type === "user" || type === "assistant";
      }),
    [timeline],
  );

  const activeRunDetail = activeRun ? runDetails[activeRun.run_id] : null;
  const executionProgress = activeRun?.execution_progress ?? activeRunDetail?.run.execution_progress ?? null;
  const predictedPhases = executionProgress?.predicted_phases ?? [];
  const runtimeSteps = activeRunDetail?.plan.steps ?? [];
  const activityLines = buildActivityLines(executionProgress?.recent_action_log ?? []);
  const interruption = executionProgress?.interruption ?? null;
  const stepRows =
    runtimeSteps.length > 0
      ? buildVisibleStepRows(runtimeSteps, activeRun?.state)
      : predictedPhases.slice(0, 1).map((phase) => ({
          step_id: `${phase.phase_index}-${phase.label}`,
          label: phase.label,
          status: stepStatusFromPhase(phase.status),
          meta: phase.status,
        }));

  useEffect(() => {
    if (!timelineRef.current) return;
    timelineRef.current.scrollTo({ top: timelineRef.current.scrollHeight, behavior: "smooth" });
  }, [transcriptItems.length, isThinking]);

  useEffect(() => {
    if (!liveActivityRef.current) return;
    liveActivityRef.current.scrollTo({ top: liveActivityRef.current.scrollHeight, behavior: "smooth" });
  }, [activityLines.length, interruption, activeRun?.state]);

  useEffect(() => {
    const next = window.setInterval(() => {
      setLoaderTick((value) => (value + 1) % 3);
    }, 420);
    return () => window.clearInterval(next);
  }, []);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || isThinking) return;
    textHistoryRef.current = [...textHistoryRef.current.slice(-9), trimmed];
    setText("");
    await sendTurn(trimmed, []);
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void submit();
  };

  const emptyState = transcriptItems.length === 0;

  return (
    <Box
      sx={{
        minHeight: "100%",
        background: isDarkMode
          ? "radial-gradient(circle at top left, rgba(73,109,137,0.18), transparent 36%), linear-gradient(180deg, rgba(15,20,24,0.96), rgba(12,14,18,1))"
          : "radial-gradient(circle at top left, rgba(197,225,214,0.48), transparent 28%), radial-gradient(circle at top right, rgba(250,225,192,0.52), transparent 32%), linear-gradient(180deg, #f7f4ee 0%, #f4f0e8 100%)",
        px: { xs: 2, md: 3 },
        py: { xs: 2, md: 3 },
      }}
    >
      <Stack spacing={3}>
        <Box
          sx={{
            display: "flex",
            alignItems: { xs: "flex-start", md: "center" },
            justifyContent: "space-between",
            flexDirection: { xs: "column", md: "row" },
            gap: 2,
          }}
        >
          <Box>
            <Typography
              variant="overline"
              sx={{
                color: "text.secondary",
                letterSpacing: 1.4,
                fontWeight: 700,
              }}
            >
              Conversation
            </Typography>
            <Typography variant="h4" sx={{ fontWeight: 700, letterSpacing: -0.6 }}>
              Launch automations, draft flows, and move from idea to scheduled execution.
            </Typography>
          </Box>

          <Select
            size="small"
            value={selectedModel}
            onChange={(event) => selectModel(String(event.target.value))}
            sx={{
              minWidth: 220,
              borderRadius: "16px",
              backgroundColor: "rgba(255,255,255,0.72)",
            }}
          >
            {modelOptions.length === 0 ? (
              <MenuItem value={selectedModel}>{selectedModel}</MenuItem>
            ) : (
              modelOptions.map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {item.label}
                </MenuItem>
              ))
            )}
          </Select>
        </Box>

        {errorMessage ? (
          <Alert severity="error" onClose={dismissError}>
            {errorMessage}
          </Alert>
        ) : null}

        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", xl: "minmax(0, 1.35fr) minmax(360px, 0.75fr)" },
            gap: 3,
            alignItems: "start",
          }}
        >
          <Box sx={{ borderRadius: "28px", overflow: "hidden" }}>
            <SurfaceCard>
            <Box
              sx={{
                px: { xs: 2, md: 3 },
                py: 2,
                borderBottom: "1px solid var(--border-subtle)",
                backgroundColor: "rgba(255,255,255,0.55)",
              }}
            >
              <Typography variant="h6" sx={{ fontWeight: 700 }}>
                Chat
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Text in, text out. The assistant asks follow-ups, runs when ready, and uses this thread for interruptions.
              </Typography>
            </Box>

            <Box
              ref={timelineRef}
              sx={{
                px: { xs: 2, md: 3 },
                py: 3,
                minHeight: "58vh",
                maxHeight: "68vh",
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 2.25,
                backgroundColor: isDarkMode ? "rgba(15,18,24,0.55)" : "rgba(255,255,255,0.42)",
              }}
            >
              {emptyState ? (
                <Box sx={{ display: "grid", gap: 1.25 }}>
                  {suggestedActions.map((action) => (
                    <Paper
                      key={action.title}
                      variant="outlined"
                      onClick={() => setText(action.prompt)}
                      sx={{
                        p: 2,
                        borderRadius: "22px",
                        cursor: "pointer",
                        transition: "transform 0.18s ease, border-color 0.18s ease",
                        "&:hover": {
                          transform: "translateY(-2px)",
                          borderColor: "var(--brand-500)",
                        },
                      }}
                    >
                      <Stack direction="row" spacing={1.5} alignItems="flex-start">
                        <MaterialSymbol name={action.icon} sx={{ fontSize: 22, mt: 0.25 }} />
                        <Box>
                          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                            {action.title}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {action.description}
                          </Typography>
                        </Box>
                      </Stack>
                    </Paper>
                  ))}
                </Box>
              ) : null}

              {transcriptItems.map((item) => {
                const isUser = String(item.type) === "user";
                return (
                  <Box
                    key={String(item.id)}
                    sx={{
                      display: "flex",
                      justifyContent: isUser ? "flex-end" : "flex-start",
                    }}
                  >
                    <Paper
                      sx={{
                        maxWidth: { xs: "92%", md: "82%" },
                        px: 2.25,
                        py: 1.6,
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
                  </Box>
                );
              })}

              {isThinking ? (
                <Paper
                  sx={{
                    alignSelf: "flex-start",
                    px: 2,
                    py: 1.3,
                    borderRadius: "20px 20px 20px 8px",
                    backgroundColor: "rgba(255,255,255,0.85)",
                    border: "1px solid var(--border-subtle)",
                  }}
                >
                  <Typography variant="body2" color="text.secondary">
                    Assistant is thinking{".".repeat(loaderTick + 1)}
                  </Typography>
                </Paper>
              ) : null}
            </Box>

            <Box
              sx={{
                px: { xs: 2, md: 3 },
                py: 2,
                borderTop: "1px solid var(--border-subtle)",
                backgroundColor: "rgba(255,255,255,0.55)",
              }}
            >
              <Paper
                variant="outlined"
                sx={{
                  display: "flex",
                  borderRadius: "24px",
                  p: 1,
                  backgroundColor: "rgba(255,255,255,0.88)",
                }}
              >
                <Box
                  component={"textarea"}
                  value={text}
                  onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)}
                  onKeyDown={onComposerKeyDown}
                  placeholder="Ask Oye to run something now, later, every hour, or at multiple times."
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
                    color: "text.primary",
                  }}
                />
                <Button
                    variant="contained"
                    onClick={() => void submit()}
                    disabled={isThinking || !text.trim()}
                    sx={{ borderRadius: "999px", px: 2.5 }}
                  >
                    <MaterialSymbol name="send" sx={{ fontSize: 20 }} />
                  </Button>
              </Paper>
            </Box>
            </SurfaceCard>
          </Box>

          <Stack spacing={2.5}>
            <Box
              sx={{
                borderRadius: "28px",
                overflow: "hidden",
                background: isDarkMode
                  ? "linear-gradient(180deg, rgba(29,34,42,0.92), rgba(17,20,26,0.96))"
                  : "linear-gradient(180deg, rgba(252,249,243,0.96), rgba(245,240,231,0.98))",
              }}
            >
              <SurfaceCard>
              <Stack spacing={2}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Box>
                    <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: 1.2, fontWeight: 700 }}>
                      Live execution
                    </Typography>
                    <Typography variant="h6" sx={{ fontWeight: 700 }}>
                      {activeRun ? runStateLabel(activeRun.state) : "Waiting for a run"}
                    </Typography>
                  </Box>
                </Stack>

                <Typography variant="body2" color="text.secondary">
                  {activeRun
                    ? "The agent reveals each browser step as it becomes active and keeps completed steps visible for context."
                    : "Once the conversation has enough detail, the assistant starts the run or creates the schedule automatically."}
                </Typography>

                {stepRows.length > 0 ? renderStepRows(stepRows) : null}

                <Paper
                  ref={liveActivityRef}
                  variant="outlined"
                  sx={{
                    borderRadius: "22px",
                    p: 1.75,
                    minHeight: 220,
                    maxHeight: 320,
                    overflowY: "auto",
                    backgroundColor: isDarkMode ? "rgba(10,12,16,0.55)" : "rgba(255,255,255,0.74)",
                  }}
                >
                  <Stack spacing={1.25} justifyContent="flex-end" minHeight="100%">
                    {activityLines.map((entry) => (
                      <Typography key={entry.id} variant="body2">
                        {entry.text}
                      </Typography>
                    ))}
                    {interruption && typeof interruption.message === "string" ? (
                      <Alert severity={interruption.requires_confirmation ? "warning" : "info"}>
                        {interruption.message}
                      </Alert>
                    ) : null}
                    {activityLines.length === 0 && !interruption ? (
                      <Typography variant="body2" color="text.secondary">
                        The live activity feed will stream here as the run moves through the browser.
                      </Typography>
                    ) : null}
                  </Stack>
                </Paper>
              </Stack>
              </SurfaceCard>
            </Box>
          </Stack>
        </Box>
      </Stack>
    </Box>
  );
}
