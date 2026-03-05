from __future__ import annotations

from typing import Any

from oi_agent.services.tools.base import BaseTool, ToolContext, ToolResult
from oi_agent.services.tools.navigator.prompt_rewriter import rewrite_user_prompt


class PromptRewriteTool(BaseTool):
    @property
    def name(self) -> str:
        return "prompt_rewriter"

    @property
    def description(self) -> str:
        return "Normalizes user browser prompts to reduce ambiguity and platform-entity confusion."

    @property
    def category(self) -> str:
        return "processor"

    async def execute(self, context: ToolContext, input_data: list[dict[str, Any]]) -> ToolResult:
        prompt = str(context.action_config.get("prompt", "") or "")
        if not prompt and input_data:
            prompt = str(input_data[0].get("prompt", "") or "")
        if not prompt:
            return ToolResult(success=False, error="Missing prompt")

        current_url = str(context.action_config.get("current_url", "") or "")
        current_title = str(context.action_config.get("current_page_title", "") or "")
        rewritten = await rewrite_user_prompt(
            user_prompt=prompt,
            current_url=current_url,
            current_page_title=current_title,
        )
        return ToolResult(success=True, data=[{"prompt": rewritten}], text=rewritten)
