import type {
  AgentBrowserStepPayload,
  Artifact,
  AssistantMessage,
  AutomationPlan,
  AutomationRun,
  AutomationStep,
  AutomationStreamEvent,
  ChatPrimeRequest,
  ChatPrimeResponse,
  ChatTurnRequest,
  ChatTurnResponse,
  ConfirmRequest,
  ConfirmResponse,
  ConversationDecision,
  ExecutionMode,
  IntentDraft,
  ResolveExecutionRequest,
  ResolveExecutionResponse,
  RunControlResponse,
  RunDetailResponse,
  RunState,
} from "@/domain/automation";
import { shouldSimulateManualAction } from "@/features/chat/runPresentation";

const intents = new Map<string, IntentDraft>();
const plans = new Map<string, AutomationPlan>();
const runs = new Map<string, AutomationRun>();
const artifacts = new Map<string, Artifact[]>();

function createId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function isoAfter(minutes: number) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function createAssistantMessage(text: string): AssistantMessage {
  return {
    message_id: createId("msg"),
    role: "assistant",
    text,
  };
}

function inferExecutionMode(goal: string): ExecutionMode {
  const text = goal.toLowerCase();
  if (text.includes("every ") || text.includes("daily") || text.includes("hourly") || text.includes("weekly")) {
    return "interval";
  }
  if (text.includes("tomorrow") || text.includes("tonight") || text.includes("at ") || text.includes("later")) {
    return "once";
  }
  if (text.includes("monday and") || text.includes("every weekday") || text.includes("multiple times")) {
    return "multi_time";
  }
  return "unknown";
}

function decisionFromGoal(goal: string): {
  decision: ConversationDecision;
  clarificationQuestion?: string;
  executionModeQuestion?: string;
  confirmationMessage?: string;
  missingFields: string[];
  requiresConfirmation: boolean;
  riskFlags: string[];
} {
  const text = goal.toLowerCase();
  const risky = ["send", "delete", "purchase", "pay", "email", "message"].some((keyword) =>
    text.includes(keyword),
  );
  const needsTarget = ["this", "it", "that"].some((term) => text === term || text.startsWith(`${term} `));
  const mode = inferExecutionMode(goal);

  if (needsTarget) {
    return {
      decision: "ASK_CLARIFICATION",
      clarificationQuestion: "What should I act on, and which app or destination should I use?",
      missingFields: ["target"],
      requiresConfirmation: false,
      riskFlags: [],
    };
  }

  if (mode === "unknown" && (text.includes("schedule") || text.includes("remind") || text.includes("later"))) {
    return {
      decision: "ASK_EXECUTION_MODE",
      executionModeQuestion: "Should I run this now, once later, on an interval, or at multiple times?",
      missingFields: [],
      requiresConfirmation: false,
      riskFlags: [],
    };
  }

  if (risky) {
    return {
      decision:
        mode === "interval" || mode === "once" || mode === "multi_time"
          ? mode === "multi_time"
            ? "READY_FOR_MULTI_TIME_SCHEDULE"
            : "READY_TO_SCHEDULE"
          : "REQUIRES_CONFIRMATION",
      confirmationMessage: "This could take an external action on your behalf. Review it before I continue.",
      missingFields: [],
      requiresConfirmation: true,
      riskFlags: ["external_action"],
    };
  }

  if (mode === "interval" || mode === "once") {
    return {
      decision: "READY_TO_SCHEDULE",
      missingFields: [],
      requiresConfirmation: false,
      riskFlags: [],
    };
  }

  if (mode === "multi_time") {
    return {
      decision: "READY_FOR_MULTI_TIME_SCHEDULE",
      missingFields: [],
      requiresConfirmation: false,
      riskFlags: [],
    };
  }

  return {
    decision: "READY_TO_EXECUTE",
    missingFields: [],
    requiresConfirmation: false,
    riskFlags: [],
  };
}

