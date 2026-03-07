from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, cast


async def send_extension_command(
    *,
    connection_manager: Any,
    device_id: str,
    run_id: str,
    action: str,
    target: Any,
    value: Any,
    step_index: int,
    step_label: str,
    total_steps: int,
    timeout: float,
    tab_id: int | None,
    ref: str | None = None,
    kind: str | None = None,
    snapshot_id: str | None = None,
    disambiguation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Send one extension command and await the matched result."""
    cmd_id = str(uuid.uuid4())[:8]
    command: dict[str, Any] = {
        "type": "extension_command",
        "payload": {
            "cmd_id": cmd_id,
            "run_id": run_id,
            "action": action,
            "target": target,
            "value": value,
            "step_index": step_index,
            "step_label": step_label,
            "total_steps": total_steps,
        },
        "timestamp": datetime.utcnow().isoformat(),
    }
    if ref:
        command["payload"]["ref"] = ref
    if kind:
        command["payload"]["kind"] = kind
    if snapshot_id:
        command["payload"]["snapshot_id"] = snapshot_id
    if disambiguation:
        command["payload"]["disambiguation"] = disambiguation
    if tab_id is not None:
        command["payload"]["tab_id"] = tab_id
    result = await connection_manager.send_command_and_wait(
        device_id, command, timeout=timeout,
    )
    return cast(dict[str, Any], result)
