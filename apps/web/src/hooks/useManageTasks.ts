import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../lib/apiClient";

export function useCreateTask() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({ message, sessionId }: { message: string; sessionId?: string }) => {
            return apiClient.sendMessage({
                user_id: "dev-user",
                session_id: sessionId || "dashboard-session",
                message,
            });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["tasks"] });
        },
    });
}

export function useTaskAction() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async ({ taskId, action }: { taskId: string; action: string }) => {
            return apiClient.submitTaskAction(taskId, action, "web-device-dev");
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["tasks"] });
        },
    });
}