function createSteps(goal: string, mode: ExecutionMode): AutomationStep[] {
  const step = (
    kind: NonNullable<AutomationStep["kind"]>,
    label: string,
    description: string,
  ): AutomationStep => {
    const stepId = createId("step");
    const commandPayload: AgentBrowserStepPayload = {
      type: "browser",
      id: stepId,
      command: kind,
      description,
    };

    return {
      step_id: stepId,
      kind,
      command: kind,
      command_payload: commandPayload,
      label,
      description,
      status: "pending",
    };
  };

  return [
    step(
      "switch_target",
      "Prepare the right workspace",
      "Choose the correct application or active surface before taking action.",
    ),
    step(
      "navigate",
      "Open the required destination",
      `Move into the screen needed to handle: ${goal}`,
    ),
    step(
      mode === "interval" || mode === "multi_time" ? "extract" : "click",
      mode === "interval" || mode === "multi_time" ? "Collect the output" : "Finish the action",
      mode === "interval" || mode === "multi_time"
        ? "Package the result so each future run can be reviewed from chat."
        : "Complete the requested interaction and verify the outcome.",
    ),
  ];
}

function createPlan(intent: IntentDraft, mode: ExecutionMode): AutomationPlan {
  const plan: AutomationPlan = {
    plan_id: createId("plan"),
    intent_id: intent.intent_id,
    execution_mode: mode,
    summary:
      mode === "interval" || mode === "multi_time" || mode === "once"
        ? "Review the automation and its next scheduled execution."
        : "Review the automation before it starts running.",
    targets: [{ target_type: "unknown" }],
    steps: createSteps(intent.user_goal, mode),
    requires_confirmation: intent.requires_confirmation,
  };
  plans.set(plan.plan_id, plan);
  return plan;
}

function createRun(plan: AutomationPlan, sessionId: string, state: RunState, scheduledFor?: string[]) {
  const run: AutomationRun = {
    run_id: createId("run"),
    plan_id: plan.plan_id,
    session_id: sessionId,
    state,
    execution_mode: plan.execution_mode,
    current_step_index: state === "scheduled" ? null : 0,
    total_steps: plan.steps.length,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    scheduled_for: scheduledFor,
    last_error: null,
  };
  runs.set(run.run_id, run);
  artifacts.set(run.run_id, []);
  return run;
}

export async function mockChatTurn(request: ChatTurnRequest): Promise<ChatTurnResponse> {
  const goal =
    request.inputs
      .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
      .map((item) => item.text)
      .join(" ")
      .trim() || "Help me with this task";
  const inferred = decisionFromGoal(goal);

  const intent: IntentDraft = {
    intent_id: createId("intent"),
    session_id: request.session_id,
    user_goal: goal,
    goal_type: goal.toLowerCase().includes("chat") ? "general_chat" : "ui_automation",
    normalized_inputs: request.inputs,
    entities: { model: request.client_context.model ?? "auto" },
    missing_fields: inferred.missingFields,
    timing_mode: inferExecutionMode(goal),
    timing_candidates: inferExecutionMode(goal) === "unknown" ? [] : [inferExecutionMode(goal)],
    can_automate: true,
    confidence: 0.84,
    decision: inferred.decision,
    requires_confirmation: inferred.requiresConfirmation,
    risk_flags: inferred.riskFlags,
    clarification_question: inferred.clarificationQuestion,
    execution_mode_question: inferred.executionModeQuestion,
    confirmation_message: inferred.confirmationMessage,
  };
  intents.set(intent.intent_id, intent);

  const assistantText =
    inferred.decision === "ASK_CLARIFICATION"
      ? intent.clarification_question || "I need one more detail before I can move."
      : inferred.decision === "ASK_EXECUTION_MODE"
        ? intent.execution_mode_question || "Tell me how you want this to run."
        : inferred.decision === "REQUIRES_CONFIRMATION"
          ? intent.confirmation_message || "I can do that, but I want your confirmation first."
          : inferred.decision === "READY_TO_SCHEDULE" || inferred.decision === "READY_FOR_MULTI_TIME_SCHEDULE"
            ? "I understand the task and I can prepare it as a scheduled automation from this chat."
            : "I understand the task and can turn it into an actionable run from this chat.";

  const suggestedNextActions =
    inferred.decision === "ASK_CLARIFICATION"
      ? [{ type: "reply_text" as const, label: "Provide details", payload: {} }]
      : inferred.decision === "ASK_EXECUTION_MODE"
        ? [{ type: "select_execution_mode" as const, label: "Choose how to run it", payload: {} }]
        : inferred.decision === "REQUIRES_CONFIRMATION"
          ? [{ type: "confirm" as const, label: "Review and confirm", payload: {} }]
          : inferred.decision === "READY_TO_SCHEDULE" || inferred.decision === "READY_FOR_MULTI_TIME_SCHEDULE"
            ? [{ type: "open_schedule_builder" as const, label: "Set the schedule", payload: {} }]
            : [{ type: "start_run" as const, label: "Start now", payload: {} }];

  return {
    assistant_message: createAssistantMessage(assistantText),
    intent_draft: intent,
    suggested_next_actions: suggestedNextActions,
  };
}

