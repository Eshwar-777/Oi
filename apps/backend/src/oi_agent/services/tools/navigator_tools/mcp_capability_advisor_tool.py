from __future__ import annotations

from typing import Any

from oi_agent.services.mcp.registry import recommend_mcp_servers
from oi_agent.services.tools.base import BaseTool, ToolContext, ToolResult


class McpCapabilityAdvisorTool(BaseTool):
    @property
    def name(self) -> str:
        return "mcp_capability_advisor"

    @property
    def description(self) -> str:
        return "Suggests MCP servers that can replace brittle browser UI work for the current task."

    @property
    def category(self) -> str:
        return "processor"

    async def execute(self, context: ToolContext, input_data: list[dict[str, Any]]) -> ToolResult:
        prompt = str(context.action_config.get("prompt", "") or "")
        current_url = str(context.action_config.get("current_url", "") or "")
        matches = recommend_mcp_servers(prompt, current_url)
        return ToolResult(
            success=True,
            data=[
                {
                    "recommended_servers": [
                        {
                            "server_id": row.server_id,
                            "title": row.title,
                            "capabilities": list(row.capabilities),
                        }
                        for row in matches
                    ]
                }
            ],
            text=f"Suggested {len(matches)} MCP server(s)",
        )
