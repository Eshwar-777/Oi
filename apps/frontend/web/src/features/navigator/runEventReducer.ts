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
  stepData: string[];
  planRound: number;
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
    stepData: [],
    planRound: 0,
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
      stepStatuses: prev.stepStatuses.map((status) =>
        status === "waiting" || status === "processing" ? "success" : status,
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

  if (event.type === "status") {
    const label =
      event.phase === "rewriting_prompt"
        ? "Rewriting prompt..."
        : event.phase === "capturing_snapshot"
          ? "Capturing page snapshot..."
          : event.phase === "extracting_context"
            ? "Extracting page context..."
            : event.phase === "planning"
              ? "Planning..."
              : event.phase === "planning_cache_hit"
                ? "Using cached plan..."
                : event.phase === "repair_planning"
                  ? "Repair planning..."
                  : "Working...";

    return {
      ...prev,
      phase: prev.phase === "done" ? prev.phase : "planning",
      runId,
      resolvedTarget,
      message: label,
    };
  }

  if (event.type === "planned" || event.type === "replanned") {
    const nextSteps = event.steps ?? [];
    if (prev.steps.length === 0) {
      return {
        ...prev,
        phase: nextSteps.length > 0 ? "running" : prev.phase,
        runId,
        resolvedTarget,
        steps: nextSteps,
        stepStatuses: nextSteps.map(() => "waiting"),
        stepData: nextSteps.map(() => ""),
        planRound:
          event.type === "replanned"
            ? Math.max(prev.planRound, event.round ?? prev.planRound + 1)
            : prev.planRound,
        ok: null,
        message: event.type === "replanned" ? "Plan updated from latest page state." : "",
      };
    }

    const completedCount = prev.stepStatuses.reduce(
      (count, status) => (status === "success" || status === "error" ? count + 1 : count),
      0,
    );

    const preservedSteps = prev.steps.slice(0, completedCount);
    const preservedStatuses = prev.stepStatuses.slice(0, completedCount);
    const preservedData = prev.stepData.slice(0, completedCount);
    const mergedSteps = [...preservedSteps, ...nextSteps];
    const mergedStatuses: StepStatus[] = [
      ...preservedStatuses,
      ...nextSteps.map(() => "waiting" as StepStatus),
    ];
    const mergedData = [...preservedData, ...nextSteps.map(() => "")];

    return {
      ...prev,
      phase: mergedSteps.length > 0 ? "running" : prev.phase,
      runId,
      resolvedTarget,
      steps: mergedSteps,
      stepStatuses: mergedStatuses,
      stepData: mergedData,
      planRound:
        event.type === "replanned"
          ? Math.max(prev.planRound, event.round ?? prev.planRound + 1)
          : prev.planRound,
      ok: null,
      message: event.type === "replanned" ? "Plan updated from latest page state." : "",
    };
  }

  if (event.type === "step_start") {
    const index = event.index ?? 0;
    const nextSteps = [...prev.steps];
    const nextStatuses = [...prev.stepStatuses];
    const nextData = [...prev.stepData];

    while (nextStatuses.length <= index) {
      nextStatuses.push("waiting");
      nextSteps.push({ type: "browser", description: `Step ${nextStatuses.length}` });
      nextData.push("");
    }

    return {
      ...prev,
      phase: "running",
      runId,
      resolvedTarget,
      stepStatuses: nextStatuses.map((status, idx) => {
        if (idx === index) return "processing";
        if (idx < index && status === "waiting") return "success";
        return status;
      }),
      steps: nextSteps,
      stepData: nextData,
    };
  }

  if (event.type === "step_end") {
    const index = event.index ?? 0;
    const status: StepStatus = event.status === "success" ? "success" : "error";
    const nextSteps = [...prev.steps];
    const nextStatuses = [...prev.stepStatuses];
    const nextData = [...prev.stepData];

    while (nextStatuses.length <= index) {
      nextStatuses.push("waiting");
      nextSteps.push({ type: "browser", description: `Step ${nextStatuses.length}` });
      nextData.push("");
    }

    nextStatuses[index] = status;
    nextData[index] = event.data || "";

    return {
      ...prev,
      runId,
      resolvedTarget,
      steps: nextSteps,
      stepStatuses: nextStatuses,
      stepData: nextData,
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
      stepStatuses: prev.stepStatuses.map((status) =>
        status === "processing" ? "error" : status,
      ),
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