export async function mockChatPrime(request: ChatPrimeRequest): Promise<ChatPrimeResponse> {
  return {
    prepare_token: createId("prepare"),
    expires_at: isoAfter(5),
    session_id: request.session_id,
  };
}

export async function mockResolveExecution(
  request: ResolveExecutionRequest,
): Promise<ResolveExecutionResponse> {
  const intent = intents.get(request.intent_id);
  if (!intent) {
    throw new Error("The requested intent is no longer available.");
  }

  const plan = createPlan(intent, request.execution_mode);
  const scheduledFor =
    request.execution_mode === "immediate"
      ? undefined
      : request.schedule.run_at && request.schedule.run_at.length > 0
        ? request.schedule.run_at
        : request.execution_mode === "interval"
          ? [isoAfter(60), isoAfter(120)]
          : [isoAfter(60)];

  if (intent.requires_confirmation) {
    return {
      assistant_message: createAssistantMessage(
        "I prepared the automation. Review the steps and confirm before I take action.",
      ),
      plan,
      run: null,
      status: "awaiting_confirmation",
    };
  }

  const run = createRun(
    plan,
    request.session_id,
    request.execution_mode === "immediate" ? "running" : "scheduled",
    scheduledFor,
  );

  return {
    assistant_message: createAssistantMessage(
      request.execution_mode === "immediate"
        ? "I started the automation and will keep the timeline updated here."
        : "I scheduled the automation. The upcoming runs are now tracked in your schedules tab.",
    ),
    plan,
    run,
    status: request.execution_mode === "immediate" ? "running" : "scheduled",
  };
}

export async function mockConfirm(request: ConfirmRequest): Promise<ConfirmResponse> {
  const intent = intents.get(request.intent_id);
  if (!intent || !request.confirmed) {
    throw new Error("Confirmation failed.");
  }

  const mode = intent.timing_mode === "unknown" ? "immediate" : intent.timing_mode;
  const plan = createPlan(intent, mode);
  const run = createRun(
    plan,
    request.session_id,
    mode === "immediate" ? "running" : "scheduled",
    mode === "immediate" ? undefined : [isoAfter(45)],
  );

  return {
    assistant_message: createAssistantMessage(
      mode === "immediate"
        ? "Confirmed. I started the run and will report progress here."
        : "Confirmed. I scheduled the automation and added it to your upcoming events.",
    ),
    plan,
    run,
  };
}

export async function mockGetRun(runId: string): Promise<RunDetailResponse> {
  const run = runs.get(runId);
  if (!run) throw new Error("Run not found.");
  const plan = plans.get(run.plan_id);
  if (!plan) throw new Error("Plan not found.");
  return {
    run,
    plan,
    artifacts: artifacts.get(runId) ?? [],
  };
}

