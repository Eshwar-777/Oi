import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Chip,
  Divider,
  InputAdornment,
  IconButton,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  MaterialSymbol,
  StatusPill,
  SurfaceCard,
  useOITheme,
} from "@oi/design-system-web";
import type { ComposerAttachment, ExecutionMode } from "@/domain/automation";
import { useAssistant } from "@/features/assistant/AssistantContext";
import { errorCopy, missingFieldLabel, runStateLabel } from "@/features/assistant/uiCopy";
import { StepPresentationStatus } from "./ChatTypes";
import { CalendarIcon, toneForRunState, renderStepRows } from "./ChatUtils";
import { getRunActionLabel } from "./runPresentation";

export function ChatPage() {
  const { mode } = useOITheme();
  const {
    activeRun,
    confirmPendingIntent,
    controlRun,
    chooseExecutionMode,
    isThinking,
    modelOptions,
    pendingIntent,
    preparedAttachmentWarning,
    prepareTurn,
    runDetails,
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
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const onceInputRef = useRef<HTMLInputElement | null>(null);
  const textHistoryRef = useRef<string[]>([]);
  const [loaderTick, setLoaderTick] = useState(0);

  const activeRunDetail = activeRun ? runDetails[activeRun.run_id] : null;
  const displayedTimeline = useMemo(() => {
    const latestStepEventIds = new Set<string>();
    const seenStepKeys = new Set<string>();
    const latestSingletonIds = new Set<string>();
    const seenSingletonTypes = new Set<"clarification" | "execution_mode" | "confirmation">();

    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (item.type === "step") {
        const key = `${item.runId}:${item.stepId}`;
        if (seenStepKeys.has(key)) continue;
        seenStepKeys.add(key);
        latestStepEventIds.add(item.id);
        continue;
      }
      if (
        item.type === "clarification" ||
        item.type === "execution_mode" ||
        item.type === "confirmation"
      ) {
        if (seenSingletonTypes.has(item.type)) continue;
        seenSingletonTypes.add(item.type);
        latestSingletonIds.add(item.id);
      }
    }

    return timeline.filter((item) => {
      if (item.type === "clarification") {
        return pendingIntent?.decision === "ASK_CLARIFICATION" && latestSingletonIds.has(item.id);
      }

      if (item.type === "execution_mode") {
        return (
          (pendingIntent?.decision === "ASK_EXECUTION_MODE" ||
            pendingIntent?.decision === "READY_TO_EXECUTE" ||
            pendingIntent?.decision === "READY_TO_SCHEDULE" ||
            pendingIntent?.decision === "READY_FOR_MULTI_TIME_SCHEDULE") &&
          !activeRun &&
          latestSingletonIds.has(item.id)
        );
      }

      if (item.type === "confirmation") {
        return Boolean(
          pendingIntent?.decision === "REQUIRES_CONFIRMATION" &&
            !activeRun &&
            latestSingletonIds.has(item.id),
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
  const runSummary = useMemo(() => {
    if (!activeRun) {
      return { title: null, subtitle: null };
    }

    if (activeRun.state === "waiting_for_user_action") {
      return {
        title: "Manual step required",
        subtitle: "Finish the required action in the target app, then continue the run.",
      };
    }

    if (activeRun.state === "failed") {
      return {
        title: "Something needs attention",
        subtitle: activeRun.last_error?.message || "The run hit an issue and can be retried.",
      };
    }

    return { title: null, subtitle: null };
  }, [activeRun]);

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

  useEffect(() => {
    const node = timelineRef.current;
    if (!node) return;
    const frame = window.requestAnimationFrame(() => {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [displayedTimeline.length, activeRun?.state, pendingIntent?.decision, isThinking]);

  useEffect(() => {
    if (!isThinking) return;
    const timer = window.setInterval(() => {
      setLoaderTick((current) => (current + 1) % 3);
    }, 420);
    return () => window.clearInterval(timer);
  }, [isThinking]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void prepareTurn(text, attachments);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [attachments, prepareTurn, text]);

  function updateDraft(nextValue: string, options?: { trackHistory?: boolean }) {
    if (options?.trackHistory !== false && nextValue !== text) {
      textHistoryRef.current.push(text);
      if (textHistoryRef.current.length > 80) {
        textHistoryRef.current = textHistoryRef.current.slice(-80);
      }
    }
    setText(nextValue);
  }

  async function submitTurn() {
    const currentText = text;
    const currentAttachments = attachments;
    if (!currentText.trim() && currentAttachments.length === 0) return;
    textHistoryRef.current.push(currentText);
    setText("");
    setAttachments([]);
    await sendTurn(currentText, currentAttachments);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      const previous = textHistoryRef.current.pop();
      if (previous !== undefined) {
        setText(previous);
      }
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitTurn();
    }
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

  const executionModeButtonLabel =
    selectedExecutionMode === "immediate"
      ? pendingIntent?.requires_confirmation
        ? "Continue"
        : "Run now"
      : "Continue";

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
        title="Run options"
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
              {pendingIntent?.requires_confirmation
                ? "I will prepare the task for your confirmation."
                : "The automation will start right away."}
            </Typography>
          ) : null}

          {selectedExecutionMode === "once" ? (
            <Stack spacing={0.75}>
              <Typography variant="body2" color="text.secondary">
                Run once at
              </Typography>
              <TextField
                inputRef={onceInputRef}
                type="datetime-local"
                value={onceAt}
                onChange={(event) => setOnceAt(event.target.value)}
                placeholder="Select a date and time"
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <Tooltip title="Open calendar">
                        <IconButton
                          edge="end"
                          onClick={() => onceInputRef.current?.showPicker?.()}
                        >
                  <CalendarIcon />
                        </IconButton>
                      </Tooltip>
                    </InputAdornment>
                  ),
                }}
              />
            </Stack>
          ) : null}

          {selectedExecutionMode === "interval" ? (
            <TextField
              label="Repeat every (seconds)"
              type="number"
              value={intervalSeconds}
              onChange={(event) => setIntervalSeconds(event.target.value)}
            />
          ) : null}

          {selectedExecutionMode === "multi_time" ? (
            <TextField
              label="Run at multiple times"
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
              {executionModeButtonLabel}
            </Button>
          </Box>
        </Stack>
      </SurfaceCard>
    );
  }

  function renderRunControlCard() {
    if (!activeRun) return null;

    const steps = activeRunDetail?.plan.steps ?? [];
    const hasRealStepProgress =
      activeRunStepEvents.size > 0 ||
      activeRun.current_step_index !== null ||
      activeRun.state === "running" ||
      activeRun.state === "paused" ||
      activeRun.state === "waiting_for_user_action" ||
      activeRun.state === "failed" ||
      activeRun.state === "completed" ||
      activeRun.state === "retrying";
    const showSteps = activeRun.state !== "awaiting_confirmation" && hasRealStepProgress && steps.length > 0;
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
        title="Current run"
        subtitle={runStateLabel(activeRun.state)}
        actions={<StatusPill label={activeRun.execution_mode.replace("_", " ")} tone="brand" />}
      >
        <Stack spacing={2}>
          {runSummary.title ? (
            <Paper
              variant="outlined"
              sx={{
                px: 2,
                py: 1.5,
                borderRadius: "16px",
                borderColor: "rgba(184, 134, 11, 0.32)",
                backgroundColor: "rgba(255, 244, 214, 0.7)",
              }}
            >
              <Typography variant="body2" fontWeight={700} mb={0.5}>
                {runSummary.title}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {runSummary.subtitle}
              </Typography>
            </Paper>
          ) : null}

          <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
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
                  {getRunActionLabel(activeRun.state)}
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

          {showSteps ? (
            <Accordion
              defaultExpanded={activeRun.state !== "completed"}
              disableGutters
              elevation={0}
              sx={{
                borderRadius: "16px",
                border: "1px solid var(--border-subtle)",
                backgroundColor: "var(--surface-card-muted)",
                "&:before": { display: "none" },
              }}
            >
              <AccordionSummary expandIcon={<MaterialSymbol name="expand_more" sx={{ fontSize: 18 }} />} sx={{ px: 2 }}>
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
    <Stack spacing={2}>
      <Box
        sx={{
          width: "100%",
        }}
      >
        <SurfaceCard>
          <Stack spacing={2}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
              <Box>
                <Typography variant="h5" sx={{ fontSize: "1rem", fontWeight: 700 }}>
                  Chat
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Compact view of the active conversation and run state.
                </Typography>
              </Box>
              {activeRun ? (
                <StatusPill label={runStateLabel(activeRun.state)} tone={toneForRunState(activeRun.state)} />
              ) : null}
            </Stack>

            <Stack ref={timelineRef} spacing={1.1} sx={{ height: "calc(100vh - 230px)", overflowY: "auto", pr: 0.5 }}>
              {timeline.length === 0 ? (
                <Paper
                  variant="outlined"
                  sx={{
                    p: 2,
                    borderRadius: "14px",
                    backgroundColor: "var(--surface-card-muted)",
                  }}
                >
                  <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
                    Start with a goal
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Ask to run now, schedule later, or repeat on a cadence.
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
                          px: 1.5,
                          py: 1.1,
                          borderRadius: "14px",
                          backgroundColor:
                            mode === "dark" ? "rgba(126, 170, 255, 0.18)" : "rgba(39, 112, 255, 0.1)",
                          border: "1px solid rgba(90, 140, 255, 0.18)",
                          color: "var(--text-primary)",
                        }}
                      >
                        <Typography variant="body2" whiteSpace="pre-wrap" sx={{ lineHeight: 1.5 }}>
                          {item.text || "Attached input"}
                        </Typography>
                        {item.attachments.length > 0 ? (
                          <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" mt={1}>
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
                        px: 1.5,
                        py: 1.2,
                        borderRadius: "14px",
                        backgroundColor: "var(--surface-card-muted)",
                      }}
                    >
                      <Stack direction="row" spacing={1} alignItems="flex-start">
                        <MaterialSymbol name="model" sx={{ fontSize: 18, color: "var(--text-secondary)", mt: 0.15 }} />
                        <Typography variant="body2" sx={{ lineHeight: 1.55 }}>
                          {item.text}
                        </Typography>
                      </Stack>
                    </Paper>
                  );
                }

                if (item.type === "clarification") {
                  return (
                    <Paper
                      key={item.id}
                      variant="outlined"
                      sx={{ p: 1.5, borderRadius: "14px", backgroundColor: "var(--surface-card-muted)" }}
                    >
                      <Stack spacing={1}>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <MaterialSymbol name="warning" sx={{ fontSize: 18, color: "#b26a00" }} />
                          <Typography variant="body2" fontWeight={700}>
                            One more detail
                          </Typography>
                        </Stack>
                        <Typography variant="caption" color="text.secondary">
                          {item.question}
                        </Typography>
                        <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                        {item.missingFields.map((field) => (
                          <StatusPill key={field} label={missingFieldLabel(field)} tone="warning" />
                        ))}
                        </Stack>
                      </Stack>
                    </Paper>
                  );
                }

                if (item.type === "execution_mode") {
                  return <Box key={item.id}>{renderExecutionModeCard(item.question, item.allowedModes)}</Box>;
                }

                if (item.type === "confirmation") {
                  return (
                    <Paper
                      key={item.id}
                      variant="outlined"
                      sx={{ p: 1.5, borderRadius: "14px", backgroundColor: "var(--surface-card-muted)" }}
                    >
                      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
                        <Box>
                          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                            <MaterialSymbol name="warning" sx={{ fontSize: 18, color: "#b26a00" }} />
                            <Typography variant="body2" fontWeight={700}>
                              Confirmation required
                            </Typography>
                          </Stack>
                          <Typography variant="caption" color="text.secondary">
                            {item.message}
                          </Typography>
                        </Box>
                        <Button variant="contained" size="small" onClick={() => void confirmPendingIntent()}>
                          Confirm
                        </Button>
                      </Stack>
                    </Paper>
                  );
                }

                if (item.type === "plan") {
                  return (
                    <Paper
                      key={item.id}
                      variant="outlined"
                      sx={{ p: 1.25, borderRadius: "14px", backgroundColor: "var(--surface-card-muted)" }}
                    >
                      <Stack spacing={1}>
                        <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
                          <Box>
                            <Typography variant="body2" fontWeight={700}>
                              Plan ready
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {item.summary}
                            </Typography>
                          </Box>
                          <Chip size="small" label={item.executionMode.replace("_", " ")} />
                        </Stack>
                      <Accordion
                        defaultExpanded={false}
                        disableGutters
                        elevation={0}
                        sx={{
                          borderRadius: "16px",
                          border: "1px solid var(--border-subtle)",
                          backgroundColor: "var(--surface-card-muted)",
                          "&:before": { display: "none" },
                        }}
                      >
                        <AccordionSummary expandIcon={<MaterialSymbol name="expand_more" sx={{ fontSize: 18 }} />} sx={{ px: 1.5, minHeight: 38 }}>
                          <Typography variant="body2" fontWeight={700}>
                            Steps ({item.steps.length})
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
                      </Stack>
                    </Paper>
                  );
                }

                if (item.type === "run") {
                  return (
                    <Paper
                      key={item.id}
                      variant="outlined"
                      sx={{ p: 1.35, borderRadius: "14px", backgroundColor: "var(--surface-card-muted)" }}
                    >
                      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
                        <Box>
                          <Typography variant="body2" fontWeight={700}>
                            {item.title}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {item.body}
                          </Typography>
                        </Box>
                        <StatusPill label={runStateLabel(item.state)} tone={toneForRunState(item.state)} />
                      </Stack>
                    </Paper>
                  );
                }

                if (item.type === "step") {
                  return (
                    <Paper
                      key={item.id}
                      variant="outlined"
                      sx={{ p: 1.35, borderRadius: "14px", backgroundColor: "var(--surface-card-muted)" }}
                    >
                      <Stack spacing={1}>
                        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
                          <Box>
                            <Typography variant="body2" fontWeight={700}>
                              {item.label}
                            </Typography>
                            {item.body ? (
                              <Typography variant="caption" color="text.secondary">
                                {item.body}
                              </Typography>
                            ) : null}
                          </Box>
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
                        </Stack>
                        {item.screenshotUrl ? (
                          <Accordion
                            disableGutters
                            elevation={0}
                            sx={{
                              borderRadius: "12px",
                              border: "1px solid var(--border-subtle)",
                              backgroundColor: "transparent",
                              "&:before": { display: "none" },
                            }}
                          >
                            <AccordionSummary expandIcon={<MaterialSymbol name="expand_more" sx={{ fontSize: 18 }} />} sx={{ px: 1.25, minHeight: 34 }}>
                              <Typography variant="caption" fontWeight={700}>
                                Preview
                              </Typography>
                            </AccordionSummary>
                            <AccordionDetails sx={{ px: 1.25, pt: 0 }}>
                              <Box
                                component="img"
                                src={item.screenshotUrl}
                                alt={item.label}
                                sx={{
                                  width: "100%",
                                  maxHeight: 240,
                                  objectFit: "cover",
                                  borderRadius: "14px",
                                  border: "1px solid var(--border-subtle)",
                                }}
                              />
                            </AccordionDetails>
                          </Accordion>
                        ) : null}
                      </Stack>
                    </Paper>
                  );
                }

                return (
                  <Paper key={item.id} sx={{ p: 1.35, borderRadius: "14px" }}>
                    <Typography variant="body2" fontWeight={700}>
                      {item.title}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {item.body}
                    </Typography>
                  </Paper>
                );
              })}

              {activeRun ? <Box>{renderRunControlCard()}</Box> : null}

              {isThinking ? (
                  <Paper
                    sx={{
                      px: 1.5,
                      py: 1.2,
                      borderRadius: "14px",
                      backgroundColor: "var(--surface-card-muted)",
                    }}
                  >
                  <Stack direction="row" spacing={1} alignItems="center">
                    <MaterialSymbol
                      name="refresh"
                      sx={{
                        fontSize: 18,
                        color: "var(--text-secondary)",
                        animation: "spin 1s linear infinite",
                        "@keyframes spin": {
                          "0%": { transform: "rotate(0deg)" },
                          "100%": { transform: "rotate(360deg)" },
                        },
                      }}
                    />
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{
                        animation: "pulse 1.2s ease-in-out infinite",
                        "@keyframes pulse": {
                          "0%, 100%": { opacity: 0.45 },
                          "50%": { opacity: 1 },
                        },
                      }}
                    >
                      {`Analyzing your request${".".repeat(loaderTick + 1)}`}
                    </Typography>
                  </Stack>
                </Paper>
              ) : null}
            </Stack>

            <Divider />

            <Stack spacing={2}>
              <Box
                sx={{
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "16px",
                  backgroundColor: "var(--surface-card)",
                  px: 1.5,
                  pt: 1,
                  pb: 0.75,
                }}
              >
                <TextField
                  multiline
                  minRows={2}
                  maxRows={6}
                  fullWidth
                  variant="standard"
                  value={text}
                  onChange={(event) => updateDraft(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
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
                {preparedAttachmentWarning ? (
                  <Typography variant="caption" color="warning.main" sx={{ display: "block", mt: 0.5 }}>
                    {preparedAttachmentWarning}
                  </Typography>
                ) : null}

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
                      <MaterialSymbol name="add" sx={{ fontSize: 18 }} />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Model">
                    <Select
                      size="small"
                      value={selectedModel}
                      onChange={(event) => selectModel(event.target.value)}
                      variant="outlined"
                      sx={{
                        ml: 1,
                        minWidth: 130,
                        height: 32,
                        borderRadius: "10px",
                        backgroundColor: "var(--surface-card-muted)",
                        "& .MuiOutlinedInput-notchedOutline": {
                          borderColor: "var(--border-subtle)",
                        },
                        "& .MuiSelect-select": {
                          py: 0.55,
                          display: "flex",
                          alignItems: "center",
                          gap: 0.75,
                        },
                      }}
                      startAdornment={<MaterialSymbol name="model" sx={{ fontSize: 16, ml: 1, color: "var(--text-secondary)" }} />}
                    >
                      {modelOptions.length === 0 ? <MenuItem value="auto">Auto</MenuItem> : null}
                      {modelOptions.map((model) => (
                        <MenuItem key={model.id} value={model.id}>
                          {model.label}
                        </MenuItem>
                      ))}
                      {modelOptions.length > 0 ? <MenuItem value="auto">Auto</MenuItem> : null}
                    </Select>
                  </Tooltip>
                  <Box sx={{ flex: 1 }} />

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
                        <MaterialSymbol name="send" sx={{ fontSize: 18 }} />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Box>
              </Box>

              {attachments.length > 0 ? (
                <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
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
