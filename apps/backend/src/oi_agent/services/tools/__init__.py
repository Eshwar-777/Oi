"""Agentic tool system for automation execution.

Each tool implements BaseTool and is registered in the global ToolRegistry.
The ToolRouter uses Gemini to decide which tools to chain for a given automation.
The companion executor calls the tool chain instead of hardcoded logic.
"""
from oi_agent.services.tools.base import BaseTool, ToolContext, ToolResult, tool_registry

__all__ = ["BaseTool", "ToolResult", "ToolContext", "tool_registry"]
