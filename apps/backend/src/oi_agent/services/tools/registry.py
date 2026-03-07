"""Tool registration — registers available tools at startup."""
from oi_agent.services.tools.base import tool_registry
from oi_agent.services.tools.browser_automation import BrowserAutomationTool
from oi_agent.services.tools.navigator_tools import (
    BrowserStepPlannerTool,
    FormTargetResolverTool,
    McpCapabilityAdvisorTool,
    PromptRewriteTool,
    RecoveryPlannerTool,
    SitePlaybookLoaderTool,
    SnapshotDebuggerTool,
    TabSelectorTool,
)


def register_all_tools() -> None:
    """Register built-in tools with the global registry."""
    tool_registry.register(BrowserAutomationTool())
    tool_registry.register(PromptRewriteTool())
    tool_registry.register(BrowserStepPlannerTool())
    tool_registry.register(TabSelectorTool())
    tool_registry.register(SitePlaybookLoaderTool())
    tool_registry.register(SnapshotDebuggerTool())
    tool_registry.register(FormTargetResolverTool())
    tool_registry.register(RecoveryPlannerTool())
    tool_registry.register(McpCapabilityAdvisorTool())


register_all_tools()
