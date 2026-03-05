export type RunEventType =
  | "planned"
  | "replanned"
  | "step_start"
  | "step_end"
  | "done";

export type RunUiPhase = "idle" | "planning" | "running" | "done";

export type StepStatus = "waiting" | "processing" | "success" | "error";

export interface RunAgentStep {
  type: string;
  action?: string;
  description?: string;
  target?: unknown;
  value?: unknown;
  reason?: string;
}

export interface RunSelectedTarget {
  device_id?: string;
  tab_id?: number;
}

export interface RunEventBase {
  type: RunEventType;
  run_id?: string;
  selected_target?: RunSelectedTarget;
}

export interface RunPlannedEvent extends RunEventBase {
  type: "planned";
  steps?: RunAgentStep[];
  rewritten_prompt?: string;
}

export interface RunReplannedEvent extends RunEventBase {
  type: "replanned";
  steps?: RunAgentStep[];
  round?: number;
}

export interface RunStepStartEvent extends RunEventBase {
  type: "step_start";
  index?: number;
}

export interface RunStepEndEvent extends RunEventBase {
  type: "step_end";
  index?: number;
  status?: string;
  data?: string;
}

export interface RunDoneEvent extends RunEventBase {
  type: "done";
  ok?: boolean;
  message?: string;
  requires_user_action?: boolean;
  resume_token?: string;
  steps_executed?: Array<Record<string, unknown>>;
}

export type RunEvent =
  | RunPlannedEvent
  | RunReplannedEvent
  | RunStepStartEvent
  | RunStepEndEvent
  | RunDoneEvent;

export const RUN_EVENT_JSON_SCHEMA: Record<string, unknown> = {
  $id: "https://oi.app/schemas/run-event.v1.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "RunEvent",
  type: "object",
  required: ["type"],
  properties: {
    type: {
      type: "string",
      enum: ["planned", "replanned", "step_start", "step_end", "done"],
    },
    run_id: { type: "string" },
    selected_target: {
      type: "object",
      properties: {
        device_id: { type: "string" },
        tab_id: { type: "number" },
      },
      additionalProperties: false,
    },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
          action: { type: "string" },
          description: { type: "string" },
          target: {},
          value: {},
          reason: { type: "string" },
        },
        required: ["type"],
        additionalProperties: true,
      },
    },
    index: { type: "number" },
    status: { type: "string" },
    data: { type: "string" },
    ok: { type: "boolean" },
    message: { type: "string" },
    requires_user_action: { type: "boolean" },
    resume_token: { type: "string" },
    steps_executed: {
      type: "array",
      items: { type: "object", additionalProperties: true },
    },
  },
  additionalProperties: true,
};

export function isRunEvent(value: unknown): value is RunEvent {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "planned" ||
    type === "replanned" ||
    type === "step_start" ||
    type === "step_end" ||
    type === "done"
  );
}
