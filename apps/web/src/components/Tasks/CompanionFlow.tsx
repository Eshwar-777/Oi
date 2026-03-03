import React from "react";
import { TaskCard } from "./TaskCard";
import { useTasks } from "../../hooks/useTasks";

export const CompanionFlow: React.FC = () => {
    const { data: tasks, isLoading, isError, refetch, isFetching } = useTasks();

    const activeTasks = tasks?.filter(
        (t) => t.status === "running" || t.status === "scheduled" || t.status === "planning"
    ) || [];

    return (
        <div className="max-w-4xl mx-auto space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
                <div>
                    <h2 className="text-xl font-bold text-neutral-900 mb-2">Active Tasks</h2>
                    <p className="text-sm text-neutral-500">
                        Monitor tasks that are currently scheduled or executing.
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
                        Loading active tasks...
                    </div>
                )}

                {isError && (
                    <div className="text-center py-12 text-sm text-red-500 bg-red-50 rounded-xl border border-red-200">
                        Failed to load tasks. Verify your backend connection.
                    </div>
                )}

                {activeTasks.map((task) => (
                    <TaskCard
                        key={task.id}
                        task={task}
                        primaryAction={
                            task.status === "running" ? (
                                <button className="bg-maroon-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-maroon-700 transition">
                                    View Live
                                </button>
                            ) : undefined
                        }
                        secondaryAction={
                            <button className="bg-white border text-neutral-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-neutral-50 transition">
                                View Details
                            </button>
                        }
                    />
                ))}

                {!isLoading && !isError && activeTasks.length === 0 && (
                    <div className="text-center py-12 text-sm text-neutral-500 bg-neutral-50 rounded-xl border border-dashed border-neutral-300">
                        No active tasks found. Go to Curate to create a new one!
                    </div>
                )}
            </div>
        </div>
    );
};
