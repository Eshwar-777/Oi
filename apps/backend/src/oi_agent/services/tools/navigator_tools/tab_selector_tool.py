from __future__ import annotations

from typing import Any

from oi_agent.services.tools.base import BaseTool, ToolContext, ToolResult
from oi_agent.services.tools.tab_selector import select_best_attached_tab


class TabSelectorTool(BaseTool):
    @property
    def name(self) -> str:
        return "tab_selector"

    @property
    def description(self) -> str:
        return "Selects the best attached browser tab for a user prompt."

    @property
    def category(self) -> str:
        return "processor"

    async def execute(self, context: ToolContext, input_data: list[dict[str, Any]]) -> ToolResult:
        prompt = str(context.action_config.get("prompt", "") or "")
        rows = context.action_config.get("attached_rows")
        if not isinstance(rows, list):
            return ToolResult(success=False, error="Missing attached tab rows")

        selected = select_best_attached_tab(
            prompt=prompt,
            attached_rows=rows,
            preferred_device_id=context.action_config.get("device_id"),
        )
        if not selected:
            return ToolResult(success=False, error="No suitable tab found")
        device_id, tab_id = selected
        return ToolResult(success=True, data=[{"device_id": device_id, "tab_id": tab_id}], text=f"Selected tab {tab_id}")
