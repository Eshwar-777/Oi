import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Divider,
  IconButton,
  List,
  ListItem,
  MenuItem,
  Paper,
  Select,
  Stack,
  SvgIcon,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  SectionHeader,
  StatusPill,
  SurfaceCard,
} from "@oi/design-system-web";
import type { ComposerAttachment, ExecutionMode } from "@/domain/automation";
import { useAssistant } from "@/features/assistant/AssistantContext";
import { errorCopy, missingFieldLabel, runStateLabel } from "@/features/assistant/uiCopy";

type StepPresentationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "paused"
  | "waiting";

function toneForRunState(
  state: string,
): "neutral" | "brand" | "warning" | "success" | "danger" | "info" {
  if (state === "completed") return "success";
  if (state === "failed" || state === "cancelled") return "danger";
  if (state === "paused" || state === "waiting_for_user_action") return "warning";
  if (state === "scheduled") return "info";
  if (state === "running" || state === "queued" || state === "retrying") return "brand";
  return "neutral";
}

function stepStatusLabel(status: StepPresentationStatus) {
  switch (status) {
    case "completed":
      return "Completed";
    case "running":
      return "In progress";
    case "failed":
      return "Failed";
    case "paused":
      return "Paused";
    case "waiting":
      return "Waiting for you";
    default:
      return "Pending";
  }
}

function stepStatusTone(
  status: StepPresentationStatus,
): "neutral" | "brand" | "warning" | "success" | "danger" | "info" {
  switch (status) {
    case "completed":
      return "success";
    case "running":
      return "brand";
    case "failed":
      return "danger";
    case "paused":
    case "waiting":
      return "warning";
    default:
      return "neutral";
  }
}

function stepStatusColor(status: StepPresentationStatus) {
  switch (status) {
    case "completed":
      return "#2e7d32";
    case "running":
      return "#0b57d0";
    case "failed":
      return "#b3261e";
    case "paused":
    case "waiting":
      return "#b26a00";
    default:
      return "var(--text-secondary)";
  }
}

function stepStatusPath(status: StepPresentationStatus) {
  switch (status) {
    case "completed":
      return "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15l-5-5 1.41-1.41L11 14.17l7.59-7.59L20 8l-9 9z";
    case "running":
      return "M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0020 12c0-4.42-3.58-8-8-8zm-6.76.74L3.78 6.2A7.93 7.93 0 004 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8z";
    case "failed":
      return "M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z";
    case "paused":
      return "M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z";
    case "waiting":
      return "M12 2C6.48 2 2 6.48 2 12h2a8 8 0 111.76 5.03l1.42 1.42A10 10 0 1012 2zm-1 5h2v6h-2zm0 8h2v2h-2z";
    default:
      return "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z";
  }
}

function StepStatusIcon({ status }: { status: StepPresentationStatus }) {
  return (
    <SvgIcon sx={{ fontSize: 22, color: stepStatusColor(status), flexShrink: 0, mt: 0.25 }}>
      <path d={stepStatusPath(status)} />
    </SvgIcon>
  );
}

function renderStepRows(
  steps: Array<{
    step_id: string;
    label: string;
    description?: string;
    meta?: string;
    status: StepPresentationStatus;
  }>,
) {
  return (
    <List disablePadding>
      {steps.map((step) => (
        <ListItem key={step.step_id} disableGutters alignItems="flex-start" sx={{ gap: 1.5, py: 1.1 }}>
          <StepStatusIcon status={step.status} />
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Stack
              direction={{ xs: "column", sm: "row" }}
              spacing={1}
              alignItems={{ xs: "flex-start", sm: "center" }}
              justifyContent="space-between"
              sx={{ mb: 0.25 }}
            >
              <Typography variant="body2" fontWeight={700}>
                {step.label}
              </Typography>
              <StatusPill label={stepStatusLabel(step.status)} tone={stepStatusTone(step.status)} />
            </Stack>
            <Typography variant="body2" color="text.secondary">
              {step.meta || step.description || "Waiting for this step to begin."}
            </Typography>
          </Box>
        </ListItem>
      ))}
    </List>
  );
}

