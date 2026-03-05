"""Base tool interface and registry for the agentic automation system.

Every tool:
- Has a unique name and description (used by the AI router)
- Declares what inputs it needs and what it produces
- Implements an async execute() method
- Returns a ToolResult with data that can be piped to the next tool
"""
from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class ToolContext:
    """Shared context passed through a tool chain execution."""
    automation_id: str
    user_id: str
    action_config: dict[str, Any] = field(default_factory=dict)
    data_sources: list[dict[str, Any]] = field(default_factory=list)
    trigger_config: dict[str, Any] = field(default_factory=dict)
    automation_name: str = ""
    automation_description: str = ""
    execution_mode: str = "autopilot"


@dataclass
class ToolResult:
    """Output from a single tool execution."""
    success: bool
    data: list[dict[str, Any]] = field(default_factory=list)
    text: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    error: str = ""

    @property
    def summary(self) -> str:
        if self.error:
            return f"Failed: {self.error}"
        if self.text:
            return self.text
        return f"{len(self.data)} items"


class BaseTool(ABC):
    """Interface every agentic tool must implement."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Unique tool identifier (e.g. 'web_search', 'send_email')."""

    @property
    @abstractmethod
    def description(self) -> str:
        """Human-readable description — the AI router reads this."""

    @property
    @abstractmethod
    def category(self) -> str:
        """One of: data_fetcher, processor, action, notifier."""

    @property
    def input_schema(self) -> dict[str, str]:
        """Describe expected keys in context/previous results."""
        return {}

    @property
    def output_schema(self) -> dict[str, str]:
        """Describe what this tool produces in ToolResult."""
        return {}

    @abstractmethod
    async def execute(
        self, context: ToolContext, input_data: list[dict[str, Any]]
    ) -> ToolResult:
        """Run the tool. input_data comes from the previous tool in the chain."""

    def can_handle(self, context: ToolContext) -> bool:
        """Quick check if this tool is relevant for the given context.
        Used as a fast pre-filter before the AI router.
        """
        return True


class ToolRegistry:
    """Global registry of all available tools."""

    def __init__(self) -> None:
        self._tools: dict[str, BaseTool] = {}

    def register(self, tool: BaseTool) -> None:
        self._tools[tool.name] = tool
        logger.info("Registered tool: %s (%s)", tool.name, tool.category)

    def get(self, name: str) -> BaseTool | None:
        return self._tools.get(name)

    def all_tools(self) -> list[BaseTool]:
        return list(self._tools.values())

    def by_category(self, category: str) -> list[BaseTool]:
        return [t for t in self._tools.values() if t.category == category]

    def describe_all(self) -> str:
        """Produce a description string for the AI router prompt."""
        lines = []
        for t in self._tools.values():
            lines.append(f"- **{t.name}** ({t.category}): {t.description}")
        return "\n".join(lines)

    @property
    def tool_names(self) -> list[str]:
        return list(self._tools.keys())


tool_registry = ToolRegistry()