export async function mockRunControl(
  runId: string,
  action: "pause" | "resume" | "stop" | "retry" | "approve",
): Promise<RunControlResponse> {
  const run = runs.get(runId);
  if (!run) throw new Error("Run not found.");
  const plan = plans.get(run.plan_id);
  if (!plan) throw new Error("Plan not found.");

  const nextState: Record<typeof action, RunState> = {
    pause: "paused",
    resume: "running",
    stop: "cancelled",
    retry: "retrying",
    approve: "running",
  };

  const updated: AutomationRun = {
    ...run,
    state:
      (action === "resume" && run.state === "waiting_for_user_action") ||
      (action === "approve" && run.state === "waiting_for_human")
        ? "completed"
        : nextState[action],
    updated_at: new Date().toISOString(),
    current_step_index:
      action === "stop"
        ? run.current_step_index
        : (action === "resume" && run.state === "waiting_for_user_action") ||
            (action === "approve" && run.state === "waiting_for_human")
          ? Math.max(run.total_steps - 1, 0)
          : run.current_step_index ?? 0,
  };

  if (
    (action === "resume" && run.state === "waiting_for_user_action") ||
    (action === "approve" && run.state === "waiting_for_human")
  ) {
    const completedPlan: AutomationPlan = {
      ...plan,
      steps: plan.steps.map((step, index) => ({
        ...step,
        status: "completed",
        completed_at: new Date().toISOString(),
        screenshot_url:
          index === plan.steps.length - 1
            ? "https://placehold.co/960x540/png?text=Automation+Snapshot"
            : step.screenshot_url,
      })),
    };
    plans.set(plan.plan_id, completedPlan);
    artifacts.set(run.run_id, [
      {
        artifact_id: createId("artifact"),
        type: "screenshot",
        url: "https://placehold.co/960x540/png?text=Automation+Snapshot",
        created_at: new Date().toISOString(),
        step_id: completedPlan.steps[completedPlan.steps.length - 1]?.step_id,
      },
    ]);
  }

  runs.set(runId, updated);

  return {
    run: updated,
    assistant_message: createAssistantMessage(
      action === "pause"
        ? "I paused the run."
        : action === "resume"
          ? run.state === "waiting_for_user_action"
            ? "You completed the manual step. I verified the result and marked the run complete."
            : "I resumed the run."
          : action === "approve"
            ? "Sensitive action approved. The run is resuming."
          : action === "retry"
            ? "I am retrying the run from the latest safe point."
            : "I stopped the run.",
    ),
  };
}

