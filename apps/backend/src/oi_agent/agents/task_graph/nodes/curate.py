from __future__ import annotations

import json
import logging
from typing import Any

from oi_agent.agents.task_graph.state import TaskState, TaskStep
from oi_agent.config import settings

logger = logging.getLogger(__name__)


async def run(state: TaskState) -> dict[str, Any]:
    """Curate node: analyze the user request and produce a structured plan.

    Reads the conversation messages, sends them to Gemini to decompose
    the request into actionable steps, and returns the plan.
    """
    messages = state.get("messages", [])
    if not messages:
        return {"status": "failed", "plan_description": "No input provided"}

    last_user_message = ""
    for message in reversed(messages):
        content = getattr(message, "content", "") or ""
        role = getattr(message, "type", "") or ""
        if role == "human":
            last_user_message = content
            break

    plan = await _generate_plan(last_user_message)

    # Preserve scheduled_at from the request if the planner did not set one
    scheduled_at = plan.get("scheduled_at") or state.get("scheduled_at")

    return {
        "plan_description": plan["description"],
        "steps": plan["steps"],
        "status": "awaiting_approval",
        "scheduled_at": scheduled_at,
    }


async def _generate_plan(user_request: str) -> dict[str, Any]:
    """Call Gemini to decompose a user request into task steps."""
    try:
        from google import genai

        client = genai.Client(
            vertexai=settings.google_genai_use_vertexai,
            project=settings.gcp_project,
            location=settings.gcp_location,
        )

        prompt = f"""You are a task planning assistant. The user wants to automate something.
Decompose their request into concrete steps.

User request: "{user_request}"

Respond in JSON format:
{{
  "description": "Brief description of the overall plan",
  "scheduled_at": "ISO timestamp if the user specified a time, else null",
  "steps": [
    {{
      "index": 0,
      "description": "What this step does",
      "action_type": "browser_action" or "api_call" or "human_decision",
      "target_url": "URL if applicable, else null",
      "status": "pending",
      "result": null
    }}
  ]
}}"""

        response = client.models.generate_content(
            model=settings.gemini_model,
            contents=[{"role": "user", "parts": [{"text": prompt}]}],
        )

        text = response.text or "{}"
        text = text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text
            text = text.rsplit("```", 1)[0]

        plan = json.loads(text)

        steps: list[TaskStep] = []
        for step_data in plan.get("steps", []):
            steps.append(TaskStep(
                index=step_data.get("index", len(steps)),
                description=step_data.get("description", ""),
                action_type=step_data.get("action_type", "browser_action"),
                target_url=step_data.get("target_url"),
                status="pending",
                result=None,
            ))

        return {
            "description": plan.get("description", user_request),
            "scheduled_at": plan.get("scheduled_at"),
            "steps": steps,
        }

    except Exception as exc:
        logger.error("Plan generation failed: %s", exc)
        return {
            "description": user_request,
            "scheduled_at": None,
            "steps": [
                TaskStep(
                    index=0,
                    description=user_request,
                    action_type="browser_action",
                    target_url=None,
                    status="pending",
                    result=None,
                )
            ],
        }
