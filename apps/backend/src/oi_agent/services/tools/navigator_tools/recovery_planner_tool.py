from __future__ import annotations

from typing import Any

from oi_agent.services.tools.base import BaseTool, ToolContext, ToolResult
from oi_agent.services.tools.navigator.site_playbooks import build_playbook_context
from oi_agent.services.tools.step_planner import plan_browser_steps


class RecoveryPlannerTool(BaseTool):
    @property
    def name(self) -> str:
        return "recovery_planner"

    @property
    def description(self) -> str:
        return "Builds a recovery sub-plan from the current page state, completed steps, and the last browser failure."

    @property
    def category(self) -> str:
        return "processor"

    async def execute(self, context: ToolContext, input_data: list[dict[str, Any]]) -> ToolResult:
        prompt = str(context.action_config.get("prompt", "") or "")
        current_url = str(context.action_config.get("current_url", "") or "")
        playbook_context = build_playbook_context(prompt=prompt, current_url=current_url)
        plan = await plan_browser_steps(
            user_prompt=prompt,
            current_url=current_url,
            current_page_title=str(context.action_config.get("current_page_title", "") or ""),
            page_snapshot=context.action_config.get("page_snapshot") if isinstance(context.action_config.get("page_snapshot"), dict) else None,
            structured_context=context.action_config.get("structured_context") if isinstance(context.action_config.get("structured_context"), dict) else None,
            playbook_context=playbook_context,
            completed_steps=context.action_config.get("completed_steps") if isinstance(context.action_config.get("completed_steps"), list) else None,
            failed_step=context.action_config.get("failed_step") if isinstance(context.action_config.get("failed_step"), dict) else None,
            error_message=str(context.action_config.get("error_message", "") or ""),
        )
        return ToolResult(success=True, data=[plan], text=f"Recovery planned with {len(plan.get('steps', []))} step(s)")

