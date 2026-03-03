from __future__ import annotations

from typing import Annotated, Any, Literal, TypedDict

from langgraph.graph import add_messages


class TaskStep(TypedDict):
    index: int
    description: str
    action_type: Literal["api_call", "browser_action", "human_decision"]
    target_url: str | None
    status: Literal["pending", "running", "done", "failed", "blocked"]
    result: str | None


TaskStatus = Literal[
    "planning",
    "awaiting_approval",
    "scheduled",
    "running",
    "blocked",
    "completed",
    "failed",
    "cancelled",
]


class TaskState(TypedDict):
    """Shared state for the Curate -> Companion -> Consult lifecycle graph.

    All three agent nodes read and write to this single state object.
    LangGraph checkpoints it to Firestore after each node execution.
    """

    # Identity -- set once at task creation
    task_id: str
    user_id: str
    mesh_group_id: str
    created_by_device_id: str

    # Shared conversation context -- all nodes append to this
    messages: Annotated[list[Any], add_messages]

    # Curate node populates these
    plan_description: str
    steps: list[TaskStep]
    scheduled_at: str | None

    # Companion node updates these
    current_step_index: int
    status: TaskStatus

    # Consult node uses these when human action is needed
    blocked_reason: str | None
    blocked_screenshot_url: str | None
    human_action_response: str | None
    human_action_device_id: str | None
