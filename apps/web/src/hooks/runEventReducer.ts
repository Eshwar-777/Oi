import type {
  RunAgentStep,
  RunDoneEvent,
  RunEvent,
  RunUiPhase,
  StepStatus,
} from "@oi/shared-types";

export interface RunUiState {
  phase: RunUiPhase;
  runId?: string;
  steps: RunAgentStep[];
  stepStatuses: StepStatus[];
  resolvedTarget: { device_id?: string; tab_id?: number } | null;
  resumeToken: string | null;
  message: string;
  ok: boolean | null;
}

type RunUiAction =
  | { type: "RESET" }
  | { type: "START_PLANNING" }
  | { type: "APPLY_EVENT"; event: RunEvent }
  | { type: "MARK_STOPPED" }
  | { type: "RESUME_SUCCESS"; message: string };

export function createInitialRunUiState(): RunUiState {
  return {
    phase: "idle",
    runId: undefined,
    steps: [],
    stepStatuses: [],
    resolvedTarget: null,
    resumeToken: null,
    message: "",
    ok: null,
  };
}

function applyDoneState(prev: RunUiState, event: RunDoneEvent): RunUiState {
  if (event.ok) {
    return {
      ...prev,
      phase: "done",
      ok: true,
      message: event.message || "Done.",
      stepStatuses: prev.stepStatuses.map((s) =>
        s === "waiting" || s === "processing" ? "success" : s,
      ),
      resumeToken: null,
    };
  }
  return {
    ...prev,
    phase: "done",
    ok: false,
    message: event.message || "Agent action failed.",
    resumeToken: event.requires_user_action && event.resume_token ? event.resume_token : null,
  };
}

function applyRunEvent(prev: RunUiState, event: RunEvent): RunUiState {
  const runId = event.run_id || prev.runId;
  const resolvedTarget = event.selected_target || prev.resolvedTarget;

  if (event.type === "planned" || event.type === "replanned") {
    const nextSteps = event.steps ?? prev.steps;
    return {
      ...prev,
      phase: nextSteps.length > 0 ? "running" : prev.phase,
      runId,
      resolvedTarget,
      steps: nextSteps,
      stepStatuses: nextSteps.map(() => "waiting"),
      ok: null,
      message: "",
    };
  }

  if (event.type === "step_start") {
    const idx = event.index ?? 0;
    return {
      ...prev,
      phase: "running",
      runId,
      resolvedTarget,
      stepStatuses: prev.stepStatuses.map((status, i) => {
        if (i === idx) return "processing";
        if (i < idx && status === "waiting") return "success";
        return status;
      }),
    };
  }

  if (event.type === "step_end") {
    const idx = event.index ?? 0;
    const status: StepStatus = event.status === "success" ? "success" : "error";
    return {
      ...prev,
      runId,
      resolvedTarget,
      stepStatuses: prev.stepStatuses.map((s, i) => (i === idx ? status : s)),
    };
  }

  return applyDoneState(
    {
      ...prev,
      runId,
      resolvedTarget,
    },
    event,
  );
}

export function runUiReducer(prev: RunUiState, action: RunUiAction): RunUiState {
  if (action.type === "RESET") {
    return createInitialRunUiState();
  }
  if (action.type === "START_PLANNING") {
    return {
      ...createInitialRunUiState(),
      phase: "planning",
    };
  }
  if (action.type === "APPLY_EVENT") {
    return applyRunEvent(prev, action.event);
  }
  if (action.type === "MARK_STOPPED") {
    return {
      ...prev,
      phase: "done",
      ok: true,
      message: "Stopped.",
      stepStatuses: prev.stepStatuses.map((s) => (s === "processing" ? "error" : s)),
    };
  }
  return {
    ...prev,
    phase: "done",
    ok: true,
    message: action.message || "Resumed actions completed.",
    resumeToken: null,
  };
}
