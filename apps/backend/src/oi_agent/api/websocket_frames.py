from __future__ import annotations

import json
import logging
import hashlib
from typing import Any

from fastapi import WebSocket

from oi_agent.api.websocket_connection_manager import ConnectionManager

logger = logging.getLogger(__name__)


def _sanitize_extension_result_data(action: str, data: Any) -> Any:
    """Keep logs readable by removing large snapshot payloads."""
    action_lc = str(action or "").strip().lower()
    if action_lc not in {"snapshot", "extract_structured"}:
        return data

    if not isinstance(data, str):
        return "[omitted]"

    try:
        parsed = json.loads(data)
    except Exception:
        return "[omitted]"

    if not isinstance(parsed, dict):
        return "[omitted]"

    meta: dict[str, Any] = {
        "url": parsed.get("url", ""),
        "title": parsed.get("title", ""),
    }

    if action_lc == "snapshot":
        meta["refCount"] = parsed.get("refCount", 0)
        snapshot_text = str(parsed.get("snapshot", "") or "")
        meta["snapshotChars"] = len(snapshot_text)
        first_line = snapshot_text.strip().splitlines()[0] if snapshot_text.strip() else ""
        meta["snapshotRef"] = first_line[:120] if first_line else ""
        meta["snapshotHash"] = hashlib.sha1(snapshot_text.encode("utf-8")).hexdigest()[:12] if snapshot_text else ""
        return {"snapshot_meta": meta}

    # extract_structured
    elements = parsed.get("elements", [])
    meta["elementCount"] = len(elements) if isinstance(elements, list) else 0
    return {"extract_meta": meta}


async def handle_ws_frame(
    websocket: WebSocket,
    device_id: str,
    frame: dict[str, Any],
    connection_manager: ConnectionManager,
) -> None:
    frame_type = frame.get("type", "")

    if frame_type == "ping":
        await websocket.send_json({"type": "pong"})
        return

    if frame_type == "auth":
        await websocket.send_json({"type": "error", "detail": "Already authenticated"})
        return

    if frame_type == "voice_stream":
        await websocket.send_json(
            {
                "type": "voice_stream",
                "payload": {"message": "Voice streaming not yet implemented"},
            }
        )
        return

    if frame_type == "extension_result":
        payload = frame.get("payload", {})
        cmd_id = payload.get("cmd_id", "")
        action = payload.get("action", "")
        if cmd_id:
            connection_manager.resolve_pending_result(cmd_id, payload)
        logger.info(
            "extension_result",
            extra={
                "event": "extension_result",
                "device_id": device_id,
                "action": action,
                "status": payload.get("status", ""),
                "cmd_id": payload.get("cmd_id", ""),
                "run_id": payload.get("run_id", ""),
                "tab_id": payload.get("tab_id", ""),
                "data": _sanitize_extension_result_data(action, payload.get("data", "")),
            },
        )
        return

    if frame_type == "browser_frame":
        payload = frame.get("payload", {})
        run_id = payload.get("run_id", "")
        if run_id:
            await connection_manager.broadcast_browser_frame(run_id, frame)
        return

    if frame_type == "target_attached":
        payload = frame.get("payload", {})
        connection_manager.set_target_attached(
            device_id, payload if isinstance(payload, dict) else {}
        )
        await websocket.send_json({"type": "target_attached_ack"})
        return

    if frame_type == "target_detached":
        payload = frame.get("payload", {})
        raw_tab_id = payload.get("tab_id") if isinstance(payload, dict) else None
        tab_id = int(raw_tab_id) if raw_tab_id is not None else None
        connection_manager.set_target_detached(device_id, tab_id)
        await websocket.send_json({"type": "target_detached_ack"})
        return

    if frame_type == "browser_stream_subscribe":
        run_id = frame.get("payload", {}).get("run_id", "")
        if run_id:
            connection_manager.subscribe_browser_stream(device_id, run_id)
            await websocket.send_json(
                {
                    "type": "browser_stream_subscribe",
                    "payload": {"run_id": run_id, "status": "subscribed"},
                }
            )
        return

    if frame_type == "browser_stream_unsubscribe":
        run_id = frame.get("payload", {}).get("run_id", "")
        if run_id:
            connection_manager.unsubscribe_browser_stream(device_id, run_id)
        return

    if frame_type == "remote_input":
        payload = frame.get("payload", {})
        target_device = payload.get("target_device_id", "")
        if target_device:
            await connection_manager.send_to_device(target_device, frame)
        return

    await websocket.send_json(
        {"type": "error", "detail": f"Unknown frame type: {frame_type}"}
    )
