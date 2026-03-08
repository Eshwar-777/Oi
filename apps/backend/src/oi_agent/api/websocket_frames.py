from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from fastapi import WebSocket

from oi_agent.api.websocket_connection_manager import ConnectionManager

logger = logging.getLogger(__name__)


def _sanitize_extension_result_data(action: str, data: Any) -> Any:
    """Keep logs readable by removing large snapshot payloads."""
    action_lc = str(action or "").strip().lower()
    if action_lc == "screenshot":
        if isinstance(data, str) and data.startswith("data:image/"):
            return {"screenshot_meta": {"present": True, "chars": len(data)}}
        return {"screenshot_meta": {"present": False}}

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
        meta["snapshotHash"] = hashlib.sha1(snapshot_text.encode("utf-8")).hexdigest()[:12] if snapshot_text else ""
        return {"snapshot_meta": meta}

    # extract_structured
    elements = parsed.get("elements", [])
    meta["elementCount"] = len(elements) if isinstance(elements, list) else 0
    return {"extract_meta": meta}


def _valid_extension_result_payload(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    cmd_id = payload.get("cmd_id")
    status = payload.get("status")
    action = payload.get("action")
    return (
        isinstance(cmd_id, str)
        and bool(cmd_id.strip())
        and isinstance(status, str)
        and isinstance(action, str)
    )


def _valid_browser_stream_payload(payload: Any) -> bool:
    return isinstance(payload, dict) and isinstance(payload.get("run_id"), str) and bool(str(payload.get("run_id")).strip())


def _valid_session_stream_payload(payload: Any) -> bool:
    return isinstance(payload, dict) and isinstance(payload.get("session_id"), str) and bool(str(payload.get("session_id")).strip())


async def handle_ws_frame(
    websocket: WebSocket,
    device_id: str,
    frame: dict[str, Any],
    connection_manager: ConnectionManager,
) -> None:
    frame_type = frame.get("type", "")
    if not isinstance(frame_type, str) or not frame_type:
        await websocket.send_json({"type": "error", "detail": "Frame type is required"})
        return

    connection_manager.touch_device(device_id)

    if frame_type == "ping":
        await websocket.send_json({"type": "pong"})
        return
    if frame_type == "pong":
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
        if not _valid_extension_result_payload(payload):
            await websocket.send_json({"type": "error", "detail": "Invalid extension_result payload"})
            return
        cmd_id = payload.get("cmd_id", "")
        action = payload.get("action", "")
        connection_manager.resolve_pending_result(device_id, cmd_id, payload)
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
        if not _valid_browser_stream_payload(payload):
            await websocket.send_json({"type": "error", "detail": "Invalid browser_frame payload"})
            return
        run_id = str(payload.get("run_id", "")).strip()
        connection_manager.set_run_owner(run_id, device_id)
        await connection_manager.broadcast_browser_frame(run_id, frame)
        return

    if frame_type == "session_frame":
        payload = frame.get("payload", {})
        if not _valid_session_stream_payload(payload):
            await websocket.send_json({"type": "error", "detail": "Invalid session_frame payload"})
            return
        session_id = str(payload.get("session_id", "")).strip()
        await connection_manager.broadcast_session_frame(session_id, frame)
        return

    if frame_type == "session_event":
        payload = frame.get("payload", {})
        if not _valid_session_stream_payload(payload):
            await websocket.send_json({"type": "error", "detail": "Invalid session_event payload"})
            return
        session_id = str(payload.get("session_id", "")).strip()
        await connection_manager.broadcast_session_frame(session_id, frame)
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
        payload = frame.get("payload", {})
        run_id = str((payload or {}).get("run_id", "")).strip()
        if run_id:
            allowed = connection_manager.subscribe_browser_stream(device_id, run_id)
            if not allowed:
                await websocket.send_json(
                    {
                        "type": "browser_stream_subscribe",
                        "payload": {"run_id": run_id, "status": "forbidden"},
                    }
                )
                return
            await websocket.send_json(
                {
                    "type": "browser_stream_subscribe",
                    "payload": {"run_id": run_id, "status": "subscribed"},
                }
            )
        return

    if frame_type == "session_stream_subscribe":
        payload = frame.get("payload", {})
        session_id = str((payload or {}).get("session_id", "")).strip()
        if session_id:
            allowed = connection_manager.subscribe_session_stream(device_id, session_id)
            if not allowed:
                await websocket.send_json(
                    {
                        "type": "session_stream_subscribe",
                        "payload": {"session_id": session_id, "status": "forbidden"},
                    }
                )
                return
            await websocket.send_json(
                {
                    "type": "session_stream_subscribe",
                    "payload": {"session_id": session_id, "status": "subscribed"},
                }
            )
        return

    if frame_type == "session_stream_unsubscribe":
        session_id = frame.get("payload", {}).get("session_id", "")
        if session_id:
            connection_manager.unsubscribe_session_stream(device_id, str(session_id))
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
            source_user = connection_manager.get_user_for_device(device_id)
            target_user = connection_manager.get_user_for_device(str(target_device))
            if source_user and target_user and source_user != target_user:
                await websocket.send_json({"type": "error", "detail": "remote_input target forbidden"})
                return
            await connection_manager.send_to_device(target_device, frame)
        return

    if frame_type == "session_control":
        payload = frame.get("payload", {})
        session_id = str((payload or {}).get("session_id", "")).strip()
        if not session_id:
            await websocket.send_json({"type": "error", "detail": "session_control requires session_id"})
            return
        runner_id = connection_manager.get_runner_for_session(session_id)
        if not runner_id:
            await websocket.send_json({"type": "error", "detail": "No runner connected for session"})
            return
        source_user = connection_manager.get_user_for_device(device_id)
        target_user = connection_manager.get_user_for_device(runner_id)
        if source_user and target_user and source_user != target_user:
            await websocket.send_json({"type": "error", "detail": "session_control target forbidden"})
            return
        await connection_manager.send_to_runner(runner_id, frame)
        return

    await websocket.send_json(
        {"type": "error", "detail": f"Unknown frame type: {frame_type}"}
    )
