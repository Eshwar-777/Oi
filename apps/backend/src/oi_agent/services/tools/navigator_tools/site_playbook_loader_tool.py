from __future__ import annotations

from typing import Any

from oi_agent.services.tools.base import BaseTool, ToolContext, ToolResult
from oi_agent.services.tools.navigator.site_playbooks import build_playbook_context, select_playbooks


class SitePlaybookLoaderTool(BaseTool):
    @property
    def name(self) -> str:
        return "site_playbook_loader"

    @property
    def description(self) -> str:
        return "Loads matching site playbooks from local knowledge so browser planning can reuse proven patterns."

    @property
    def category(self) -> str:
        return "data_fetcher"

    async def execute(self, context: ToolContext, input_data: list[dict[str, Any]]) -> ToolResult:
        prompt = str(context.action_config.get("prompt", "") or "")
        if not prompt and input_data:
            prompt = str(input_data[0].get("prompt", "") or "")
        current_url = str(context.action_config.get("current_url", "") or "")
        matches = select_playbooks(prompt, current_url)
        context_text = build_playbook_context(prompt, current_url)
        return ToolResult(
            success=True,
            data=[
                {
                    "playbook_context": context_text,
                    "playbooks": [
                        {"id": row.playbook_id, "title": row.title, "summary": row.summary}
                        for row in matches
                    ],
                }
            ],
            text=f"Loaded {len(matches)} playbook(s)",
        )

