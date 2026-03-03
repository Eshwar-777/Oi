from __future__ import annotations

import logging
from typing import Any

from oi_agent.agents.task_graph.state import TaskState

logger = logging.getLogger(__name__)


async def run(state: TaskState) -> dict[str, Any]:
    """Consult node: handle the human-in-the-loop interaction.

    When the companion node encounters a blocker (CAPTCHA, decision needed),
    this node:
    1. Broadcasts the "action needed" notification to all mesh devices
    2. Pauses the graph (via LangGraph interrupt)
    3. When resumed, reads the human_action_response and continues

    The actual notification dispatch happens through the mesh broadcaster
    before the graph is interrupted. When the graph resumes, the
    human_action_response is already populated in state.
    """
    human_response = state.get("human_action_response")

    if human_response is None:
        logger.info(
            "Task %s waiting for human action: %s",
            state["task_id"],
            state.get("blocked_reason"),
        )
        return {"status": "blocked"}

    if human_response.lower() in ("cancel", "stop", "abort"):
        logger.info("Task %s cancelled by human", state["task_id"])
        return {"status": "cancelled"}

    if human_response.lower() in ("replan", "re-plan", "try again"):
        logger.info("Task %s re-plan requested by human", state["task_id"])
        return {"status": "planning"}

    logger.info(
        "Task %s human action received from device %s",
        state["task_id"],
        state.get("human_action_device_id"),
    )

    return {
        "status": "running",
        "blocked_reason": None,
        "blocked_screenshot_url": None,
        "human_action_response": None,
        "human_action_device_id": None,
    }


def route(state: TaskState) -> str:
    """Route after the consult node.

    'resume' goes back to companion to continue execution.
    're_plan' goes back to curate for a new plan.
    'cancel' ends the graph.
    """
    status = state.get("status", "")

    if status == "cancelled":
        return "cancel"
    if status == "planning":
        return "re_plan"
    return "resume"