export function createMockRunEvents(
  run: AutomationRun,
  plan: AutomationPlan,
  sessionId: string,
): AutomationStreamEvent[] {
  if (run.state === "scheduled") {
    return [
      {
        event_id: createId("evt"),
        session_id: sessionId,
        run_id: run.run_id,
        type: "run.created",
        timestamp: new Date().toISOString(),
        payload: { run },
      },
      {
        event_id: createId("evt"),
        session_id: sessionId,
        run_id: run.run_id,
        type: "schedule.created",
        timestamp: new Date().toISOString(),
        payload: { schedule_id: `schedule_${run.run_id}`, run_times: run.scheduled_for ?? [] },
      },
    ];
  }

  const events: AutomationStreamEvent[] = [
    {
      event_id: createId("evt"),
      session_id: sessionId,
      run_id: run.run_id,
      type: "run.created",
      timestamp: new Date().toISOString(),
      payload: { run },
    },
    {
      event_id: createId("evt"),
      session_id: sessionId,
      run_id: run.run_id,
      type: "run.started",
      timestamp: new Date().toISOString(),
      payload: { run_id: run.run_id },
    },
  ];

  const planText = plan.steps
    .map((step) => `${step.label} ${step.description ?? ""}`)
    .join(" ");

  if (shouldSimulateManualAction(planText)) {
    const blockedStep = plan.steps[plan.steps.length - 1];
    if (blockedStep) {
      const blockedPlan: AutomationPlan = {
        ...plan,
        steps: plan.steps.map((step, index) =>
          index < plan.steps.length - 1
            ? { ...step, status: "completed", completed_at: new Date().toISOString() }
            : { ...step, status: "running", started_at: new Date().toISOString() },
        ),
      };
      plans.set(plan.plan_id, blockedPlan);
    }
    runs.set(run.run_id, {
      ...run,
      state: "waiting_for_user_action",
      current_step_index: Math.max(plan.steps.length - 1, 0),
      updated_at: new Date().toISOString(),
    });

    return [
      ...events,
      {
        event_id: createId("evt"),
        session_id: sessionId,
        run_id: run.run_id,
        type: "step.started",
        timestamp: new Date().toISOString(),
        payload: {
          run_id: run.run_id,
          step_id: plan.steps[0]?.step_id ?? createId("step"),
          index: 0,
          label: plan.steps[0]?.label ?? "Prepare the right workspace",
        },
      },
      {
        event_id: createId("evt"),
        session_id: sessionId,
        run_id: run.run_id,
        type: "step.completed",
        timestamp: new Date().toISOString(),
        payload: {
          run_id: run.run_id,
          step_id: plan.steps[0]?.step_id ?? createId("step"),
          index: 0,
          screenshot_url: null,
        },
      },
      {
        event_id: createId("evt"),
        session_id: sessionId,
        run_id: run.run_id,
        type: "step.started",
        timestamp: new Date().toISOString(),
        payload: {
          run_id: run.run_id,
          step_id: plan.steps[1]?.step_id ?? createId("step"),
          index: 1,
          label: plan.steps[1]?.label ?? "Open the required destination",
        },
      },
      {
        event_id: createId("evt"),
        session_id: sessionId,
        run_id: run.run_id,
        type: "step.completed",
        timestamp: new Date().toISOString(),
        payload: {
          run_id: run.run_id,
          step_id: plan.steps[1]?.step_id ?? createId("step"),
          index: 1,
          screenshot_url: null,
        },
      },
      {
        event_id: createId("evt"),
        session_id: sessionId,
        run_id: run.run_id,
        type: "step.started",
        timestamp: new Date().toISOString(),
        payload: {
          run_id: run.run_id,
          step_id: plan.steps[2]?.step_id ?? createId("step"),
          index: 2,
          label: plan.steps[2]?.label ?? "Finish the action",
        },
      },
      {
        event_id: createId("evt"),
        session_id: sessionId,
        run_id: run.run_id,
        type: "run.waiting_for_user_action",
        timestamp: new Date().toISOString(),
        payload: {
          run_id: run.run_id,
          reason: "A confirmation step is still required in the target app. Complete it there, then click Confirm & Resume.",
        },
      },
    ];
  }

  plan.steps.forEach((step, index) => {
    events.push(
      {
        event_id: createId("evt"),
        session_id: sessionId,
        run_id: run.run_id,
        type: "step.started",
        timestamp: new Date().toISOString(),
        payload: { run_id: run.run_id, step_id: step.step_id, index, label: step.label },
      },
      {
        event_id: createId("evt"),
        session_id: sessionId,
        run_id: run.run_id,
        type: "step.completed",
        timestamp: new Date().toISOString(),
        payload: {
          run_id: run.run_id,
          step_id: step.step_id,
          index,
          screenshot_url:
            index === plan.steps.length - 1
              ? "https://placehold.co/960x540/png?text=Automation+Snapshot"
              : null,
        },
      },
    );
  });

  events.push({
    event_id: createId("evt"),
    session_id: sessionId,
    run_id: run.run_id,
    type: "run.completed",
    timestamp: new Date().toISOString(),
    payload: { run_id: run.run_id, message: "The run finished successfully." },
  });

  artifacts.set(run.run_id, [
    {
      artifact_id: createId("artifact"),
      type: "screenshot",
      url: "https://placehold.co/960x540/png?text=Automation+Snapshot",
      created_at: new Date().toISOString(),
      step_id: plan.steps[plan.steps.length - 1]?.step_id,
    },
  ]);

  return events;
}
