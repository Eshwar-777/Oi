from __future__ import annotations

import json
import logging
import uuid
from typing import Any, cast

from fastapi import HTTPException

from oi_agent.api.browser.state import (
    SNAPSHOT_FETCH_TIMEOUT_SECONDS,
    STRUCTURED_FETCH_TIMEOUT_SECONDS,
)
from oi_agent.mesh.device_registry import DeviceRegistry
from oi_agent.services.tools.tab_selector import select_best_attached_tab

logger = logging.getLogger(__name__)


async def resolve_device_and_tab(
    *,
    user_id: str,
    device_id: str | None,
    tab_id: int | None,
) -> tuple[str, int | None]:
    from oi_agent.api.websocket import connection_manager

    registry = DeviceRegistry()
    linked_devices = await registry.get_user_devices(user_id)
    allowed_device_ids = {
        str(row.get("device_id", "") or "")
        for row in linked_devices
        if str(row.get("device_id", "") or "")
    }
    connected_device_ids = [
        candidate
        for candidate in connection_manager.get_extension_device_ids()
        if candidate in allowed_device_ids
    ]

    dev = device_id or next(iter(connected_device_ids), "")
    if not dev:
        raise HTTPException(
            status_code=409,
            detail="No extension connected. Install/connect the Oi extension, attach a tab, then try again.",
        )
    if dev not in allowed_device_ids:
        raise HTTPException(status_code=403, detail="Device does not belong to this user.")
    if connection_manager.is_attach_state_known(dev) and not connection_manager.has_attached_target(dev):
        raise HTTPException(
            status_code=409,
            detail="No tab attached. Click the Oi extension icon on the tab you want to control, then try again.",
        )
    return dev, tab_id


async def resolve_device_and_tab_for_prompt(
    *,
    user_id: str,
    prompt: str,
    device_id: str | None,
    tab_id: int | None,
) -> tuple[str, int | None]:
    from oi_agent.api.websocket import connection_manager

    explicit_device_id = device_id
    dev, explicit_tab = await resolve_device_and_tab(
        user_id=user_id,
        device_id=device_id,
        tab_id=tab_id,
    )
    if explicit_tab is not None:
        return dev, explicit_tab

    attached_rows = [
        row
        for row in connection_manager.list_attached_targets()
        if str(row.get("device_id", "") or "") == dev
    ]
    selected = select_best_attached_tab(
        prompt=prompt,
        attached_rows=attached_rows,
        preferred_device_id=explicit_device_id,
    )
    if selected is None:
        return dev, explicit_tab
    selected_dev, selected_tab = selected
    return selected_dev, selected_tab


async def fetch_page_snapshot(
    device_id: str,
    tab_id: int | None,
    run_id: str,
    *,
    snapshot_format: str | None = None,
    scope_selector: str | None = None,
    frame: str | None = None,
    target_id: str | None = None,
) -> dict[str, Any] | None:
    from oi_agent.api.websocket import connection_manager

    cmd_id = str(uuid.uuid4())[:8]
    command: dict[str, Any] = {
        "type": "extension_command",
        "payload": {
            "cmd_id": cmd_id,
            "run_id": run_id,
            "action": "snapshot",
            "target": "",
            "value": "",
        },
    }
    if snapshot_format:
        command["payload"]["snapshotFormat"] = snapshot_format
    if scope_selector:
        command["payload"]["scopeSelector"] = scope_selector
    if frame:
        command["payload"]["frame"] = frame
    if target_id:
        command["payload"]["targetId"] = target_id
    if tab_id is not None:
        command["payload"]["tab_id"] = tab_id

    try:
        result = await connection_manager.send_command_and_wait(
            device_id, command, timeout=SNAPSHOT_FETCH_TIMEOUT_SECONDS,
        )
        if result.get("status") == "error":
            logger.debug("Snapshot command returned error: %s", result.get("data", ""))
            data_raw = result.get("data", "")
            if isinstance(data_raw, str) and data_raw:
                try:
                    parsed = json.loads(data_raw)
                    if isinstance(parsed, dict):
                        parsed["error_code"] = str(result.get("error_code", "") or parsed.get("error_code", "") or "")
                        return cast(dict[str, Any], parsed)
                except Exception:
                    pass
            return {
                "error": str(result.get("data", "") or ""),
                "error_code": str(result.get("error_code", "") or ""),
            }
        data_raw = result.get("data", "")
        if isinstance(data_raw, str) and data_raw:
            parsed = json.loads(data_raw)
            if isinstance(parsed, dict):
                return cast(dict[str, Any], parsed)
    except Exception as exc:
        logger.debug("Snapshot fetch failed: %s", exc)
    return None


async def fetch_structured_page_context(
    device_id: str,
    tab_id: int | None,
    run_id: str,
) -> dict[str, Any] | None:
    from oi_agent.api.websocket import connection_manager

    cmd_id = str(uuid.uuid4())[:8]
    command: dict[str, Any] = {
        "type": "extension_command",
        "payload": {
            "cmd_id": cmd_id,
            "run_id": run_id,
            "action": "extract_structured",
            "target": "",
            "value": "",
        },
    }
    if tab_id is not None:
        command["payload"]["tab_id"] = tab_id

    try:
        result = await connection_manager.send_command_and_wait(
            device_id, command, timeout=STRUCTURED_FETCH_TIMEOUT_SECONDS,
        )
        if result.get("status") == "error":
            logger.debug("Structured extract returned error: %s", result.get("data", ""))
            return None
        data_raw = result.get("data", "")
        if isinstance(data_raw, str) and data_raw:
            parsed = json.loads(data_raw)
            if isinstance(parsed, dict):
                return cast(dict[str, Any], parsed)
    except Exception as exc:
        logger.debug("Structured extract failed: %s", exc)
    return None


