import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Checkbox,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
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
import { errorCopy, runStateLabel } from "@/features/assistant/uiCopy";

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

function isStepChecked(status?: string) {
  return status === "completed" || status === "running";
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

  function renderExecutionModeCard(question: string) {
    return (
      <SurfaceCard
        eyebrow="Run style"
        title="Choose how this should run"
        subtitle={question}
      >
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
            {allowedModes.map((mode) => (
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
            {activeRun.state === "running" ? (
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

          {steps.length > 0 ? (
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
                <List disablePadding>
                  {steps.map((step) => (
                    <ListItem key={step.step_id} disableGutters alignItems="flex-start">
                      <Checkbox
                        edge="start"
                        disableRipple
                        checked={isStepChecked(step.status)}
                        indeterminate={step.status === "running"}
                        disabled
                        sx={{ pt: 0.25 }}
                      />
                      <ListItemText
                        primary={step.label}
                        secondary={step.description}
                        primaryTypographyProps={{ variant: "body2", fontWeight: 700 }}
                        secondaryTypographyProps={{ variant: "body2", color: "text.secondary" }}
                      />
                    </ListItem>
                  ))}
                </List>
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
      <SectionHeader
        eyebrow="Conversation"
        title="Automation chat"
        description="Everything starts from chat: intent understanding, run mode selection, confirmation, execution progress, and scheduled event creation."
      />

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", xl: "minmax(0, 1.6fr) minmax(320px, 0.9fr)" },
          gap: 3,
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

            <Stack spacing={1.5} sx={{ minHeight: "58vh", maxHeight: "62vh", overflowY: "auto", pr: 0.5 }}>
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

              {timeline.map((item) => {
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
                          <StatusPill key={field} label={field} tone="warning" />
                        ))}
                      </Stack>
                    </SurfaceCard>
                  );
                }

                if (item.type === "execution_mode") {
                  return <Box key={item.id}>{renderExecutionModeCard(item.question)}</Box>;
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
                          <List disablePadding>
                            {item.steps.map((step) => (
                              <ListItem key={step.step_id} disableGutters alignItems="flex-start">
                                <Checkbox
                                  edge="start"
                                  disableRipple
                                  checked={isStepChecked(step.status)}
                                  indeterminate={step.status === "running"}
                                  disabled
                                  sx={{ pt: 0.25 }}
                                />
                                <ListItemText
                                  primary={step.label}
                                  secondary={step.description}
                                  primaryTypographyProps={{ variant: "body2", fontWeight: 700 }}
                                  secondaryTypographyProps={{ variant: "body2", color: "text.secondary" }}
                                />
                              </ListItem>
                            ))}
                          </List>
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

              {pendingIntent &&
              pendingIntent.decision !== "ASK_CLARIFICATION" &&
              pendingIntent.decision !== "ASK_EXECUTION_MODE" &&
              pendingIntent.decision !== "REQUIRES_CONFIRMATION" ? (
                <Box>{renderExecutionModeCard(executionModeQuestion)}</Box>
              ) : null}

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

        <Stack spacing={3}>
          <SurfaceCard
            eyebrow="Schedules"
            title="Upcoming events"
            subtitle="Scheduled work requested in chat is summarized here immediately, and the full card lands in the schedules tab."
          >
            {schedules.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No scheduled event yet.
              </Typography>
            ) : (
              <Stack spacing={1.5}>
                {schedules.slice(0, 2).map((schedule) => (
                  <Paper
                    key={schedule.schedule_id}
                    variant="outlined"
                    sx={{
                      p: 2,
                      borderRadius: "14px",
                      backgroundColor: "var(--surface-card-muted)",
                    }}
                  >
                    <Typography variant="body2" fontWeight={700}>
                      {schedule.user_goal}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" mt={0.5}>
                      {schedule.run_times.length > 0
                        ? schedule.run_times
                            .map((time) => new Date(time).toLocaleString())
                            .join(" • ")
                        : "Pending exact time details from chat"}
                    </Typography>
                  </Paper>
                ))}
              </Stack>
            )}
          </SurfaceCard>
        </Stack>
      </Box>
    </Stack>
  );
}
