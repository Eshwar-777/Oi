import { TaskStatus } from "../types/tasks";
import { BadgeVariant } from "../components/UI/Badge";

export interface IStatusConfig {
    label: string;
    variant: BadgeVariant;
}

export const TASK_STATUS_CONFIG: Record<TaskStatus, IStatusConfig> = {
    planning: { label: "Planning", variant: "info" },
    awaiting_approval: { label: "Needs Approval", variant: "warning" },
    scheduled: { label: "Scheduled", variant: "success" },
    running: { label: "Running", variant: "success" },
    blocked: { label: "Action Needed", variant: "error" },
    completed: { label: "Completed", variant: "neutral" },
    failed: { label: "Failed", variant: "error" },
    cancelled: { label: "Cancelled", variant: "neutral" },
};
