from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from fastapi import HTTPException

from oi_agent.services.tools.tab_selector import select_best_attached_tab

logger = logging.getLogger(__name__)


def resolve_device_and_tab(
    device_id: str | None,
    tab_id: int | None,
) -> tuple[str, int | None]:
    from oi_agent.api.websocket import connection_manager

    dev = device_id or next(iter(connection_manager.get_extension_device_ids()), "")
    if not dev:
        raise HTTPException(
            status_code=409,
            detail="No extension connected. Install/connect the Oi extension, attach a tab, then try again.",
        )
    if connection_manager.is_attach_state_known(dev) and not connection_manager.has_attached_target(dev):
        raise HTTPException(
            status_code=409,
            detail="No tab attached. Click the Oi extension icon on the tab you want to control, then try again.",
        )
    return dev, tab_id


def resolve_device_and_tab_for_prompt(
    *,
    prompt: str,
    device_id: str | None,
    tab_id: int | None,
) -> tuple[str, int | None]:
    from oi_agent.api.websocket import connection_manager

    explicit_device_id = device_id
    dev, explicit_tab = resolve_device_and_tab(device_id, tab_id)
    if explicit_tab is not None:
        return dev, explicit_tab

    selected = select_best_attached_tab(
        prompt=prompt,
        attached_rows=connection_manager.list_attached_targets(),
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
    if tab_id is not None:
        command["payload"]["tab_id"] = tab_id

    try:
        result = await connection_manager.send_command_and_wait(
            device_id, command, timeout=15.0,
        )
        if result.get("status") == "error":
            return None
        data_raw = result.get("data", "")
        if isinstance(data_raw, str) and data_raw:
            return json.loads(data_raw)
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
            device_id, command, timeout=20.0,
        )
        if result.get("status") == "error":
            return None
        data_raw = result.get("data", "")
        if isinstance(data_raw, str) and data_raw:
            parsed = json.loads(data_raw)
            if isinstance(parsed, dict):
                return parsed
    except Exception as exc:
        logger.debug("Structured extract failed: %s", exc)
    return None