export function ChatPage() {
  const {
    activeRun,
    confirmPendingIntent,
    controlRun,
    chooseExecutionMode,
    isThinking,
    pendingIntent,
    runDetails,
    schedules,
    selectedModel,
    selectModel,
    sendTurn,
    timeline,
  } = useAssistant();

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [onceAt, setOnceAt] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState("3600");
  const [multiTimes, setMultiTimes] = useState("");
  const [selectedExecutionMode, setSelectedExecutionMode] =
    useState<Exclude<ExecutionMode, "unknown">>("immediate");

  const activeRunDetail = activeRun ? runDetails[activeRun.run_id] : null;
  const displayedTimeline = useMemo(() => {
    const latestStepEventIds = new Set<string>();
    const seenStepKeys = new Set<string>();

    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (item.type !== "step") continue;
      const key = `${item.runId}:${item.stepId}`;
      if (seenStepKeys.has(key)) continue;
      seenStepKeys.add(key);
      latestStepEventIds.add(item.id);
    }

    return timeline.filter((item) => {
      if (item.type === "clarification") {
        return pendingIntent?.decision === "ASK_CLARIFICATION";
      }

      if (item.type === "execution_mode") {
        return pendingIntent?.decision === "ASK_EXECUTION_MODE" && !activeRun;
      }

      if (item.type === "confirmation") {
        return Boolean(
          pendingIntent?.decision === "REQUIRES_CONFIRMATION" && !activeRun,
        );
      }

      if (item.type === "plan") {
        return !activeRun;
      }

      if (item.type === "run") {
        return !activeRun;
      }

      if (item.type === "step") {
        return latestStepEventIds.has(item.id);
      }

      return true;
    });
  }, [activeRun, pendingIntent?.decision, timeline]);

  const activeRunStepEvents = useMemo(() => {
    const entries = new Map<
      string,
      { status: "running" | "completed" | "failed"; body?: string; errorCode?: string }
    >();
    if (!activeRun) return entries;

    for (const item of timeline) {
      if (item.type !== "step" || item.runId !== activeRun.run_id) continue;
      entries.set(item.stepId, {
        status: item.status,
        body: item.body,
        errorCode: item.errorCode,
      });
    }

    return entries;
  }, [activeRun, timeline]);

  const allowedModes = useMemo(
    (): Exclude<ExecutionMode, "unknown">[] =>
      pendingIntent?.decision === "READY_FOR_MULTI_TIME_SCHEDULE"
        ? ["multi_time"]
        : pendingIntent?.decision === "READY_TO_SCHEDULE"
          ? ["once", "interval", "multi_time"]
          : ["immediate", "once", "interval", "multi_time"],
    [pendingIntent],
  );

  useEffect(() => {
    setSelectedExecutionMode((current) =>
      allowedModes.includes(current) ? current : allowedModes[0],
    );
  }, [allowedModes]);

  async function submitTurn() {
    const currentText = text;
    const currentAttachments = attachments;
    setText("");
    setAttachments([]);
    await sendTurn(currentText, currentAttachments);
  }

  function buildSchedule(mode: Exclude<ExecutionMode, "unknown">) {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (mode === "once") {
      return { run_at: onceAt ? [new Date(onceAt).toISOString()] : [], timezone };
    }
    if (mode === "interval") {
      return {
        interval_seconds: Number(intervalSeconds || "3600"),
        run_at: undefined,
        timezone,
      };
    }
    if (mode === "multi_time") {
      return {
        run_at: multiTimes
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => new Date(value).toISOString()),
        timezone,
      };
    }
    return { timezone };
  }

  function onAttachFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const nextAttachments = files.map<ComposerAttachment>((file) => {
      if (file.type.startsWith("image/")) {
        return {
          id: `${file.name}-${file.size}`,
          label: file.name,
          part: {
            type: "image",
            file_id: `${file.name}-${file.size}`,
            caption: file.name,
          },
        };
      }

      if (file.type.startsWith("audio/")) {
        return {
          id: `${file.name}-${file.size}`,
          label: file.name,
          part: {
            type: "audio",
            file_id: `${file.name}-${file.size}`,
            transcript: "",
          },
        };
      }

      return {
        id: `${file.name}-${file.size}`,
        label: file.name,
        part: {
          type: "file",
          file_id: `${file.name}-${file.size}`,
          mime_type: file.type || "application/octet-stream",
          name: file.name,
        },
      };
    });

    setAttachments((current) => [...current, ...nextAttachments]);
    event.target.value = "";
  }

  const executionModeQuestion =
    pendingIntent?.execution_mode_question ||
    (pendingIntent?.decision === "READY_TO_EXECUTE"
      ? "This is ready to run now."
      : "Choose how this should run.");

  const canSubmitExecutionMode =
    selectedExecutionMode === "once"
      ? Boolean(onceAt)
      : selectedExecutionMode === "multi_time"
        ? multiTimes
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean).length > 0
        : selectedExecutionMode === "interval"
          ? Number(intervalSeconds) > 0
          : true;

  function renderExecutionModeCard(
    question: string,
    modes: Exclude<ExecutionMode, "unknown">[] = allowedModes,
  ) {
    return (
      <SurfaceCard
        eyebrow="Run style"
        title="Choose how this should run"
        subtitle={question}
      >
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            {modes.map((mode) => (
              <Button
                key={mode}
                variant={selectedExecutionMode === mode ? "contained" : "outlined"}
                onClick={() => setSelectedExecutionMode(mode)}
              >
                {mode.replace("_", " ")}
              </Button>
            ))}
          </Stack>

          {selectedExecutionMode === "immediate" ? (
            <Typography variant="body2" color="text.secondary">
              The automation will start as soon as you confirm this choice.
            </Typography>
          ) : null}

          {selectedExecutionMode === "once" ? (
            <TextField
              label="Run once at"
              type="datetime-local"
              value={onceAt}
              onChange={(event) => setOnceAt(event.target.value)}
              InputLabelProps={{ shrink: true }}
            />
          ) : null}

          {selectedExecutionMode === "interval" ? (
            <TextField
              label="Interval seconds"
              type="number"
              value={intervalSeconds}
              onChange={(event) => setIntervalSeconds(event.target.value)}
            />
          ) : null}

          {selectedExecutionMode === "multi_time" ? (
            <TextField
              label="Multiple run times"
              multiline
              minRows={3}
              value={multiTimes}
              onChange={(event) => setMultiTimes(event.target.value)}
              placeholder={"One ISO/local datetime per line\n2026-03-07T18:00\n2026-03-08T09:00"}
            />
          ) : null}

          <Box display="flex" justifyContent="flex-start">
            <Button
              variant="contained"
              disabled={!pendingIntent || !canSubmitExecutionMode}
              onClick={() =>
                void chooseExecutionMode(
                  selectedExecutionMode,
                  buildSchedule(selectedExecutionMode),
                )
              }
            >
              {selectedExecutionMode === "immediate" ? "Run now" : "Continue"}
            </Button>
          </Box>
        </Stack>
      </SurfaceCard>
    );
  }

  function renderRunControlCard() {
    if (!activeRun) return null;

    const steps = activeRunDetail?.plan.steps ?? [];
    const stepRows = steps.map((step, index) => {
      const latestEvent = activeRunStepEvents.get(step.step_id);
      let status: StepPresentationStatus = "pending";
      let meta = step.description;

      if (latestEvent?.status === "failed") {
        status = "failed";
        meta = latestEvent.body || step.description;
      } else if (latestEvent?.status === "completed") {
        status = "completed";
      } else if (latestEvent?.status === "running") {
        status =
          activeRun.state === "waiting_for_user_action"
            ? "waiting"
            : activeRun.state === "paused"
              ? "paused"
              : "running";
        meta = latestEvent.body || step.description;
      } else if (activeRun.state === "completed") {
        status = "completed";
      } else if (
        activeRun.current_step_index !== null &&
        index < activeRun.current_step_index
      ) {
        status = "completed";
      } else if (
        activeRun.current_step_index !== null &&
        index === activeRun.current_step_index
      ) {
        status =
          activeRun.state === "failed"
            ? "failed"
            : activeRun.state === "waiting_for_user_action"
              ? "waiting"
              : activeRun.state === "paused"
                ? "paused"
                : activeRun.state === "running" || activeRun.state === "retrying"
                  ? "running"
                  : "pending";
      }

      if (status === "failed" && !meta && activeRun.last_error?.message) {
        meta = activeRun.last_error.message;
      }

      if (status === "waiting" && !meta) {
        meta = "Finish the required manual action, then resume the run.";
      }

      if (status === "paused" && !meta) {
        meta = "This step is paused and will continue when you resume the run.";
      }

      return {
        step_id: step.step_id,
        label: step.label,
        description: step.description,
        meta,
        status,
      };
    });

    return (
      <SurfaceCard
        eyebrow="Run"
        title={runStateLabel(activeRun.state)}
        subtitle="Controls and execution details stay inside the conversation."
        actions={<StatusPill label={activeRun.execution_mode.replace("_", " ")} tone="brand" />}
      >
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            <StatusPill label={runStateLabel(activeRun.state)} tone={toneForRunState(activeRun.state)} />
            {activeRun.current_step_index !== null ? (
              <StatusPill
                label={`Step ${Math.min(activeRun.current_step_index + 1, Math.max(activeRun.total_steps, 1))} of ${activeRun.total_steps}`}
                tone="neutral"
              />
            ) : null}
          </Stack>

          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            {activeRun.state === "awaiting_confirmation" ? (
              <>
                <Button variant="contained" onClick={() => void confirmPendingIntent()} disabled={!pendingIntent}>
                  Confirm
                </Button>
                <Button variant="outlined" color="error" onClick={() => void controlRun(activeRun.run_id, "stop")}>
                  Cancel
                </Button>
              </>
            ) : null}
            {activeRun.state === "queued" || activeRun.state === "running" || activeRun.state === "retrying" ? (
              <>
                <Button variant="outlined" onClick={() => void controlRun(activeRun.run_id, "pause")}>
                  Pause
                </Button>
                <Button variant="outlined" color="error" onClick={() => void controlRun(activeRun.run_id, "stop")}>
                  Stop
                </Button>
              </>
            ) : null}
            {activeRun.state === "paused" || activeRun.state === "waiting_for_user_action" ? (
              <>
                <Button variant="outlined" onClick={() => void controlRun(activeRun.run_id, "resume")}>
                  Resume
                </Button>
                <Button variant="outlined" color="error" onClick={() => void controlRun(activeRun.run_id, "stop")}>
                  Stop
                </Button>
              </>
            ) : null}
            {activeRun.state === "failed" ? (
              <Button variant="contained" onClick={() => void controlRun(activeRun.run_id, "retry")}>
                Retry
              </Button>
            ) : null}
          </Stack>

          {activeRun.state === "waiting_for_user_action" ? (
            <Paper
              variant="outlined"
              sx={{
                p: 1.75,
                borderRadius: "14px",
                backgroundColor: "var(--surface-card-muted)",
              }}
            >
              <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
                Manual step required
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Complete the required action in the target app or page, then press Resume to continue.
              </Typography>
            </Paper>
          ) : null}

          {activeRun.state === "awaiting_confirmation" ? (
            <Paper
              variant="outlined"
              sx={{
                p: 1.75,
                borderRadius: "14px",
                backgroundColor: "var(--surface-card-muted)",
              }}
            >
              <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
                Confirmation needed
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Use the Confirm button here, or type <code>confirm</code> in the chat to start the automation.
              </Typography>
            </Paper>
          ) : null}

          {steps.length > 0 ? (
            <Accordion
              defaultExpanded={activeRun.state === "awaiting_confirmation"}
              disableGutters
              elevation={0}
              sx={{
                borderRadius: "16px",
                border: "1px solid var(--border-subtle)",
                backgroundColor: "var(--surface-card-muted)",
                "&:before": { display: "none" },
              }}
            >
              <AccordionSummary sx={{ px: 2 }}>
                  <Typography variant="body2" fontWeight={700}>
                    Steps
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ px: 1.5, pt: 0 }}>
                  {renderStepRows(stepRows)}
              </AccordionDetails>
            </Accordion>
          ) : null}

          {activeRunDetail?.artifacts.length ? (
            <Stack spacing={1.5}>
              <Typography variant="body2" fontWeight={700}>
                Artifacts
              </Typography>
              {activeRunDetail.artifacts.map((artifact) => (
                <Box
                  key={artifact.artifact_id}
                  component={artifact.type === "screenshot" ? "img" : "a"}
                  href={artifact.type === "screenshot" ? undefined : artifact.url}
                  src={artifact.type === "screenshot" ? artifact.url : undefined}
                  alt={artifact.type === "screenshot" ? "Run artifact" : undefined}
                  target={artifact.type === "screenshot" ? undefined : "_blank"}
                  rel={artifact.type === "screenshot" ? undefined : "noreferrer"}
                  sx={{
                    width: "100%",
                    maxHeight: artifact.type === "screenshot" ? 220 : "none",
                    objectFit: "cover",
                    borderRadius: "16px",
                    border: "1px solid var(--border-subtle)",
                    p: artifact.type === "screenshot" ? 0 : 2,
                  }}
                >
                  {artifact.type !== "screenshot" ? artifact.url : null}
                </Box>
              ))}
            </Stack>
          ) : null}
        </Stack>
      </SurfaceCard>
    );
  }

  return (
    <Stack spacing={3}>
      <Box
        sx={{
          width: "100%",
        }}
      >
        <SurfaceCard>
          <Stack spacing={2.5}>
            <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={2}>
              <Typography variant="h3">Conversation timeline</Typography>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="body2" color="text.secondary">
                  Model
                </Typography>
                <Select
                  size="small"
                  value={selectedModel}
                  onChange={(event) => selectModel(event.target.value)}
                  sx={{
                    minWidth: 182,
                    "& .MuiSelect-select": {
                      py: 0.9,
                    },
                  }}
                >
                  <MenuItem value="gemini-2.0-flash">Gemini 2.0 Flash</MenuItem>
                  <MenuItem value="gemini-1.5-pro">Gemini 1.5 Pro</MenuItem>
                  <MenuItem value="auto">Auto</MenuItem>
                </Select>
              </Stack>
            </Stack>

            <Stack spacing={1.5} sx={{ height: "calc(100vh - 253px)", overflowY: "auto", pr: 0.5 }}>
              {timeline.length === 0 ? (
                <Paper
                  variant="outlined"
                  sx={{
                    p: 2.5,
                    borderRadius: "14px",
                    backgroundColor: "var(--surface-card-muted)",
                  }}
                >
                  <Typography variant="h3" sx={{ fontSize: "1.1rem", mb: 1 }}>
                    Start from a goal
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Ask to run something now, later, every hour, or at multiple times. If the task
                    turns into a scheduled automation, it will also appear under Schedules.
                  </Typography>
                </Paper>
              ) : null}

              {displayedTimeline.map((item) => {
                if (item.type === "user") {
                  return (
                    <Box key={item.id} display="flex" justifyContent="flex-end">
                      <Paper
                        sx={{
                          maxWidth: "80%",
                          px: 2,
                          py: 1.5,
                          borderRadius: "16px",
                          backgroundColor: "#2e342e",
                          color: "var(--text-inverse)",
                        }}
                      >
                        <Typography variant="body2" whiteSpace="pre-wrap">
                          {item.text || "Attached input"}
                        </Typography>
                        {item.attachments.length > 0 ? (
                          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" mt={1}>
                            {item.attachments.map((attachment) => (
                              <StatusPill key={attachment.id} label={attachment.label} tone="neutral" />
                            ))}
                          </Stack>
                        ) : null}
                      </Paper>
                    </Box>
                  );
                }

                if (item.type === "assistant") {
                  return (
                    <Paper
                      key={item.id}
                      sx={{
                        px: 2.25,
                        py: 1.5,
                        borderRadius: "16px",
                        backgroundColor: "var(--surface-card-muted)",
                      }}
                    >
                      <Typography variant="body2">{item.text}</Typography>
                    </Paper>
                  );
                }

                if (item.type === "clarification") {
                  return (
                    <SurfaceCard
                      key={item.id}
                      eyebrow="Clarification"
                      title="One more detail needed"
                      subtitle={item.question}
                    >
                      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                        {item.missingFields.map((field) => (
                          <StatusPill key={field} label={missingFieldLabel(field)} tone="warning" />
                        ))}
                      </Stack>
                    </SurfaceCard>
                  );
                }

                if (item.type === "execution_mode") {
                  return <Box key={item.id}>{renderExecutionModeCard(item.question, item.allowedModes)}</Box>;
                }

                if (item.type === "confirmation") {
                  return (
                    <SurfaceCard
                      key={item.id}
                      eyebrow="Review"
                      title="Confirmation required"
                      subtitle={item.message}
                      actions={
                        <Button variant="contained" onClick={() => void confirmPendingIntent()}>
                          Confirm
                        </Button>
                      }
                    />
                  );
                }

                if (item.type === "plan") {
                  return (
                    <SurfaceCard
                      key={item.id}
                      eyebrow="Plan"
                      title={item.summary}
                      subtitle={`Mode: ${item.executionMode.replace("_", " ")}`}
                    >
                      <Accordion
                        defaultExpanded
                        disableGutters
                        elevation={0}
                        sx={{
                          borderRadius: "16px",
                          border: "1px solid var(--border-subtle)",
                          backgroundColor: "var(--surface-card-muted)",
                          "&:before": { display: "none" },
                        }}
                      >
                        <AccordionSummary sx={{ px: 2 }}>
                          <Typography variant="body2" fontWeight={700}>
                            Steps
                          </Typography>
                        </AccordionSummary>
                        <AccordionDetails sx={{ px: 1.5, pt: 0 }}>
                          {renderStepRows(
                            item.steps.map((step) => ({
                              step_id: step.step_id,
                              label: step.label,
                              description: step.description,
                              status: "pending" as const,
                            })),
                          )}
                        </AccordionDetails>
                      </Accordion>
                    </SurfaceCard>
                  );
                }

                if (item.type === "run") {
                  return (
                    <SurfaceCard
                      key={item.id}
                      eyebrow="Run update"
                      title={item.title}
                      subtitle={item.body}
                      actions={<StatusPill label={runStateLabel(item.state)} tone={toneForRunState(item.state)} />}
                    />
                  );
                }

                if (item.type === "step") {
                  return (
                    <SurfaceCard
                      key={item.id}
                      eyebrow={item.status === "failed" ? "Issue" : "Step"}
                      title={item.label}
                      subtitle={item.body}
                      actions={
                        <StatusPill
                          label={item.status === "failed" && item.errorCode ? errorCopy(item.errorCode) : item.status}
                          tone={
                            item.status === "completed"
                              ? "success"
                              : item.status === "failed"
                                ? "danger"
                                : "brand"
                          }
                        />
                      }
                    >
                      {item.screenshotUrl ? (
                        <Box
                          component="img"
                          src={item.screenshotUrl}
                          alt={item.label}
                          sx={{
                            width: "100%",
                            maxHeight: 260,
                            objectFit: "cover",
                            borderRadius: "16px",
                            border: "1px solid var(--border-subtle)",
                          }}
                        />
                      ) : null}
                    </SurfaceCard>
                  );
                }

                return (
                  <Paper key={item.id} sx={{ p: 2, borderRadius: "18px" }}>
                    <Typography variant="body2">{item.title}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {item.body}
                    </Typography>
                  </Paper>
                );
              })}

              {activeRun ? <Box>{renderRunControlCard()}</Box> : null}

              {isThinking ? (
                  <Paper
                    sx={{
                      px: 2.25,
                      py: 1.5,
                      borderRadius: "16px",
                      backgroundColor: "var(--surface-card-muted)",
                    }}
                  >
                  <Typography variant="body2" color="text.secondary">
                    Analyzing your request and shaping the next best action.
                  </Typography>
                </Paper>
              ) : null}
            </Stack>

            <Divider />

            <Stack spacing={2}>
              <Box
                sx={{
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "18px",
                  backgroundColor: "var(--surface-card)",
                  px: 2,
                  pt: 1.25,
                  pb: 0.9,
                }}
              >
                <TextField
                  multiline
                  minRows={3}
                  maxRows={7}
                  fullWidth
                  variant="standard"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder="Ask Oye to run something now, later, every hour, or at multiple times."
                  InputProps={{ disableUnderline: true }}
                  sx={{
                    "& .MuiInputBase-root": {
                      alignItems: "flex-start",
                    },
                    "& textarea": {
                      color: "var(--text-primary)",
                      lineHeight: 1.55,
                      fontSize: "0.95rem",
                    },
                    "& textarea::placeholder": {
                      color: "var(--input-placeholder)",
                      opacity: 1,
                    },
                  }}
                />

                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    mt: 1.25,
                    pt: 1,
                    borderTop: "1px solid var(--border-subtle)",
                  }}
                >
                  <Tooltip title="Add files">
                    <IconButton
                      component="label"
                      aria-label="Add files"
                      sx={{
                        width: 32,
                        height: 32,
                        borderRadius: "10px",
                        border: "1px solid var(--border-subtle)",
                        color: "text.secondary",
                        "&:hover": {
                          backgroundColor: "var(--surface-card-muted)",
                        },
                      }}
                      >
                        <input hidden multiple type="file" onChange={onAttachFiles} />
                      <Typography component="span" sx={{ fontSize: "1.1rem", lineHeight: 1, fontWeight: 700 }}>
                        +
                      </Typography>
                    </IconButton>
                  </Tooltip>

                  <Tooltip title="Send">
                    <span>
                      <IconButton
                        aria-label="Send"
                        onClick={() => void submitTurn()}
                        disabled={isThinking}
                        sx={{
                          width: 34,
                          height: 34,
                          borderRadius: "11px",
                          backgroundColor: "var(--btn-primary-bg)",
                          color: "var(--btn-primary-fg)",
                          "&:hover": {
                            backgroundColor: "var(--btn-primary-bg-hover)",
                          },
                          "&.Mui-disabled": {
                            backgroundColor: "var(--surface-card-muted)",
                            color: "text.disabled",
                          },
                        }}
                      >
                        <Typography component="span" sx={{ fontSize: "1rem", lineHeight: 1, fontWeight: 700 }}>
                          ↗
                        </Typography>
                      </IconButton>
                    </span>
                  </Tooltip>
                </Box>
              </Box>

              {attachments.length > 0 ? (
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                  {attachments.map((attachment) => (
                    <StatusPill key={attachment.id} label={attachment.label} tone="neutral" />
                  ))}
                </Stack>
              ) : null}
            </Stack>
          </Stack>
        </SurfaceCard>
      </Box>
    </Stack>
  );
}
