import React from "react";
import { Card, CardContent, CardFooter, CardHeader } from "../UI/Card";
import { Badge } from "../UI/Badge";
import { ITask } from "../../types/tasks";
import { TASK_STATUS_CONFIG } from "../../constants/taskStatuses";

export interface ITaskCardProps {
    task: ITask;
    primaryAction?: React.ReactNode;
    secondaryAction?: React.ReactNode;
}

export const TaskCard: React.FC<ITaskCardProps> = ({ task, primaryAction, secondaryAction }) => {
    const config = TASK_STATUS_CONFIG[task.status];

    return (
        <Card className="hover:border-maroon-300 transition-colors">
            <CardHeader>
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-maroon-50 flex items-center justify-center text-lg shadow-sm font-semibold text-maroon-600">
                        {task.name.charAt(0)}
                    </div>
                    <div>
                        <h3 className="text-sm font-bold text-neutral-900">{task.name}</h3>
                        {task.nextRunAt && (
                            <p className="text-xs text-neutral-500 mt-1">
                                Next run: {task.nextRunAt}
                            </p>
                        )}
                        {task.lastRunAt && (
                            <p className="text-xs text-neutral-400 mt-0.5">
                                Last run: {task.lastRunAt}
                            </p>
                        )}
                    </div>
                </div>
                <div>
                    <Badge variant={config.variant}>{config.label}</Badge>
                </div>
            </CardHeader>

            {task.description && (
                <CardContent>
                    <p className="text-sm text-neutral-600">{task.description}</p>
                </CardContent>
            )}

            {(primaryAction || secondaryAction) && (
                <CardFooter>
                    {secondaryAction}
                    {primaryAction}
                </CardFooter>
            )}
        </Card>
    );
};
