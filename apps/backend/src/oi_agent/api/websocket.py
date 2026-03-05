from __future__ import annotations

import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from oi_agent.api.websocket_auth import authenticate_websocket
from oi_agent.api.websocket_connection_manager import ConnectionManager
from oi_agent.api.websocket_frames import handle_ws_frame

ws_router = APIRouter()
connection_manager = ConnectionManager()


@ws_router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    auth_context = await authenticate_websocket(websocket)
    if auth_context is None:
        return
    _, device_id = auth_context
    await connection_manager.connect(device_id, websocket)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                frame = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "detail": "Invalid JSON"})
                continue
            await handle_ws_frame(websocket, device_id, frame, connection_manager)
    except WebSocketDisconnect:
        connection_manager.disconnect(device_id)
