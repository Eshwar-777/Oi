from __future__ import annotations

import asyncio
import base64
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from oi_agent.agents.converse.live_stream import GeminiLiveSession
from oi_agent.automation.models import ChatTurnRequest, ClientContext
from oi_agent.computer_use.models import ComputerUseExecuteRequest
from oi_agent.config import settings

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


@dataclass
class LiveSessionRecord:
    session_key: str
    user_id: str
    device_id: str
    live: GeminiLiveSession
    receiver_task: asyncio.Task[None]
    started_at: str
    conversation_id: str | None
    session_id: str | None
    automation_engine: str
    browser_target: str


class LiveSessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, LiveSessionRecord] = {}
        self._device_to_session: dict[str, str] = {}
        self._lock = asyncio.Lock()

    def session_key_for_device(self, device_id: str) -> str | None:
        return self._device_to_session.get(device_id)

    async def start_session(
        self,
        *,
        user_id: str,
        device_id: str,
        connection_manager: Any,
        requested_session_key: str | None = None,
        conversation_id: str | None = None,
        session_id: str | None = None,
        automation_engine: str = "agent_browser",
        browser_target: str = "auto",
    ) -> str:
        if not settings.enable_live_streaming:
            raise RuntimeError("Live streaming is disabled.")

        async with self._lock:
            existing_key = self._device_to_session.get(device_id)
            if existing_key and existing_key in self._sessions:
                return existing_key

            session_key = requested_session_key or f"live:{user_id}:{device_id}"
            live = GeminiLiveSession(session_key)
            await live.start()
            receiver_task = asyncio.create_task(
                self._pump_responses(
                    session_key=session_key,
                    user_id=user_id,
                    device_id=device_id,
                    live=live,
                    connection_manager=connection_manager,
                )
            )
            self._sessions[session_key] = LiveSessionRecord(
                session_key=session_key,
                user_id=user_id,
                device_id=device_id,
                live=live,
                receiver_task=receiver_task,
                started_at=_now_iso(),
                conversation_id=conversation_id,
                session_id=session_id,
                automation_engine=str(automation_engine or "agent_browser"),
                browser_target=str(browser_target or "auto"),
            )
            self._device_to_session[device_id] = session_key
            logger.info("Live session started: %s device=%s", session_key, device_id)
            return session_key

    async def stop_session(self, session_key: str) -> None:
        async with self._lock:
            record = self._sessions.pop(session_key, None)
            if record is None:
                return
            self._device_to_session.pop(record.device_id, None)

        record.receiver_task.cancel()
        try:
            await record.receiver_task
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.warning("Live session receiver ended with error: %s", session_key, exc_info=True)
        await record.live.close()
        logger.info("Live session stopped: %s device=%s", session_key, record.device_id)

    async def stop_session_for_device(self, device_id: str) -> None:
        session_key = self._device_to_session.get(device_id)
        if session_key:
            await self.stop_session(session_key)

    async def send_audio(
        self,
        *,
        device_id: str,
        audio_chunk: bytes,
        end_of_turn: bool = False,
    ) -> str:
        record = await self._require_session_for_device(device_id)
        await record.live.send_audio(audio_chunk, end_of_turn=end_of_turn)
        return record.session_key

    async def end_audio_turn(self, *, device_id: str) -> str:
        record = await self._require_session_for_device(device_id)
        await record.live.end_audio_turn()
        return record.session_key

    async def send_text(self, *, device_id: str, text: str) -> str:
        record = await self._require_session_for_device(device_id)
        await record.live.send_text(text)
        return record.session_key

    async def send_image(self, *, device_id: str, image_bytes: bytes, mime_type: str) -> str:
        record = await self._require_session_for_device(device_id)
        await record.live.send_image(image_bytes, mime_type=mime_type)
        return record.session_key

    async def _require_session_for_device(self, device_id: str) -> LiveSessionRecord:
        session_key = self._device_to_session.get(device_id)
        if not session_key:
            raise RuntimeError("No active live session for this device.")
        record = self._sessions.get(session_key)
        if record is None:
            self._device_to_session.pop(device_id, None)
            raise RuntimeError("Live session is no longer available.")
        return record

    async def _pump_responses(
        self,
        *,
        session_key: str,
        user_id: str,
        device_id: str,
        live: GeminiLiveSession,
        connection_manager: Any,
    ) -> None:
        try:
            while True:
                item = await live.receive()
                event_type = str(item.get("type", "") or "")
                if event_type == "end":
                    await connection_manager.send_to_device(
                        device_id,
                        {
                            "type": "voice_stream",
                            "payload": {
                                "event": "turn_complete",
                                "live_session_id": session_key,
                                "timestamp": _now_iso(),
                            },
                        },
                    )
                    continue
                if event_type == "audio":
                    data = item.get("data")
                    if isinstance(data, (bytes, bytearray)):
                        audio_b64 = base64.b64encode(bytes(data)).decode("ascii")
                    elif isinstance(data, str):
                        audio_b64 = data
                    else:
                        audio_b64 = ""
                    mime_type = str(item.get("mime_type", "audio/pcm") or "audio/pcm")
                    await connection_manager.send_to_device(
                        device_id,
                        {
                            "type": "voice_stream",
                            "payload": {
                                "event": "audio_output",
                                "live_session_id": session_key,
                                "audio_data": audio_b64,
                                "mime_type": mime_type,
                                "timestamp": _now_iso(),
                            },
                        },
                    )
                    continue
                if event_type == "tool_call":
                    current_record = await self._require_session_for_device(device_id)
                    responses = await self._handle_tool_calls(
                        record=current_record,
                        calls=list(item.get("calls", []) or []),
                        connection_manager=connection_manager,
                    )
                    if responses:
                        await live.send_tool_response(responses)
                    continue
                if event_type == "input_text":
                    text = str(item.get("data", "") or "").strip()
                    if text:
                        await connection_manager.send_to_device(
                            device_id,
                            {
                                "type": "voice_stream",
                                "payload": {
                                    "event": "input_transcript",
                                    "live_session_id": session_key,
                                    "text": text,
                                    "is_final": bool(item.get("is_final", False)),
                                    "timestamp": _now_iso(),
                                },
                            },
                        )
                    continue
                if event_type == "text":
                    text = str(item.get("data", "") or "").strip()
                    if text:
                        await connection_manager.send_to_device(
                            device_id,
                            {
                                "type": "voice_stream",
                                "payload": {
                                    "event": "text_output",
                                    "live_session_id": session_key,
                                    "text": text,
                                    "is_final": bool(item.get("is_final", False)),
                                    "timestamp": _now_iso(),
                                },
                            },
                        )
                    continue
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Live session receive loop failed: %s", session_key, exc_info=True)
            await connection_manager.send_to_device(
                device_id,
                {
                    "type": "voice_stream",
                    "payload": {
                        "event": "error",
                        "live_session_id": session_key,
                        "message": str(exc),
                        "timestamp": _now_iso(),
                    },
                },
            )
        finally:
            async with self._lock:
                current = self._sessions.get(session_key)
                if current is not None and current.device_id == device_id:
                    self._sessions.pop(session_key, None)
                    self._device_to_session.pop(device_id, None)

    async def _handle_tool_calls(
        self,
        *,
        record: LiveSessionRecord,
        calls: list[dict[str, Any]],
        connection_manager: Any,
    ) -> list[dict[str, Any]]:
        responses: list[dict[str, Any]] = []
        for call in calls:
            call_id = str(call.get("id", "") or "").strip()
            name = str(call.get("name", "") or "").strip()
            args = dict(call.get("args", {}) or {})
            if name != "oi_delegate_turn":
                responses.append(
                    {
                        "id": call_id or None,
                        "name": name or "unknown_tool",
                        "response": {
                            "ok": False,
                            "error": "Unsupported live tool call.",
                        },
                    }
                )
                continue

            request_text = str(args.get("request_text", "") or "").strip()
            if not request_text:
                responses.append(
                    {
                        "id": call_id or None,
                        "name": name,
                        "response": {
                            "ok": False,
                            "error": "request_text is required.",
                        },
                    }
                )
                continue

            if not record.session_id:
                responses.append(
                    {
                        "id": call_id or None,
                        "name": name,
                        "response": {
                            "ok": False,
                            "error": "No active conversation session is attached to this live session.",
                        },
                    }
                )
                continue

            try:
                if record.automation_engine == "computer_use":
                    from oi_agent.computer_use.service import handle_computer_use_request

                    result = await handle_computer_use_request(
                        ComputerUseExecuteRequest(
                            session_id=record.session_id,
                            conversation_id=record.conversation_id,
                            prompt=request_text,
                            client_context=ClientContext(
                                timezone="UTC",
                                locale="en-US",
                                device_id=record.device_id,
                                automation_engine="computer_use",
                                browser_target=record.browser_target,
                            ),
                        ),
                        record.user_id,
                    )
                else:
                    from oi_agent.automation.conversation_service import handle_chat_turn

                    request = ChatTurnRequest(
                        session_id=record.session_id,
                        conversation_id=record.conversation_id,
                        inputs=[{"type": "text", "text": request_text}],
                        client_context=ClientContext(
                            timezone="UTC",
                            locale="en-US",
                            device_id=record.device_id,
                            automation_engine="agent_browser",
                            browser_target=record.browser_target,
                        ),
                    )
                    result = await handle_chat_turn(request, record.user_id)
                if record.automation_engine == "computer_use":
                    record.conversation_id = result.conversation_id
                    assistant_text = result.assistant_text
                    run_id = result.run_id
                    schedule_count = len(result.schedule_ids)
                    conversation_id = result.conversation_id
                else:
                    record.conversation_id = result.conversation_meta.conversation_id
                    assistant_text = result.assistant_message.text
                    run_id = result.active_run.run_id if result.active_run else None
                    schedule_count = len(result.schedules or [])
                    conversation_id = result.conversation_meta.conversation_id
                await connection_manager.send_to_device(
                    record.device_id,
                    {
                        "type": "voice_stream",
                        "payload": {
                            "event": "tool_delegate_completed",
                            "live_session_id": record.session_key,
                            "assistant_text": assistant_text,
                            "conversation_id": conversation_id,
                            "run_id": run_id,
                            "timestamp": _now_iso(),
                        },
                    },
                )
                responses.append(
                    {
                        "id": call_id or None,
                        "name": name,
                        "response": {
                            "ok": True,
                            "assistant_text": assistant_text,
                            "conversation_id": conversation_id,
                            "run_id": run_id,
                            "schedule_count": schedule_count,
                        },
                    }
                )
            except Exception as exc:
                logger.warning("Live tool delegation failed: session=%s call=%s", record.session_key, name, exc_info=True)
                await connection_manager.send_to_device(
                    record.device_id,
                    {
                        "type": "voice_stream",
                        "payload": {
                            "event": "tool_delegate_failed",
                            "live_session_id": record.session_key,
                            "message": str(exc),
                            "timestamp": _now_iso(),
                        },
                    },
                )
                responses.append(
                    {
                        "id": call_id or None,
                        "name": name,
                        "response": {
                            "ok": False,
                            "error": str(exc),
                        },
                    }
                )
        return responses


live_session_manager = LiveSessionManager()
