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
  Link,
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
import type {
  AutomationRun,
  BrowserSessionRecord,
  ComposerAttachment,
  ExecutionMode,
  ExecutorMode,
} from "@/domain/automation";
import { useAssistant } from "@/features/assistant/AssistantContext";
import { errorCopy, missingFieldLabel, runStateLabel } from "@/features/assistant/uiCopy";
import { StepPresentationStatus } from "./ChatTypes";
import { CalendarIcon, renderStepRows, stepStatusColor, stepStatusLabel, toneForRunState } from "./ChatUtils";
import { getRunActionLabel } from "./runPresentation";
import { LiveSessionTakeoverDialog } from "./LiveSessionTakeoverDialog";

const modelOptions = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.0-flash-live-001", label: "Gemini 2.0 Flash Live 001" },
];

function runStateIconName(state: string) {
  if (state === "completed" || state === "succeeded") return "check_circle";
  if (state === "failed" || state === "cancelled" || state === "canceled" || state === "timed_out") return "error";
  if (state === "paused") return "pause";
  if (state === "waiting_for_user_action" || state === "waiting_for_human" || state === "human_controlling") return "warning";
  if (state === "running" || state === "queued" || state === "retrying" || state === "starting" || state === "resuming") return "refresh";
  return "pending";
}

function runStateIconColor(state: string) {
  const tone = toneForRunState(state);
  if (tone === "success") return "#2e7d32";
  if (tone === "danger") return "#b3261e";
  if (tone === "warning") return "#b26a00";
  if (tone === "brand") return "#0b57d0";
  return "var(--text-secondary)";
}

function executionModeIconName(mode: string) {
  return mode === "immediate" ? "send" : "schedule";
}

function runIsTerminal(state: string | undefined | null) {
  return Boolean(
    state &&
      [
        "completed",
        "succeeded",
        "failed",
        "cancelled",
        "canceled",
        "timed_out",
        "expired",
      ].includes(state),
  );
}

function runtimeIncidentGuidance(run: AutomationRun) {
  const incident = run.runtime_incident;
  if (!incident) return null;

  const defaultAction =
    run.state === "waiting_for_human"
      ? "Take over from the live session viewer or approve once the page is safe."
      : run.state === "reconciling"
        ? "Let the agent replan from the current browser state, or take over if the page still looks wrong."
        : "Review the live session before continuing.";

  switch (incident.code) {
    case "RUNTIME_FILE_UPLOAD_REQUIRED":
      return {
        title: "File input changed the workflow",
        body: "The workflow hit a browser file picker or upload field. The agent is treating this as a replannable browser state change instead of pausing for manual review.",
        action: defaultAction,
      };
    case "RUNTIME_DOWNLOAD_PROMPT":
      return {
        title: "Download prompt interrupted the run",
        body: "The browser hit a download permission gate or save prompt. The agent can continue after the current state is reconciled.",
        action: defaultAction,
      };
    case "RUNTIME_VERIFICATION_WIDGET":
      return {
        title: "Verification widget blocked the run",
        body: "An embedded verification challenge or security widget needs human review. The agent should not try to bypass it.",
        action: "Take over, complete the challenge if appropriate, then release control and resume.",
      };
    case "RUNTIME_UNSUPPORTED_WIDGET":
      return {
        title: "Unsupported widget boundary",
        body: "The target UI is inside a closed or custom component boundary that the current automation engine cannot safely automate directly.",
        action: defaultAction,
      };
    case "RUNTIME_REPEATED_STEP_FAILURE":
      return {
        title: "The same step kept failing",
        body: "The run repeated the same failing action without making progress. The agent is switching into reconciliation instead of retrying blindly.",
        action: defaultAction,
      };
    case "RUNTIME_NO_PROGRESS":
      return {
        title: "No visible progress detected",
        body: "The browser stayed on the same visual state across multiple steps. The agent is treating this as a replannable blocker instead of continuing to thrash.",
        action: defaultAction,
      };
    default:
      return {
        title: "Runtime incident",
        body: incident.summary,
        action: defaultAction,
      };
  }
}

function runtimeIncidentActions(run: AutomationRun) {
  const incident = run.runtime_incident;
  if (!incident) return { showOpenViewer: false, showApprove: false, showResume: false };

  const showOpenViewer =
    Boolean(run.browser_session_id) &&
    (run.state === "waiting_for_human" ||
      incident.code === "RUNTIME_VERIFICATION_WIDGET");

  const showApprove =
    run.state === "waiting_for_human" &&
    incident.code !== "RUNTIME_FILE_UPLOAD_REQUIRED" &&
    incident.code !== "RUNTIME_VERIFICATION_WIDGET";

  const showResume =
    (run.state === "waiting_for_human" || run.state === "reconciling") &&
    incident.code !== "RUNTIME_VERIFICATION_WIDGET";

  return { showOpenViewer, showApprove, showResume };
}

