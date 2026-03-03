import React, { useState } from "react";
import { TaskCard } from "./TaskCard";
import { useTasks } from "../../hooks/useTasks";
import { useTaskAction } from "../../hooks/useManageTasks";

export const ConsultFlow: React.FC = () => {
    const [resolvingId, setResolvingId] = useState<string | null>(null);

    const { data: tasks, isLoading, isError, refetch, isFetching } = useTasks();
    const { mutate: submitAction } = useTaskAction();

    const blockedTasks = tasks?.filter((t) => t.status === "blocked") || [];

    const handleResolve = (taskId: string) => {
        // In a full implementation, you'd open a dialog for the user's explicit input text
        // For now, we simulate sending a default resume action
        const actionInput = prompt("Provide input to resume task:", "Resume execution");
        if (!actionInput) return;

        setResolvingId(taskId);
        submitAction(
            { taskId, action: actionInput },
            {
                onSettled: () => setResolvingId(null),
            }
        );
    };

    return (
        <div className="max-w-4xl mx-auto space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
                <div>
                    <h2 className="text-xl font-bold text-neutral-900 mb-2">Tasks for Input</h2>
                    <p className="text-sm text-neutral-500">
                        These tasks have encountered an issue that requires your attention.
                    </p>
                </div>
                <button
                    onClick={() => refetch()}
                    disabled={isFetching}
                    className="bg-white border text-neutral-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-neutral-50 transition flex items-center gap-2 w-fit disabled:opacity-50"
                >
                    <svg className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                    {isFetching ? "Refreshing..." : "Refresh Tasks"}
                </button>
            </div>

            <div className="space-y-4">
                {isLoading && (
                    <div className="text-center py-12 text-sm text-neutral-500">
                        Loading tasks needing input...
                    </div>
                )}

                {isError && (
                    <div className="text-center py-12 text-sm text-red-500 bg-red-50 rounded-xl border border-red-200">
                        Failed to load tasks. Verify your backend connection.
                    </div>
                )}

                {blockedTasks.map((task) => (
                    <TaskCard
                        key={task.id}
                        task={task}
                        primaryAction={
                            <button
                                onClick={() => handleResolve(task.id)}
                                disabled={resolvingId === task.id}
                                className="bg-red-600 text-white px-5 py-2 rounded-lg text-sm font-medium shadow-sm hover:bg-red-700 disabled:bg-red-300 disabled:cursor-not-allowed transition-colors"
                            >
                                {resolvingId === task.id ? "Resolving..." : "Resolve"}
                            </button>
                        }
                    />
                ))}

                {!isLoading && !isError && blockedTasks.length === 0 && (
                    <div className="text-center py-12 text-sm text-neutral-500 bg-neutral-50 rounded-xl border border-dashed border-neutral-300">
                        Yay! No tasks require your attention.
                    </div>
                )}
            </div>
        </div>
    );
};
