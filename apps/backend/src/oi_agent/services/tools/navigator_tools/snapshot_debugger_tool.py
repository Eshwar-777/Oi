from __future__ import annotations

from typing import Any

from oi_agent.services.tools.base import BaseTool, ToolContext, ToolResult


class SnapshotDebuggerTool(BaseTool):
    @property
    def name(self) -> str:
        return "snapshot_debugger"

    @property
    def description(self) -> str:
        return "Summarizes the current aria snapshot so failed browser plans can be diagnosed quickly."

    @property
    def category(self) -> str:
        return "processor"

    async def execute(self, context: ToolContext, input_data: list[dict[str, Any]]) -> ToolResult:
        snapshot = context.action_config.get("page_snapshot")
        if not isinstance(snapshot, dict):
            return ToolResult(success=False, error="Missing page_snapshot")

        lines = str(snapshot.get("snapshot", "") or "").strip().splitlines()
        preview = lines[:12]
        data = {
            "url": str(snapshot.get("url", "") or ""),
            "title": str(snapshot.get("title", "") or ""),
            "ref_count": int(snapshot.get("refCount", 0) or 0),
            "snapshot_id": str(snapshot.get("snapshot_id", "") or snapshot.get("snapshotId", "") or ""),
            "preview_lines": preview,
        }
        return ToolResult(success=True, data=[data], text=f"Snapshot refs: {data['ref_count']}")

