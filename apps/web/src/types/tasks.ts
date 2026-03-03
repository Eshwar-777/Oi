export type TaskStatus =
    | "planning"
    | "awaiting_approval"
    | "scheduled"
    | "running"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled";

export interface ITaskStep {
    id: string;
    description: string;
    status: "pending" | "running" | "completed" | "failed";
    error?: string;
}

export interface ITaskPlan {
    type: string;
    steps: ITaskStep[];
    requirements: string[];
}

export interface ITask {
    id: string;
    name: string;
    description: string;
    status: TaskStatus;
    plan?: ITaskPlan;
    nextRunAt?: string;
    lastRunAt?: string;
    blockedReason?: string;
    currentStep?: number;
    totalSteps?: number;
}
