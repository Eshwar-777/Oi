from __future__ import annotations

import base64
import hashlib
import json
import logging
from typing import Any

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect

from oi_agent.api.live_sessions import live_session_manager
from oi_agent.api.websocket_connection_manager import ConnectionManager
from oi_agent.config import settings

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


def _decode_audio_payload(data: Any) -> bytes:
    if not isinstance(data, str) or not data.strip():
        raise ValueError("audio_data is required")
    try:
        return base64.b64decode(data)
    except Exception as exc:
        raise ValueError("audio_data must be valid base64") from exc


def _decode_image_payload(data: Any) -> bytes:
    if not isinstance(data, str) or not data.strip():
        raise ValueError("image_data is required")
    try:
        return base64.b64decode(data)
    except Exception as exc:
        raise ValueError("image_data must be valid base64") from exc


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
        payload = frame.get("payload", {})
        if not isinstance(payload, dict):
            await websocket.send_json({"type": "error", "detail": "Invalid voice_stream payload"})
            return
        if not settings.enable_live_streaming:
            await websocket.send_json({"type": "error", "detail": "Live streaming is disabled"})
            return
        source_user = connection_manager.get_user_for_device(device_id)
        action = str(payload.get("event") or payload.get("action") or "").strip().lower()
        try:
            if action in {"start", "open"}:
                requested_session_key = str(payload.get("live_session_id", "") or "").strip() or None
                conversation_id = str(payload.get("conversation_id", "") or "").strip() or None
                session_id = str(payload.get("session_id", "") or "").strip() or None
                session_key = await live_session_manager.start_session(
                    user_id=source_user,
                    device_id=device_id,
                    connection_manager=connection_manager,
                    requested_session_key=requested_session_key,
                    conversation_id=conversation_id,
                    session_id=session_id,
                )
                await websocket.send_json(
                    {
                        "type": "voice_stream",
                        "payload": {
                            "event": "session_started",
                            "live_session_id": session_key,
                        },
                    }
                )
                return
            if action in {"stop", "close"}:
                session_key = live_session_manager.session_key_for_device(device_id)
                if session_key:
                    await live_session_manager.stop_session(session_key)
                await websocket.send_json(
                    {
                        "type": "voice_stream",
                        "payload": {
                            "event": "session_stopped",
                            "live_session_id": session_key,
                        },
                    }
                )
                return
            if action in {"audio_input", "chunk"}:
                audio_bytes = _decode_audio_payload(payload.get("audio_data"))
                session_key = await live_session_manager.send_audio(
                    device_id=device_id,
                    audio_chunk=audio_bytes,
                    end_of_turn=bool(payload.get("is_final", False)),
                )
                await websocket.send_json(
                    {
                        "type": "voice_stream",
                        "payload": {
                            "event": "audio_input_ack",
                            "live_session_id": session_key,
                            "bytes": len(audio_bytes),
                            "is_final": bool(payload.get("is_final", False)),
                        },
                    }
                )
                return
            if action in {"end_turn", "commit"}:
                session_key = await live_session_manager.end_audio_turn(device_id=device_id)
                await websocket.send_json(
                    {
                        "type": "voice_stream",
                        "payload": {
                            "event": "turn_committed",
                            "live_session_id": session_key,
                        },
                    }
                )
                return
            if action == "text_input":
                text = str(payload.get("text", "") or "").strip()
                if not text:
                    await websocket.send_json({"type": "error", "detail": "voice_stream text_input requires text"})
                    return
                session_key = await live_session_manager.send_text(device_id=device_id, text=text)
                await websocket.send_json(
                    {
                        "type": "voice_stream",
                        "payload": {
                            "event": "text_input_ack",
                            "live_session_id": session_key,
                        },
                    }
                )
                return
            if action == "image_input":
                image_bytes = _decode_image_payload(payload.get("image_data"))
                mime_type = str(payload.get("mime_type", "") or "image/jpeg").strip() or "image/jpeg"
                session_key = await live_session_manager.send_image(
                    device_id=device_id,
                    image_bytes=image_bytes,
                    mime_type=mime_type,
                )
                await websocket.send_json(
                    {
                        "type": "voice_stream",
                        "payload": {
                            "event": "image_input_ack",
                            "live_session_id": session_key,
                            "bytes": len(image_bytes),
                            "mime_type": mime_type,
                        },
                    }
                )
                return
            await websocket.send_json({"type": "error", "detail": f"Unknown voice_stream action: {action or 'missing'}"})
        except ValueError as exc:
            await websocket.send_json({"type": "error", "detail": str(exc)})
        except WebSocketDisconnect:
            return
        except RuntimeError as exc:
            if "close message has been sent" in str(exc).lower():
                return
            raise
        except Exception as exc:
            try:
                await websocket.send_json({"type": "error", "detail": str(exc)})
            except (WebSocketDisconnect, RuntimeError):
                return
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
