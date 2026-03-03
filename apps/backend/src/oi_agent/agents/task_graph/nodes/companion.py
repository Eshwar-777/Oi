from __future__ import annotations

import logging
from typing import Any

from oi_agent.agents.task_graph.state import TaskState

logger = logging.getLogger(__name__)


async def run(state: TaskState) -> dict[str, Any]:
    """Companion node: execute the current step of the task plan.

    Picks up the step at current_step_index, dispatches it to the
    appropriate tool (browser automation, API call, etc.), and updates
    the step status.
    """
    steps = list(state.get("steps", []))
    current_index = state.get("current_step_index", 0)

    if current_index >= len(steps):
        return {"status": "completed"}

    step = dict(steps[current_index])
    step["status"] = "running"
    steps[current_index] = step

    logger.info(
        "Executing step %d/%d for task %s: %s",
        current_index + 1,
        len(steps),
        state["task_id"],
        step["description"],
    )

    try:
        result = await _execute_step(step, state)

        step["status"] = "done"
        step["result"] = result
        steps[current_index] = step

        return {
            "steps": steps,
            "current_step_index": current_index + 1,
            "status": "running",
            "blocked_reason": None,
            "blocked_screenshot_url": None,
            "human_action_response": None,
        }

    except HumanActionRequired as exc:
        step["status"] = "blocked"
        steps[current_index] = step

        return {
            "steps": steps,
            "status": "blocked",
            "blocked_reason": str(exc),
            "blocked_screenshot_url": exc.screenshot_url,
        }

    except Exception as exc:
        logger.error("Step %d failed: %s", current_index, exc)
        step["status"] = "failed"
        step["result"] = str(exc)
        steps[current_index] = step

        return {"steps": steps, "status": "failed"}


class HumanActionRequired(Exception):
    """Raised when a step cannot proceed without human intervention."""

    def __init__(self, reason: str, screenshot_url: str | None = None) -> None:
        super().__init__(reason)
        self.screenshot_url = screenshot_url


async def _execute_step(step: dict[str, Any], state: TaskState) -> str:
    """Dispatch a single step to the appropriate execution tool.

    This is the integration point for Playwright, Gemini Computer Use,
    API calls, and other automation tools.
    """
    action_type = step.get("action_type", "browser_action")
    description = step.get("description", "")
    target_url = step.get("target_url")

    if action_type == "browser_action":
        return await _execute_browser_action(description, target_url, state)
    elif action_type == "api_call":
        return await _execute_api_call(description, target_url, state)
    elif action_type == "human_decision":
        raise HumanActionRequired(
            reason=f"Human decision needed: {description}"
        )
    else:
        return f"Unknown action type: {action_type}"


async def _execute_browser_action(
    description: str, target_url: str | None, state: TaskState
) -> str:
    """Execute a browser automation step.

    In the full implementation, this sends commands to the Chrome extension
    via WebSocket or uses Playwright for headless automation.
    """
    logger.info("Browser action: %s (url=%s)", description, target_url)
    return f"Completed: {description}"


async def _execute_api_call(
    description: str, target_url: str | None, state: TaskState
) -> str:
    """Execute an API call step."""
    logger.info("API call: %s (url=%s)", description, target_url)
    return f"API call completed: {description}"


def route(state: TaskState) -> str:
    """Route after the companion node.

    'next_step' loops back to companion for the next step.
    'blocked' goes to consult for human intervention.
    'done' and 'failed' end the graph.
    """
    status = state.get("status", "")

    if status == "blocked":
        return "blocked"
    if status == "failed":
        return "failed"
    if status == "completed":
        return "done"

    current_index = state.get("current_step_index", 0)
    total_steps = len(state.get("steps", []))

    if current_index >= total_steps:
        return "done"

    return "next_step"