async def fetch_page_screenshot(
    device_id: str,
    tab_id: int | None,
    run_id: str,
    *,
    annotated: bool = False,
    frame: str | None = None,
    target_id: str | None = None,
) -> dict[str, Any] | None:
    from oi_agent.api.websocket import connection_manager

    cmd_id = str(uuid.uuid4())[:8]
    command: dict[str, Any] = {
        "type": "extension_command",
        "payload": {
            "cmd_id": cmd_id,
            "run_id": run_id,
            "action": "screenshot",
            "target": "",
            "value": "",
        },
    }
    if annotated:
        command["payload"]["annotated"] = True
    if frame:
        command["payload"]["frame"] = frame
    if target_id:
        command["payload"]["targetId"] = target_id
    if tab_id is not None:
        command["payload"]["tab_id"] = tab_id

    try:
        result = await connection_manager.send_command_and_wait(
            device_id, command, timeout=SNAPSHOT_FETCH_TIMEOUT_SECONDS,
        )
        if result.get("status") == "error":
            logger.debug("Screenshot command returned error: %s", result.get("data", ""))
            return None
        screenshot = str(result.get("screenshot", "") or "")
        if not screenshot:
            return None
        viewport = result.get("viewport", {})
        return {
            "screenshot": screenshot,
            "current_url": str(result.get("current_url", "") or ""),
            "page_title": str(result.get("page_title", "") or ""),
            "viewport": viewport if isinstance(viewport, dict) else {},
            "device_pixel_ratio": result.get("device_pixel_ratio", 1),
        }
    except Exception as exc:
        logger.debug("Screenshot fetch failed: %s", exc)
    return None


async def highlight_page_target(
    device_id: str,
    tab_id: int | None,
    run_id: str,
    *,
    target: Any,
) -> str | None:
    from oi_agent.api.websocket import connection_manager

    cmd_id = str(uuid.uuid4())[:8]
    command: dict[str, Any] = {
        "type": "extension_command",
        "payload": {
            "cmd_id": cmd_id,
            "run_id": run_id,
            "action": "highlight",
            "target": target,
            "value": "",
        },
    }
    if tab_id is not None:
        command["payload"]["tab_id"] = tab_id

    try:
        result = await connection_manager.send_command_and_wait(
            device_id, command, timeout=SNAPSHOT_FETCH_TIMEOUT_SECONDS,
        )
        if result.get("status") == "error":
            logger.debug("Highlight command returned error: %s", result.get("data", ""))
            return None
        return str(result.get("data", "") or "")
    except Exception as exc:
        logger.debug("Highlight fetch failed: %s", exc)
    return None


async def fetch_ui_blockers(
    device_id: str,
    tab_id: int | None,
    run_id: str,
) -> dict[str, Any] | None:
    from oi_agent.api.websocket import connection_manager

    cmd_id = str(uuid.uuid4())[:8]
    command: dict[str, Any] = {
        "type": "extension_command",
        "payload": {
            "cmd_id": cmd_id,
            "run_id": run_id,
            "action": "scan_ui_blockers",
            "target": "",
            "value": "",
        },
    }
    if tab_id is not None:
        command["payload"]["tab_id"] = tab_id
    try:
        result = await connection_manager.send_command_and_wait(
            device_id, command, timeout=SNAPSHOT_FETCH_TIMEOUT_SECONDS,
        )
        data_raw = result.get("data", "")
        if isinstance(data_raw, str) and data_raw:
            parsed = json.loads(data_raw)
            if isinstance(parsed, dict):
                return cast(dict[str, Any], parsed)
    except Exception as exc:
        logger.debug("UI blocker scan failed: %s", exc)
    return None


async def fetch_page_diagnostics(
    device_id: str,
    tab_id: int | None,
    run_id: str,
) -> dict[str, Any] | None:
    from oi_agent.api.websocket import connection_manager

    cmd_id = str(uuid.uuid4())[:8]
    command: dict[str, Any] = {
        "type": "extension_command",
        "payload": {
            "cmd_id": cmd_id,
            "run_id": run_id,
            "action": "diagnostics",
            "target": "",
            "value": "",
        },
    }
    if tab_id is not None:
        command["payload"]["tab_id"] = tab_id
    try:
        result = await connection_manager.send_command_and_wait(
            device_id, command, timeout=SNAPSHOT_FETCH_TIMEOUT_SECONDS,
        )
        data_raw = result.get("data", "")
        if isinstance(data_raw, str) and data_raw:
            parsed = json.loads(data_raw)
            if isinstance(parsed, dict):
                return cast(dict[str, Any], parsed)
    except Exception as exc:
        logger.debug("Diagnostics fetch failed: %s", exc)
    return None
