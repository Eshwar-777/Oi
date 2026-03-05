from __future__ import annotations

from typing import Any

from oi_agent.services.tools.base import BaseTool, ToolContext, ToolResult
from oi_agent.services.tools.step_planner import plan_browser_steps


class BrowserStepPlannerTool(BaseTool):
    @property
    def name(self) -> str:
        return "browser_step_planner"

    @property
    def description(self) -> str:
        return "Creates executable browser automation steps from a normalized user prompt."

    @property
    def category(self) -> str:
        return "processor"

    async def execute(self, context: ToolContext, input_data: list[dict[str, Any]]) -> ToolResult:
        prompt = str(context.action_config.get("prompt", "") or "")
        if input_data and isinstance(input_data[0], dict) and input_data[0].get("prompt"):
            prompt = str(input_data[0].get("prompt", "") or prompt)
        if not prompt:
            return ToolResult(success=False, error="Missing prompt")

        plan = await plan_browser_steps(
            user_prompt=prompt,
            current_url=str(context.action_config.get("current_url", "") or ""),
            current_page_title=str(context.action_config.get("current_page_title", "") or ""),
            page_snapshot=context.action_config.get("page_snapshot") if isinstance(context.action_config.get("page_snapshot"), dict) else None,
        )
        return ToolResult(success=True, data=[plan], text=f"Planned {len(plan.get('steps', []))} steps")
