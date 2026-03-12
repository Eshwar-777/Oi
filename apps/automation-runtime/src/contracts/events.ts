export type RuntimeEventType =
  | "run.started"
  | "run.thinking"
  | "run.log"
  | "run.paused"
  | "run.tool.started"
  | "run.tool.finished"
  | "run.browser.snapshot"
  | "run.browser.action"
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "run.runtime_incident"
  | "run.waiting_for_human"
  | "run.failed"
  | "run.completed";

export type RuntimeEvent = {
  seq: number;
  type: RuntimeEventType;
  runId: string;
  payload: Record<string, unknown>;
  createdAt: string;
};