export function ChatPage() {
  const { mode } = useOITheme();
  const isDarkMode = mode === "dark";
  const {
    activeRun,
    browserSessions,
    confirmPendingIntent,
    controlRun,
    chooseExecutionMode,
    isThinking,
    //modelOptions,
    pendingIntent,
    preparedAttachmentWarning,
    prepareTurn,
    queuedTurns,
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
  const [selectedExecutorMode, setSelectedExecutorMode] = useState<ExecutorMode>("server_runner");
  const [selectedBrowserSessionId, setSelectedBrowserSessionId] = useState<string>("");
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const onceInputRef = useRef<HTMLInputElement | null>(null);
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
  const [showActivityDetails, setShowActivityDetails] = useState(false);
  const [showTakeoverDialog, setShowTakeoverDialog] = useState(false);

  const activeRunDetail = activeRun ? runDetails[activeRun.run_id] : null;
  const activeRunIncidentGuidance = activeRun ? runtimeIncidentGuidance(activeRun) : null;
  const activeRunIncidentActions = activeRun ? runtimeIncidentActions(activeRun) : null;
  const activeRunBlocksPromptFlow = Boolean(activeRun && !runIsTerminal(activeRun.state));
  const activeRunBrowserSession = useMemo(() => {
    if (!activeRun?.browser_session_id) return null;
    return browserSessions.find((session) => session.session_id === activeRun.browser_session_id) ?? null;
  }, [activeRun?.browser_session_id, browserSessions]);
  const displayedTimeline = useMemo(() => {
    const latestStepEventIds = new Set<string>();
    const seenStepKeys = new Set<string>();
    const latestSingletonIds = new Set<string>();
    const seenSingletonTypes = new Set<"clarification" | "execution_mode">();

    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (item.type === "step") {
        const key = `${item.runId}:${item.stepId}`;
        if (seenStepKeys.has(key)) continue;
        seenStepKeys.add(key);
        latestStepEventIds.add(item.id);
        continue;
      }
      if (item.type === "clarification" || item.type === "execution_mode") {
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
            pendingIntent?.decision === "REQUIRES_CONFIRMATION" ||
            pendingIntent?.decision === "READY_TO_SCHEDULE" ||
            pendingIntent?.decision === "READY_FOR_MULTI_TIME_SCHEDULE") &&
          !activeRunBlocksPromptFlow &&
          latestSingletonIds.has(item.id)
        );
      }

      // if (item.type === "confirmation") {
      //   return pendingIntent?.decision === "REQUIRES_CONFIRMATION" && latestSingletonIds.has(item.id);
      // }

      if (item.type === "step") {
        if (activeRunBlocksPromptFlow) return false;
        return latestStepEventIds.has(item.id);
      }

      if (item.type === "plan") {
        return !activeRunBlocksPromptFlow;
      }

      if (item.type === "run") {
        return !activeRunBlocksPromptFlow;
      }

      return true;
    });
  }, [activeRunBlocksPromptFlow, pendingIntent?.decision, timeline]);

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
  const liveActivityItems = useMemo(() => {
    if (!activeRun) return [];
    const recent = timeline
      .filter((item) => (item.type === "step" || item.type === "run") && item.runId === activeRun.run_id)
      .map((item) => {
        if (item.type === "step") {
          const tone: "neutral" | "success" | "danger" =
            item.status === "failed" ? "danger" : item.status === "completed" ? "success" : "neutral";
          const prefix =
            item.status === "failed"
              ? "Failed"
              : item.status === "completed"
                ? "Done"
                : "Working";
          return {
            id: item.id,
            tone,
            text: `${prefix}: ${item.label}${item.body ? ` - ${item.body}` : ""}`,
          };
        }
        if (item.type !== "run") return null;
        const tone: "neutral" | "success" | "danger" =
          item.state === "failed"
            ? "danger"
            : item.state === "completed" || item.state === "succeeded"
              ? "success"
              : "neutral";
        return {
          id: item.id,
          tone,
          text: item.body ? `${item.title} - ${item.body}` : item.title,
        };
      })
      .filter((item): item is { id: string; tone: "neutral" | "success" | "danger"; text: string } => item !== null);

    const deduped: Array<{ id: string; tone: "neutral" | "success" | "danger"; text: string }> = [];
    for (const item of recent) {
      if (deduped.length > 0 && deduped[deduped.length - 1]?.text === item.text) {
        deduped[deduped.length - 1] = item;
        continue;
      }
      deduped.push(item);
    }
    return deduped.slice(-8);
  }, [activeRun, timeline]);
  const activeRunAnchorItemId = useMemo(() => {
    if (!activeRun) return null;
    const firstRunEventIndex = timeline.findIndex(
      (item) =>
        (item.type === "step" || item.type === "run") &&
        item.runId === activeRun.run_id,
    );
    if (firstRunEventIndex === -1) return null;

    for (let index = firstRunEventIndex - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (item.type === "step" || item.type === "run" || item.type === "plan") {
        continue;
      }
      return item.id;
    }
    return null;
  }, [activeRun, timeline]);
  const activeRunTimelineAnchorIndex = useMemo(() => {
    if (!activeRun) return -1;
    let firstIndex = -1;
    displayedTimeline.forEach((item, index) => {
      if (activeRunAnchorItemId ? item.id === activeRunAnchorItemId : false) {
        if (firstIndex === -1) {
          firstIndex = index;
        }
      }
    });
    return firstIndex;
  }, [activeRun, activeRunAnchorItemId, displayedTimeline]);
  const runSummary = useMemo(() => {
    if (!activeRun) {
      return { title: null, subtitle: null };
    }

    if (activeRun.state === "waiting_for_user_action" || activeRun.state === "waiting_for_human") {
      return {
        title: activeRun.state === "waiting_for_human" ? "Sensitive action approval required" : "Manual step required",
        subtitle:
          activeRun.state === "waiting_for_human"
            ? activeRun.last_error?.message || "Review the blocked action, then approve or take over before continuing."
            : "Finish the required action in the target app, then continue the run.",
      };
    }

    return { title: null, subtitle: null };
  }, [activeRun]);
  const showQueuedTurns = queuedTurns.length > 0;

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
    const node = liveActivityRef.current;
    if (!node) return;
    const frame = window.requestAnimationFrame(() => {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [liveActivityItems, showActivityDetails]);

  useEffect(() => {
    if (!activeRun) {
      setShowActivityDetails(false);
      setShowTakeoverDialog(false);
      return;
    }
    const isWorking =
      activeRun.state === "queued" ||
      activeRun.state === "starting" ||
      activeRun.state === "running" ||
      activeRun.state === "retrying" ||
      activeRun.state === "resuming" ||
      activeRun.state === "reconciling";
    setShowActivityDetails(isWorking);
  }, [activeRun?.run_id, activeRun?.state]);

  useEffect(() => {
    if (!activeRunBrowserSession && showTakeoverDialog) {
      setShowTakeoverDialog(false);
    }
  }, [activeRunBrowserSession, showTakeoverDialog]);

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
  const showLaunchSurface = timeline.length === 0 && !activeRun;

  function applySuggestedAction(prompt: string) {
    updateDraft(prompt);
  }

  const sessionOptions = useMemo(() => {
    return browserSessions.filter((session) => session.origin === selectedExecutorMode);
  }, [browserSessions, selectedExecutorMode]);

  useEffect(() => {
    setSelectedBrowserSessionId((current) => {
      if (current && sessionOptions.some((session) => session.session_id === current)) {
        return current;
      }
      return sessionOptions[0]?.session_id ?? "";
    });
  }, [sessionOptions]);

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

          <Stack spacing={0.75}>
            <Typography variant="body2" color="text.secondary">
              Runtime
            </Typography>
            <Select
              value={selectedExecutorMode}
              onChange={(event) => setSelectedExecutorMode(event.target.value as ExecutorMode)}
              size="small"
            >
              <MenuItem value="server_runner">Server runner</MenuItem>
              <MenuItem value="local_runner">Local runner</MenuItem>
            </Select>
          </Stack>

          <Stack spacing={0.5}>
            <Typography variant="body2" color="text.secondary">
              Automation engine
            </Typography>
            <StatusPill label="agent browser" tone="brand" />
          </Stack>

          <Stack spacing={0.75}>
            <Typography variant="body2" color="text.secondary">
              Browser session
            </Typography>
            <Select
              value={selectedBrowserSessionId}
              onChange={(event) => setSelectedBrowserSessionId(event.target.value)}
              size="small"
              displayEmpty
            >
              {sessionOptions.length === 0 ? (
                <MenuItem value="">
                  No {selectedExecutorMode === "server_runner" ? "server" : "local"} sessions available
                </MenuItem>
              ) : (
                sessionOptions.map((session: BrowserSessionRecord) => (
                  <MenuItem key={session.session_id} value={session.session_id}>
                    {(session.runner_label || session.session_id).slice(0, 48)} · {session.status}
                  </MenuItem>
                ))
              )}
            </Select>
          </Stack>

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
                  {
                    executor_mode: selectedExecutorMode,
                    automation_engine: "agent_browser",
                    browser_session_id: selectedBrowserSessionId || null,
                  },
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
    const planSummary = activeRunDetail?.plan.summary ?? "";
    const hasRealStepProgress =
      activeRunStepEvents.size > 0 ||
      activeRun.current_step_index !== null ||
      activeRun.state === "running" ||
      activeRun.state === "paused" ||
      activeRun.state === "waiting_for_user_action" ||
      activeRun.state === "waiting_for_human" ||
      activeRun.state === "failed" ||
      activeRun.state === "completed" ||
      activeRun.state === "retrying";
    const showSteps = activeRun.state !== "awaiting_confirmation" && hasRealStepProgress && steps.length > 0;
    const hasInteractivePlanAction = steps.some((step) => {
      const command = String(step.command_payload?.command ?? step.command ?? "").trim().toLowerCase();
      return ["click", "type", "select", "upload", "press", "hover", "extract", "navigate", "open"].includes(command);
    });
    const summaryLooksInteractive = /\b(click|open|play|search|type|fill|select|send|message|submit|book|order)\b/i.test(planSummary);
    const runEndedEarly =
      activeRun.state === "completed" &&
      (
        (activeRun.total_steps > 0 &&
          (activeRun.current_step_index === null || activeRun.current_step_index < activeRun.total_steps - 1)) ||
        (summaryLooksInteractive && !hasInteractivePlanAction)
      );
    const displayedRunState = runEndedEarly ? "failed" : activeRun.state;
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
            : activeRun.state === "waiting_for_human"
              ? "waiting"
            : activeRun.state === "paused"
              ? "paused"
              : "running";
        meta = latestEvent.body || step.description;
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
              : activeRun.state === "waiting_for_human"
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

      if (status === "pending" && runEndedEarly) {
        meta = activeRun.last_error?.message || "This run ended before reaching this step.";
      }

      if (status === "waiting" && !meta) {
        meta = "Finish the required manual action, then resume the run.";
      }

      if (status === "paused" && !meta) {
        meta = "This step is paused and will continue when you resume the run.";
      }

      if (status === "pending" && activeRun.current_step_index !== null && index > activeRun.current_step_index) {
        const recentReplan = [...timeline]
          .reverse()
          .find(
            (item) =>
              item.type === "run" &&
              item.runId === activeRun.run_id &&
              item.title === "Run adapted to the page",
          );
        if (recentReplan?.type === "run" && !meta) {
          meta = recentReplan.body;
        }
      }

      if (
        activeRun.state === "failed" &&
        activeRun.last_error?.message &&
        index === (activeRun.current_step_index ?? index) &&
        status !== "failed"
      ) {
        status = "failed";
        meta = activeRun.last_error.message;
      }

      return {
        step_id: step.step_id,
        label: step.label,
        command_payload: step.command_payload,
        description: step.description,
        meta,
        status,
      };
    });
    const visibleStepRows = (() => {
      const filtered = stepRows.filter((step) => {
        const command = String(step.command_payload?.command ?? "").trim().toLowerCase();
        return !["snapshot", "extract_structured", "wait", "read_dom", "screenshot"].includes(command);
      });
      return filtered.length > 0 ? filtered : stepRows;
    })();
    const hasMeaningfulCompletedStep = visibleStepRows.some(
      (step) => step.status === "completed" || step.status === "failed",
    );
    const showMainSteps = showSteps && hasMeaningfulCompletedStep;
    const primaryStep =
      [...visibleStepRows].reverse().find((step) => step.status === "running" || step.status === "waiting") ||
      [...visibleStepRows].reverse().find((step) => step.status === "failed" || step.status === "completed") ||
      visibleStepRows[0] ||
      null;
    const isWaitingOnRun =
      activeRun.state === "queued" ||
      activeRun.state === "starting" ||
      activeRun.state === "running" ||
      activeRun.state === "retrying" ||
      activeRun.state === "resuming" ||
      activeRun.state === "reconciling";
    const shouldShowActivityDetails = isWaitingOnRun || showActivityDetails;
    const latestActivityText =
      liveActivityItems[liveActivityItems.length - 1]?.text || "Working through the current page";
    const canOfferManualTakeover = Boolean(
      activeRun.browser_session_id &&
        (activeRun.state === "waiting_for_user_action" ||
          activeRun.state === "waiting_for_human" ||
          activeRun.state === "reconciling" ||
          activeRun.state === "failed" ||
          Boolean(activeRun.runtime_incident)),
    );
    const manualActionTitle =
      activeRun.state === "waiting_for_human"
        ? "Review and approve the blocked step"
        : activeRun.state === "waiting_for_user_action"
          ? "Finish the required change, then continue"
          : activeRun.state === "failed"
            ? "Correct the page and retry from the live state"
            : "Review the live page and continue";
    const manualActionBody =
      activeRun.state === "waiting_for_human"
        ? "Open the live browser, verify the page is safe, then approve and resume from the same page."
        : activeRun.state === "waiting_for_user_action"
          ? "Take control, make the required change yourself, then resume so the agent can continue from the latest snapshot."
          : activeRun.state === "failed"
            ? "The run stopped, but you can still fix the page or switch context yourself and then retry from the current browser state."
            : "Inspect the live browser, make any necessary changes, and then resume the run.";
    const currentManualUrl =
      activeRun.runtime_incident?.browser_snapshot?.url ||
      activeRunBrowserSession?.pages?.[0]?.url ||
      null;

    return (
      <SurfaceCard
        title={(
          <Stack direction="row" spacing={1.25} alignItems="baseline" useFlexGap flexWrap="wrap">
            <Typography variant="h4" sx={{ fontSize: "1rem", fontWeight: 700 }}>
              Current run
            </Typography>
            {activeRun.executor_mode ? (
              <Typography variant="body2" color="text.secondary">
                {activeRun.executor_mode === "local_runner" ? "Running locally" : "Running on server"}
              </Typography>
            ) : null}
          </Stack>
        )}
        subtitle={undefined}
        actions={(
          <Stack direction="row" spacing={1} alignItems="center">
            <Tooltip title={runEndedEarly ? "Ended early" : runStateLabel(activeRun.state)}>
              <Box
                sx={{
                  width: 34,
                  height: 34,
                  borderRadius: "999px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: "var(--surface-card-muted)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <MaterialSymbol
                  name={runStateIconName(displayedRunState)}
                  sx={{
                    fontSize: 18,
                    color: runStateIconColor(displayedRunState),
                    animation:
                      displayedRunState === "running" ||
                      displayedRunState === "queued" ||
                      displayedRunState === "retrying" ||
                      displayedRunState === "starting" ||
                      displayedRunState === "resuming"
                        ? "spin 1s linear infinite"
                        : undefined,
                    "@keyframes spin": {
                      "0%": { transform: "rotate(0deg)" },
                      "100%": { transform: "rotate(360deg)" },
                    },
                  }}
                />
              </Box>
            </Tooltip>
            <Tooltip title={activeRun.execution_mode.replace("_", " ")}>
              <Box
                sx={{
                  width: 34,
                  height: 34,
                  borderRadius: "999px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: "var(--surface-card-muted)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <MaterialSymbol
                  name={executionModeIconName(activeRun.execution_mode)}
                  sx={{ fontSize: 18, color: "var(--text-secondary)" }}
                />
              </Box>
            </Tooltip>
          </Stack>
        )}
      >
        <Stack spacing={2}>
          {activeRun.state === "failed" || runEndedEarly ? (
            <Paper
              variant="outlined"
              sx={{
                p: 1.75,
                borderRadius: "14px",
                borderColor: isDarkMode ? "rgba(255, 122, 122, 0.34)" : "rgba(179, 38, 30, 0.28)",
                backgroundColor: isDarkMode ? "rgba(76, 18, 22, 0.62)" : "rgba(254, 242, 242, 0.92)",
              }}
            >
              <Typography
                variant="body2"
                fontWeight={700}
                sx={{ mb: 0.5, color: isDarkMode ? "#ffd7d7" : undefined }}
              >
                {activeRun.state === "failed" ? "Run failed" : "Run ended before completing all steps"}
              </Typography>
              <Typography variant="body2" sx={{ color: isDarkMode ? "rgba(255, 231, 231, 0.88)" : "text.secondary" }}>
                {activeRun.last_error?.message ||
                  (runEndedEarly
                    ? "The backend marked this run as completed even though some steps were never executed."
                    : "The run stopped unexpectedly.")}
              </Typography>
            </Paper>
          ) : null}

          {runSummary.title ? (
            <Paper
              variant="outlined"
              sx={{
                px: 2,
                py: 1.5,
                borderRadius: "16px",
                borderColor: isDarkMode ? "rgba(255, 202, 122, 0.3)" : "rgba(184, 134, 11, 0.32)",
                backgroundColor: isDarkMode ? "rgba(84, 60, 11, 0.46)" : "rgba(255, 244, 214, 0.7)",
              }}
            >
              <Typography
                variant="body2"
                fontWeight={700}
                mb={0.5}
                sx={{ color: isDarkMode ? "#ffe7b3" : undefined }}
              >
                {runSummary.title}
              </Typography>
              <Typography variant="body2" sx={{ color: isDarkMode ? "rgba(255, 238, 204, 0.82)" : "text.secondary" }}>
                {runSummary.subtitle}
              </Typography>
            </Paper>
          ) : null}

          {canOfferManualTakeover ? (
            <Paper
              variant="outlined"
              sx={{
                p: 1.75,
                borderRadius: "16px",
                backgroundColor: "var(--surface-card-muted)",
                borderColor: "var(--border-subtle)",
              }}
            >
              <Stack spacing={1.1}>
                <Typography variant="body2" fontWeight={700}>
                  {manualActionTitle}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {manualActionBody}
                </Typography>
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                  <Button
                    variant="contained"
                    onClick={() => setShowTakeoverDialog(true)}
                    disabled={!activeRunBrowserSession}
                  >
                    Take control here
                  </Button>
                  {currentManualUrl ? (
                    <Button
                      component={Link}
                      href={currentManualUrl}
                      target="_blank"
                      rel="noreferrer"
                      variant="outlined"
                      underline="none"
                    >
                      Open current page
                    </Button>
                  ) : null}
                  {activeRun.browser_session_id ? (
                    <Button
                      href={`/sessions?session_id=${encodeURIComponent(activeRun.browser_session_id)}&run_id=${encodeURIComponent(activeRun.run_id)}`}
                      variant="text"
                    >
                      Open full viewer
                    </Button>
                  ) : null}
                  {activeRun.state === "waiting_for_human" ? (
                    <Button variant="text" onClick={() => void controlRun(activeRun.run_id, "approve")}>
                      Approve once
                    </Button>
                  ) : null}
                </Stack>
              </Stack>
            </Paper>
          ) : null}

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
            {activeRun.state === "paused" || activeRun.state === "waiting_for_user_action" || activeRun.state === "waiting_for_human" ? (
              <>
                {activeRun.state === "waiting_for_human" ? (
                  <Button variant="contained" onClick={() => void controlRun(activeRun.run_id, "approve")}>
                    Approve & Resume
                  </Button>
                ) : (
                  <Button variant="outlined" onClick={() => void controlRun(activeRun.run_id, "resume")}>
                    {getRunActionLabel(activeRun.state)}
                  </Button>
                )}
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

          {activeRun.state === "waiting_for_user_action" || activeRun.state === "waiting_for_human" ? (
            <Paper
              variant="outlined"
              sx={{
                p: 1.75,
                borderRadius: "14px",
                backgroundColor: "var(--surface-card-muted)",
              }}
            >
              <Typography variant="body2" fontWeight={700} sx={{ mb: 0.5 }}>
                {activeRun.state === "waiting_for_human" ? "Sensitive action approval required" : "Manual step required"}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {activeRun.state === "waiting_for_human"
                  ? "Review the current page. Approve to let the agent continue, or take over from the live session viewer."
                  : "Complete the required action in the target app or page, then press Resume to continue."}
              </Typography>
            </Paper>
          ) : null}

          {activeRun.runtime_incident ? (
            <Paper
              elevation={0}
              sx={{
                p: 2,
                borderRadius: "16px",
                border: "1px solid var(--border-subtle)",
                backgroundColor: "var(--surface-card-muted)",
              }}
            >
              <Stack spacing={1}>
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
                  <Typography variant="body2" fontWeight={700}>
                    {activeRunIncidentGuidance?.title ?? "Runtime incident"}
                  </Typography>
                  <StatusPill label={activeRun.runtime_incident.code.replaceAll("_", " ")} tone="warning" />
                  <StatusPill label={activeRun.runtime_incident.category.replaceAll("_", " ")} tone="neutral" />
                </Stack>
                <Typography variant="body2">
                  {activeRunIncidentGuidance?.body ?? activeRun.runtime_incident.summary}
                </Typography>
                {activeRun.runtime_incident.details ? (
                  <Typography variant="body2" color="text.secondary">
                    {activeRun.runtime_incident.details}
                  </Typography>
                ) : null}
                {activeRunIncidentGuidance?.action ? (
                  <Typography variant="body2" color="text.secondary">
                    {activeRunIncidentGuidance.action}
                  </Typography>
                ) : null}
                {activeRunIncidentActions ? (
                  <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
                    {activeRunIncidentActions.showOpenViewer ? (
                      <Button
                        href={
                          activeRun.browser_session_id
                            ? `/sessions?session_id=${encodeURIComponent(activeRun.browser_session_id)}&run_id=${encodeURIComponent(activeRun.run_id)}`
                            : "/sessions"
                        }
                        variant="outlined"
                      >
                        Open live session
                      </Button>
                    ) : null}
                    {activeRunIncidentActions.showApprove ? (
                      <Button variant="contained" onClick={() => void controlRun(activeRun.run_id, "approve")}>
                        Approve once
                      </Button>
                    ) : null}
                    {activeRunIncidentActions.showResume ? (
                      <Button variant="text" onClick={() => void controlRun(activeRun.run_id, "resume")}>
                        Resume after review
                      </Button>
                    ) : null}
                  </Stack>
                ) : null}
                {activeRun.runtime_incident.browser_snapshot?.url ? (
                  <Typography variant="caption" color="text.secondary">
                    {activeRun.runtime_incident.browser_snapshot.title ?? "Untitled"} · {activeRun.runtime_incident.browser_snapshot.url}
                  </Typography>
                ) : null}
              </Stack>
            </Paper>
          ) : null}

          {(isWaitingOnRun || liveActivityItems.length > 0 || showMainSteps) ? (
            <Paper
              variant="outlined"
              sx={{
                px: 1.5,
                py: 1.25,
                borderRadius: "16px",
                backgroundColor: "var(--surface-card-muted)",
                borderColor: "var(--border-subtle)",
                position: "relative",
                overflow: "hidden",
                "&::after": {
                  content: '""',
                  position: "absolute",
                  inset: "auto 0 0 0",
                  height: 24,
                  background:
                    isDarkMode
                      ? "linear-gradient(180deg, rgba(12,12,14,0) 0%, rgba(12,12,14,0.96) 100%)"
                      : "linear-gradient(180deg, rgba(248,246,241,0) 0%, rgba(248,246,241,0.92) 100%)",
                  pointerEvents: "none",
                },
              }}
            >
              <Stack spacing={0.9}>
                {primaryStep ? (
                  <Stack spacing={0.7}>
                    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
                      <Box>
                        <Typography variant="body2" fontWeight={700}>
                          {primaryStep.label}
                        </Typography>
                        {primaryStep.meta ? (
                          <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.4 }}>
                            {primaryStep.meta}
                          </Typography>
                        ) : null}
                      </Box>
                      <Tooltip title={stepStatusLabel(primaryStep.status)}>
                        <Box
                          sx={{
                            width: 34,
                            height: 34,
                            borderRadius: "999px",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: "var(--surface-card-muted)",
                            border: "1px solid var(--border-subtle)",
                            flexShrink: 0,
                          }}
                        >
                          <MaterialSymbol
                            name={
                              primaryStep.status === "completed"
                                ? "check_circle"
                                : primaryStep.status === "running"
                                  ? "refresh"
                                  : primaryStep.status === "failed"
                                    ? "error"
                                    : primaryStep.status === "paused"
                                      ? "pause"
                                      : primaryStep.status === "waiting"
                                        ? "warning"
                                        : "pending"
                            }
                            sx={{
                              fontSize: 18,
                              color: stepStatusColor(primaryStep.status),
                              animation: primaryStep.status === "running" ? "spin 1s linear infinite" : undefined,
                              "@keyframes spin": {
                                "0%": { transform: "rotate(0deg)" },
                                "100%": { transform: "rotate(360deg)" },
                              },
                            }}
                          />
                        </Box>
                      </Tooltip>
                    </Stack>
                  </Stack>
                ) : null}
                {isWaitingOnRun ? (
                  <Stack direction="row" spacing={0.85} alignItems="center" sx={{ pt: primaryStep ? 0.15 : 0 }}>
                    <MaterialSymbol
                      name="refresh"
                      sx={{
                        fontSize: 14,
                        color: "var(--text-secondary)",
                        animation: "spin 1s linear infinite",
                        "@keyframes spin": {
                          "0%": { transform: "rotate(0deg)" },
                          "100%": { transform: "rotate(360deg)" },
                        },
                      }}
                    />
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ letterSpacing: "0.01em", lineHeight: 1.35 }}
                    >
                      {latestActivityText.replace(/^(Working|Done|Failed):\s*/i, "")}
                    </Typography>
                  </Stack>
                ) : null}
                {!isWaitingOnRun && liveActivityItems.length > 0 ? (
                  <Box display="flex" justifyContent="flex-end">
                    <Tooltip title={shouldShowActivityDetails ? "Hide activity" : "Show activity"}>
                      <IconButton
                        size="small"
                        onClick={() => setShowActivityDetails((current) => !current)}
                        sx={{ width: 30, height: 30 }}
                      >
                        <MaterialSymbol
                          name="expand_more"
                          sx={{
                            fontSize: 18,
                            color: "var(--text-secondary)",
                            transform: shouldShowActivityDetails ? "rotate(180deg)" : "rotate(0deg)",
                            transition: "transform 180ms ease",
                          }}
                        />
                      </IconButton>
                    </Tooltip>
                  </Box>
                ) : null}
                {shouldShowActivityDetails ? (
                  <Stack
                    ref={liveActivityRef}
                    spacing={0.6}
                    sx={{
                      maxHeight: 120,
                      overflowY: "auto",
                      pr: 0.35,
                      pb: 1.4,
                      maskImage: "linear-gradient(180deg, black 0%, black 78%, transparent 100%)",
                    }}
                  >
                    {liveActivityItems.map((item) => (
                      <Typography
                        key={item.id}
                        variant="caption"
                        sx={{
                          color:
                            item.tone === "danger"
                              ? "#b3261e"
                              : item.tone === "success"
                                ? "#2e7d32"
                                : "var(--text-secondary)",
                          lineHeight: 1.35,
                          letterSpacing: "0.01em",
                          opacity: item.id === liveActivityItems[liveActivityItems.length - 1]?.id ? 0.98 : 0.78,
                          transition: "opacity 180ms ease",
                        }}
                      >
                        {item.text.replace(/^(Working|Done|Failed):\s*/i, "")}
                      </Typography>
                    ))}
                  </Stack>
                ) : null}
              </Stack>
            </Paper>
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
                    boxShadow: artifact.step_id?.startsWith("incident:") ? "0 0 0 2px rgba(217, 119, 6, 0.18)" : undefined,
                  }}
                >
                  {artifact.type !== "screenshot" ? artifact.url : null}
                </Box>
              ))}
            </Stack>
          ) : null}
        </Stack>
        <LiveSessionTakeoverDialog
          open={showTakeoverDialog}
          session={activeRunBrowserSession}
          runState={activeRun.state}
          runId={activeRun.run_id}
          onClose={() => setShowTakeoverDialog(false)}
          onResume={async () => {
            if (activeRun.state === "failed") {
              await controlRun(activeRun.run_id, "retry");
              return;
            }
            if (activeRun.state === "waiting_for_human") {
              await controlRun(activeRun.run_id, "approve");
              return;
            }
            await controlRun(activeRun.run_id, "resume");
          }}
        />
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
          <Stack spacing={2.5}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" gap={2}>
              <Box>
                <Typography variant="h5" sx={{ fontSize: "1.05rem", fontWeight: 800 }}>
                  Chat
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Launch automations, draft flows, and move from idea to scheduled execution.
                </Typography>
              </Box>
            </Stack>

            <Stack
              ref={timelineRef}
              spacing={1.1}
              sx={{
                minHeight: showLaunchSurface ? 0 : "calc(100vh - 230px)",
                maxHeight: showLaunchSurface ? "none" : "calc(100vh - 230px)",
                overflowY: showLaunchSurface ? "visible" : "auto",
                pr: showLaunchSurface ? 0 : 0.5,
              }}
            >
              {showLaunchSurface ? (
                <Box
                  sx={{
                    position: "relative",
                    overflow: "hidden",
                    borderRadius: "24px",
                    border: "1px solid var(--border-subtle)",
                    background:
                      mode === "dark"
                        ? "linear-gradient(145deg, rgba(18, 28, 38, 0.94) 0%, rgba(12, 18, 24, 0.9) 100%)"
                        : "linear-gradient(145deg, rgba(248, 250, 244, 0.98) 0%, rgba(242, 247, 238, 0.92) 48%, rgba(250, 246, 236, 0.92) 100%)",
                    p: { xs: 2.25, md: 3 },
                  }}
                >
                  <Box
                    sx={{
                      position: "absolute",
                      inset: "auto auto -56px -48px",
                      width: 180,
                      height: 180,
                      borderRadius: "50%",
                      background:
                        mode === "dark"
                          ? "radial-gradient(circle, rgba(92, 151, 255, 0.2) 0%, rgba(92, 151, 255, 0) 70%)"
                          : "radial-gradient(circle, rgba(132, 181, 108, 0.2) 0%, rgba(132, 181, 108, 0) 72%)",
                      pointerEvents: "none",
                    }}
                  />
                  <Box
                    sx={{
                      position: "absolute",
                      inset: "-42px -32px auto auto",
                      width: 220,
                      height: 220,
                      borderRadius: "50%",
                      background:
                        mode === "dark"
                          ? "radial-gradient(circle, rgba(255, 203, 112, 0.14) 0%, rgba(255, 203, 112, 0) 72%)"
                          : "radial-gradient(circle, rgba(255, 198, 113, 0.16) 0%, rgba(255, 198, 113, 0) 74%)",
                      pointerEvents: "none",
                    }}
                  />
                  <Stack spacing={3} sx={{ position: "relative" }}>
                    <Stack spacing={1.25} maxWidth={760}>
                      <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                        <StatusPill label="Project command center" tone="brand" />
                        <StatusPill label="Run now or schedule" tone="neutral" />
                      </Stack>
                      <Typography variant="h2" sx={{ maxWidth: 720 }}>
                        Put the next workflow in motion.
                      </Typography>
                      <Typography variant="body1" color="text.secondary" sx={{ maxWidth: 720 }}>
                        Use Oye to create schedules, define navigation flows, coordinate device setup,
                        and prepare repeatable execution paths without starting from a blank screen.
                      </Typography>
                    </Stack>

                    <Box
                      sx={{
                        display: "grid",
                        gridTemplateColumns: { xs: "1fr", xl: "1.3fr 0.7fr" },
                        gap: 2,
                        alignItems: "start",
                      }}
                    >
                      <Box
                        sx={{
                          display: "grid",
                          gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" },
                          gap: 1.5,
                        }}
                      >
                        {suggestedActions.map((action) => (
                          <Paper
                            key={action.title}
                            variant="outlined"
                            sx={{
                              p: 2,
                              borderRadius: "18px",
                              backgroundColor:
                                mode === "dark" ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.72)",
                            }}
                          >
                            <Stack spacing={1.25}>
                              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
                                <Stack direction="row" spacing={1} alignItems="center">
                                  <Box
                                    sx={{
                                      width: 38,
                                      height: 38,
                                      display: "grid",
                                      placeItems: "center",
                                      borderRadius: "12px",
                                      backgroundColor:
                                        mode === "dark"
                                          ? "rgba(92, 151, 255, 0.14)"
                                          : "rgba(106, 146, 84, 0.12)",
                                      color: "var(--text-primary)",
                                    }}
                                  >
                                    <MaterialSymbol name={action.icon} sx={{ fontSize: 20 }} />
                                  </Box>
                                  <Typography variant="body2" fontWeight={800}>
                                    {action.title}
                                  </Typography>
                                </Stack>
                                <StatusPill label="Suggested" tone={action.tone} />
                              </Stack>

                              <Typography variant="body2" color="text.secondary">
                                {action.description}
                              </Typography>

                              <Button
                                variant="outlined"
                                onClick={() => applySuggestedAction(action.prompt)}
                                sx={{ alignSelf: "flex-start" }}
                              >
                                Use prompt
                              </Button>
                            </Stack>
                          </Paper>
                        ))}
                      </Box>

                      <Paper
                        variant="outlined"
                        sx={{
                          p: 2.25,
                          borderRadius: "20px",
                          backgroundColor:
                            mode === "dark" ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.64)",
                        }}
                      >
                        <Stack spacing={1.75}>
                          <Typography variant="body2" fontWeight={800}>
                            What this workspace is good at
                          </Typography>
                          <Stack spacing={1.1}>
                            <Box>
                              <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: "0.02em" }}>
                                Scheduling
                              </Typography>
                              <Typography variant="body2" color="text.secondary">
                                Queue one-off runs, intervals, or multi-time schedules directly from chat.
                              </Typography>
                            </Box>
                            <Box>
                              <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: "0.02em" }}>
                                UI planning
                              </Typography>
                              <Typography variant="body2" color="text.secondary">
                                Draft navigation flows, decision points, and user journeys before implementation.
                              </Typography>
                            </Box>
                            <Box>
                              <Typography variant="caption" sx={{ fontWeight: 700, letterSpacing: "0.02em" }}>
                                Device orchestration
                              </Typography>
                              <Typography variant="body2" color="text.secondary">
                                Coordinate device setup, mesh health, and cross-surface automation tasks.
                              </Typography>
                            </Box>
                          </Stack>
                        </Stack>
                      </Paper>
                    </Box>
                  </Stack>
                </Box>
              ) : null}

              {displayedTimeline.flatMap((item, index) => {
                const nodes = [];

                if (item.type === "user") {
                  nodes.push(
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
                    </Box>,
                  );
                } else if (item.type === "assistant") {
                  nodes.push(
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
                    </Paper>,
                  );
                } else if (item.type === "clarification") {
                  nodes.push(
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
                    </Paper>,
                  );
                } else if (item.type === "execution_mode") {
                  nodes.push(<Box key={item.id}>{renderExecutionModeCard(item.question, item.allowedModes)}</Box>);
                } else if (item.type === "plan") {
                  nodes.push(
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
                    </Paper>,
                  );
                } else if (item.type === "run") {
                  nodes.push(
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
                    </Paper>,
                  );
                } else if (item.type === "step") {
                  nodes.push(
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
                    </Paper>,
                  );
                } else if (item.type === "status") {
                  nodes.push(
                    <Paper key={item.id} sx={{ p: 1.35, borderRadius: "14px" }}>
                      <Typography variant="body2" fontWeight={700}>
                        {item.title}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {item.body}
                      </Typography>
                    </Paper>,
                  );
                }

                if (activeRun && index === activeRunTimelineAnchorIndex) {
                  nodes.push(<Box key={`active-run-${activeRun.run_id}`}>{renderRunControlCard()}</Box>);
                }

                return nodes;
              })}

              {activeRun && activeRunTimelineAnchorIndex === -1 ? <Box>{renderRunControlCard()}</Box> : null}

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

            <Divider sx={{ pt: showLaunchSurface ? 0.5 : 0 }} />

            <Stack spacing={2}>
              {showQueuedTurns ? (
                <Paper
                  variant="outlined"
                  sx={{
                    p: 1.5,
                    borderRadius: "16px",
                    backgroundColor: "var(--surface-card-muted)",
                    borderColor: "var(--border-subtle)",
                  }}
                >
                  <Stack spacing={1}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <MaterialSymbol name="schedule" sx={{ fontSize: 18, color: "var(--text-secondary)" }} />
                      <Typography variant="body2" fontWeight={700}>
                        Queued follow-ups
                      </Typography>
                    </Stack>
                    {queuedTurns.map((item, index) => (
                      <Paper
                        key={item.id}
                        variant="outlined"
                        sx={{
                          px: 1.25,
                          py: 1,
                          borderRadius: "12px",
                          backgroundColor: "var(--surface-card)",
                          borderColor: "var(--border-subtle)",
                        }}
                      >
                        <Stack spacing={0.75}>
                          <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
                            <Typography variant="caption" fontWeight={700} color="text.secondary">
                              {index === 0 ? "Next in queue" : `Queue ${index + 1}`}
                            </Typography>
                            <StatusPill label="Queued" tone="neutral" />
                          </Stack>
                          <Typography variant="body2" whiteSpace="pre-wrap">
                            {item.text || "Attached input"}
                          </Typography>
                          {item.attachments.length > 0 ? (
                            <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
                              {item.attachments.map((attachment) => (
                                <StatusPill key={attachment.id} label={attachment.label} tone="neutral" />
                              ))}
                            </Stack>
                          ) : null}
                        </Stack>
                      </Paper>
                    ))}
                  </Stack>
                </Paper>
              ) : null}

              <Box
                sx={{
                  border: "1px solid var(--border-subtle)",
                  borderRadius: "22px",
                  background:
                    mode === "dark"
                      ? "linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.02) 100%)"
                      : "linear-gradient(180deg, rgba(255,255,255,0.88) 0%, rgba(250, 248, 242, 0.92) 100%)",
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
                  <Stack direction="row" spacing={1} alignItems="center">
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
                        <input hidden multiple type="file" onChange={onAttachFiles} />
                      <MaterialSymbol name="add" sx={{ fontSize: 18 }} />
                    </IconButton>
                  </Tooltip>
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
                  <Box sx={{ flex: 1 }} />
                    </Tooltip>
                    {showLaunchSurface ? (
                      <StatusPill label="Try a project prompt above" tone="neutral" />
                    ) : null}
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
