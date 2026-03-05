from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any


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
    if tab_id is not None:
        command["payload"]["tab_id"] = tab_id
    return await connection_manager.send_command_and_wait(
        device_id, command, timeout=timeout,
    )

