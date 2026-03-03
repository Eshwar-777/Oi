import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../lib/apiClient";
import type { ITask, TaskStatus } from "../types/tasks";

// Type assertion since the backend ITaskSummary differs slightly from our UI ITask interfaces.
// In a real application, you'd have a parser/mapper function here.
export function useTasks() {
    return useQuery({
        queryKey: ["tasks"],
        queryFn: async () => {
            const summaries = await apiClient.listTasks();

            // Map API summary to UI task structure
            return summaries.map(
                (summary): ITask => ({
                    id: summary.task_id,
                    name: summary.plan_description || "Untitled Task",
                    description: summary.plan_description || "No description provided.",
                    status: summary.status as TaskStatus,
                    nextRunAt: summary.updated_at,
                    blockedReason: summary.blocked_reason || undefined,
                })
            );
        },
    });
}
