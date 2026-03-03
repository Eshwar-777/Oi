export type TaskStatus =
  | "planning"
  | "awaiting_approval"
  | "scheduled"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskStepStatus = "pending" | "running" | "done" | "failed" | "blocked";

export type TaskActionType = "api_call" | "browser_action" | "human_decision";

export type TaskEventType =
  | "created"
  | "planned"
  | "approved"
  | "scheduled"
  | "step_started"
  | "step_completed"
  | "blocked"
  | "human_acted"
  | "completed"
  | "failed"
  | "cancelled";

export interface ITaskStep {
  index: number;
  description: string;
  action_type: TaskActionType;
  target_url: string | null;
  status: TaskStepStatus;
  result: string | null;
}

export interface ITaskState {
  task_id: string;
  user_id: string;
  mesh_group_id: string;
  created_by_device_id: string;

  plan_description: string;
  steps: ITaskStep[];
  scheduled_at: string | null;

  current_step_index: number;
  status: TaskStatus;

  blocked_reason: string | null;
  blocked_screenshot_url: string | null;
  human_action_response: string | null;
  human_action_device_id: string | null;
}

export interface ITaskEvent {
  id: string;
  type: TaskEventType;
  timestamp: string;
  device_id: string | null;
  user_id: string | null;
  payload: Record<string, unknown>;
}

export interface ITaskSummary {
  task_id: string;
  plan_description: string;
  status: TaskStatus;
  current_step_index: number;
  total_steps: number;
  created_at: string;
  updated_at: string;
  blocked_reason: string | null;
}
