from __future__ import annotations

import asyncio
import json
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from oi_agent.api.live_sessions import live_session_manager
from oi_agent.api.websocket_auth import authenticate_runner_websocket, authenticate_websocket
from oi_agent.api.websocket_connection_manager import ConnectionManager
from oi_agent.api.websocket_frames import handle_ws_frame

ws_router = APIRouter()
connection_manager = ConnectionManager()
WS_RECV_IDLE_SECONDS = 25.0
WS_STALE_AFTER_SECONDS = 75.0
WS_MAX_FRAME_CHARS = 2_000_000


@ws_router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    auth_context = await authenticate_websocket(websocket)
    if auth_context is None:
        return
    user_id, device_id = auth_context
    await connection_manager.connect(device_id, user_id, websocket)

    try:
        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=WS_RECV_IDLE_SECONDS)
            except TimeoutError:
                idle_for = time.time() - connection_manager.get_last_seen(device_id)
                sent = await connection_manager.send_to_device(device_id, {"type": "ping"})
                if not sent or idle_for > WS_STALE_AFTER_SECONDS:
                    await websocket.close(code=1001)
                    break
                continue
            if len(raw) > WS_MAX_FRAME_CHARS:
                await websocket.send_json({"type": "error", "detail": "Frame too large"})
                continue
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "detail": "Invalid JSON"})
                continue
            if not isinstance(frame, dict):
                await websocket.send_json({"type": "error", "detail": "Frame must be a JSON object"})
                continue
            await handle_ws_frame(websocket, device_id, frame, connection_manager)
    except WebSocketDisconnect:
        pass
    finally:
        await live_session_manager.stop_session_for_device(device_id)
        connection_manager.disconnect(device_id)


@ws_router.websocket("/ws/runner")
async def runner_websocket_endpoint(websocket: WebSocket) -> None:
    auth_context = await authenticate_runner_websocket(websocket)
    if auth_context is None:
        return
    user_id, runner_id, session_id = auth_context
    await connection_manager.connect_runner(runner_id, user_id, websocket, session_id)
    if session_id:
        connection_manager.bind_runner_session(runner_id, session_id)

    try:
        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=WS_RECV_IDLE_SECONDS)
            except TimeoutError:
                idle_for = time.time() - connection_manager.get_last_seen(runner_id)
                sent = await connection_manager.send_to_runner(runner_id, {"type": "ping"})
                if not sent or idle_for > WS_STALE_AFTER_SECONDS:
                    await websocket.close(code=1001)
                    break
                continue
            if len(raw) > WS_MAX_FRAME_CHARS:
                await websocket.send_json({"type": "error", "detail": "Frame too large"})
                continue
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "detail": "Invalid JSON"})
                continue
            if not isinstance(frame, dict):
                await websocket.send_json({"type": "error", "detail": "Frame must be a JSON object"})
                continue
            await handle_ws_frame(websocket, runner_id, frame, connection_manager)
    except WebSocketDisconnect:
        pass
    finally:
        connection_manager.disconnect_runner(runner_id)
