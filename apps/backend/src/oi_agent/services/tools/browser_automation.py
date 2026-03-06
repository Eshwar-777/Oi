"""Browser Automation Tool — sends browser steps to the Chrome extension via WebSocket.

This tool is the bridge between the Step Planner and the extension. It:
1. Takes a list of browser steps from the step planner
2. Sends each step to the extension as an extension_command
3. Waits for the extension_result before proceeding
4. After each action, captures a screenshot for the live browser view
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime
from typing import Any

from oi_agent.services.tools.base import BaseTool, ToolContext, ToolResult
from oi_agent.services.tools.navigator.fallbacks import attempt_adaptive_click_recovery

logger = logging.getLogger(__name__)


class BrowserAutomationTool(BaseTool):
    """Executes browser automation steps via the Chrome extension."""

    @property
    def name(self) -> str:
        return "browser_automation"

    @property
    def description(self) -> str:
        return (
            "Automates browser interactions (navigate, click, type, scroll, etc.) "
            "by sending commands to the OI Chrome extension. Used for tasks that "
            "require real website interaction like ordering food, booking tickets, "
            "or filling forms."
        )

    @property
    def category(self) -> str:
        return "action"

    async def execute(
        self,
        context: ToolContext,
        input_data: list[dict[str, Any]],
    ) -> ToolResult:
        from oi_agent.api.websocket import connection_manager

        steps = self._extract_browser_steps(input_data, context)
        if not steps:
            return ToolResult(success=False, error="No browser steps to execute")

        device_id = self._find_extension_device(context)
        if not device_id:
            target_hint = self._get_first_url_hint(steps)
            message = (
                "This automation runs in your browser. "
                "Please open the relevant tab"
                + (f" ({target_hint})" if target_hint else "")
                + " and ensure the Oi extension is installed and connected, then try Run now again."
            )
            return ToolResult(success=False, error=message)
        if connection_manager.is_attach_state_known(device_id) and not connection_manager.has_attached_target(device_id):
            target_hint = self._get_first_url_hint(steps)
            message = (
                "No browser tab is attached yet. "
                "Please open the relevant tab"
                + (f" ({target_hint})" if target_hint else "")
                + " and click the Oi extension button to attach it, then try Run now again."
            )
            return ToolResult(success=False, error=message)
        tab_error = self._validate_requested_tab(connection_manager, device_id, context.action_config.get("tab_id"))
        if tab_error:
            return ToolResult(success=False, error=tab_error)

        run_id = context.action_config.get("run_id", str(uuid.uuid4())[:8])

        await connection_manager.send_to_device(device_id, {
            "type": "start_screenshot_stream",
            "payload": {"run_id": run_id, "interval_ms": 1500},
        })

        results: list[dict[str, Any]] = []
        last_screenshot = ""

        try:
            for idx, step in enumerate(steps):
                if step.get("type") != "browser":
                    continue

                max_retries = 2 if step.get("action") not in ("navigate", "screenshot", "wait") else 0
                result: dict[str, Any] = {}

                for attempt in range(max_retries + 1):
                    cmd_id = str(uuid.uuid4())[:8]
                    command: dict[str, Any] = {
                        "type": "extension_command",
                        "payload": {
                            "cmd_id": cmd_id,
                            "run_id": run_id,
                            "action": step.get("action", ""),
                            "target": step.get("target", ""),
                            "value": step.get("value", ""),
                            "step_index": idx,
                            "step_label": step.get("description", ""),
                            "total_steps": len(steps),
                        },
                        "timestamp": datetime.utcnow().isoformat(),
                    }
                    if isinstance(step.get("disambiguation"), dict):
                        command["payload"]["disambiguation"] = step.get("disambiguation")
                    tab_id = context.action_config.get("tab_id")
                    if tab_id is not None:
                        command["payload"]["tab_id"] = tab_id

                    timeout = 30.0
                    if step.get("action") == "wait":
                        timeout = float(step.get("timeout", 15)) + 5
                    elif step.get("action") == "navigate":
                        timeout = 100.0

                    logger.info(
                        "Browser step dispatch run_id=%s idx=%d/%d action=%s attempt=%d tab_id=%s target=%s",
                        run_id,
                        idx + 1,
                        len(steps),
                        step.get("action", ""),
                        attempt + 1,
                        tab_id,
                        str(step.get("target", ""))[:180],
                    )
                    result = await connection_manager.send_command_and_wait(
                        device_id, command, timeout=timeout,
                    )

                    status = result.get("status", "error")
                    logger.info(
                        "Browser step result run_id=%s idx=%d action=%s status=%s data=%s",
                        run_id,
                        idx + 1,
                        step.get("action", ""),
                        status,
                        str(result.get("data", ""))[:220],
                    )
                    if status != "error" or not self._is_retriable_error(result.get("data", "")):
                        break
                    if attempt < max_retries:
                        logger.info("Step %d attempt %d failed (%s), retrying in 2s…", idx, attempt + 1, result.get("data", ""))
                        await asyncio.sleep(2)

                status = result.get("status", "error")
                screenshot = result.get("screenshot", "")
                if screenshot:
                    last_screenshot = screenshot

                if status == "error" and step.get("action") == "click":
                    recovered = await attempt_adaptive_click_recovery(
                        connection_manager=connection_manager,
                        device_id=device_id,
                        context=context,
                        run_id=run_id,
                        failed_step=step,
                        step_index=idx,
                        total_steps=len(steps),
                    )
                    if recovered is not None and recovered.get("status") != "error":
                        result = recovered
                        status = result.get("status", "done")

                results.append({
                    "step_index": idx,
                    "action": step.get("action"),
                    "description": step.get("description", ""),
                    "status": status,
                    "data": result.get("data", ""),
                })

                if status == "error":
                    error_data = result.get("data", "")
                    logger.warning("Browser step %d failed: %s", idx, error_data)
                    if self._is_no_tab_attached_error(error_data):
                        return ToolResult(
                            success=False,
                            data=results,
                            error=(
                                "No browser tab is attached. Click the Oi extension button "
                                "on the tab you want to control, then try Run now again."
                            ),
                            metadata={"last_screenshot": last_screenshot, "run_id": run_id},
                        )
                    stale_tab_message = self._format_stale_tab_error(
                        connection_manager, device_id, error_data, context.action_config.get("tab_id"),
                    )
                    if stale_tab_message:
                        return ToolResult(
                            success=False,
                            data=results,
                            error=stale_tab_message,
                            metadata={"last_screenshot": last_screenshot, "run_id": run_id},
                        )
                    return ToolResult(
                        success=False,
                        data=results,
                        error=f"Step {idx} failed: {error_data}",
                        metadata={"last_screenshot": last_screenshot, "run_id": run_id},
                    )

                if status == "stuck":
                    return ToolResult(
                        success=False,
                        data=results,
                        error=f"Step {idx} stuck: {result.get('data', 'Automation stuck')}",
                        metadata={"last_screenshot": last_screenshot, "run_id": run_id},
                    )

        finally:
            await connection_manager.send_to_device(device_id, {
                "type": "stop_screenshot_stream",
                "payload": {"run_id": run_id},
            })

        return ToolResult(
            success=True,
            data=results,
            text=f"Completed {len(results)} browser steps",
            metadata={"last_screenshot": last_screenshot, "run_id": run_id},
        )

    def _extract_browser_steps(
        self, input_data: list[dict[str, Any]], context: ToolContext,
    ) -> list[dict[str, Any]]:
        """Pull the step list from input_data or context."""
        for item in input_data:
            if "steps" in item:
                return item["steps"]

        return context.action_config.get("browser_steps", [])

    def _get_first_url_hint(self, steps: list[dict[str, Any]]) -> str:
        """Return the first navigate target URL for a user-facing hint."""
        for step in steps:
            if step.get("type") == "browser" and step.get("action") == "navigate":
                target = step.get("target", "")
                if isinstance(target, str) and target.startswith("http"):
                    return target
        return ""

    def _find_extension_device(self, context: ToolContext) -> str | None:
        """Find a connected extension device for this user."""
        from oi_agent.api.websocket import connection_manager

        explicit = context.action_config.get("device_id")
        if explicit and connection_manager.is_connected(explicit):
            return explicit

        devices = connection_manager.get_extension_device_ids()
        return devices[0] if devices else None

    def _is_retriable_error(self, error: str) -> bool:
        retriable = ("not found", "not ready", "loading", "element not found", "not found:")
        return any(r in error.lower() for r in retriable)

    def _is_no_tab_attached_error(self, error: str) -> bool:
        lower = error.lower()
        signals = ("no tab attached", "target detached", "cannot access a chrome://", "not attached")
        return any(s in lower for s in signals)

    def _validate_requested_tab(self, connection_manager: Any, device_id: str, tab_id: int | None) -> str | None:
        if tab_id is None:
            return None
        tabs = connection_manager.get_attached_tabs(device_id)
        attached_ids = {int(t.get("tab_id", 0)) for t in tabs if isinstance(t, dict)}
        if tab_id in attached_ids:
            return None
        if not tabs:
            return (
                "No attached tab found on the selected device. "
                "Attach a tab via the Oi extension icon, then retry."
            )
        preview = ", ".join(
            f"{t.get('tab_id')}:{(str(t.get('title', '') or '')[:40] or 'untitled')}"
            for t in tabs[:5]
            if isinstance(t, dict)
        )
        return (
            f"Selected tab {tab_id} is not attached on this device. "
            f"Available attached tabs: {preview}. "
            "Refresh tabs and retry."
        )

    def _format_stale_tab_error(
        self,
        connection_manager: Any,
        device_id: str,
        error: str,
        tab_id: int | None,
    ) -> str | None:
        lower = error.lower()
        if "requested tab" not in lower and "stale targetid" not in lower and "tab not found" not in lower:
            return None
        tabs = connection_manager.get_attached_tabs(device_id)
        if not tabs:
            return (
                "The target tab is no longer attached. "
                "Attach the tab via the Oi extension icon and retry."
            )
        tab_list = ", ".join(
            f"{t.get('tab_id')}:{(str(t.get('title', '') or '')[:40] or 'untitled')}"
            for t in tabs[:6]
            if isinstance(t, dict)
        )
        if tab_id is not None:
            return (
                f"Tab {tab_id} is stale or detached for this device. "
                f"Currently attached tabs: {tab_list}. Refresh and retry."
            )
        return f"Current tab target is stale. Attached tabs: {tab_list}. Refresh and retry."
