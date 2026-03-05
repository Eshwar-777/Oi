"""Tool registration — registers available tools at startup."""
from oi_agent.services.tools.base import tool_registry
from oi_agent.services.tools.browser_automation import BrowserAutomationTool


def register_all_tools() -> None:
    """Register built-in tools with the global registry."""
    tool_registry.register(BrowserAutomationTool())


register_all_tools()
