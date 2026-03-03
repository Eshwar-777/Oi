from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from oi_agent.agents.task_graph.state import TaskState

logger = logging.getLogger(__name__)


async def run(state: TaskState) -> dict[str, Any]:
    """Schedule node: determine when to execute the task.

    If scheduled_at is set and in the future, mark as scheduled and
    the graph will checkpoint here (Cloud Scheduler resumes it later).
    If no schedule or time has passed, move directly to execution.
    """
    scheduled_at = state.get("scheduled_at")

    if scheduled_at:
        try:
            # Python's fromisoformat does not accept "Z"; normalize to +00:00
            if isinstance(scheduled_at, str) and scheduled_at.endswith("Z"):
                scheduled_at = scheduled_at[:-1] + "+00:00"
            trigger_time = datetime.fromisoformat(scheduled_at)
            if trigger_time.tzinfo is None:
                trigger_time = trigger_time.replace(tzinfo=timezone.utc)
            now = datetime.now(tz=timezone.utc)

            if trigger_time > now:
                logger.info(
                    "Task %s scheduled for %s", state["task_id"], scheduled_at
                )
                return {"status": "scheduled"}
        except (ValueError, TypeError) as e:
            logger.warning("Invalid scheduled_at: %s (%s), executing immediately", scheduled_at, e)

    return {"status": "running", "current_step_index": 0}


def route(state: TaskState) -> str:
    """Route after the schedule node.

    'wait' means the task is scheduled for the future -- checkpoint and exit.
    'execute' means proceed to the companion node now.
    """
    if state.get("status") == "scheduled":
        return "wait"
    return "execute"
