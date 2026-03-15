from __future__ import annotations

import logging
from typing import Any

from oi_agent.config import settings

logger = logging.getLogger(__name__)

_MODEL_AVAILABILITY_MARKERS = (
    "publisher model",
    "model not found",
    "not found",
    "unsupported model",
    "does not exist",
    "not available",
)


def _candidate_models() -> list[str]:
    raw_candidates = [settings.gemini_live_model, *settings.gemini_live_model_fallbacks.split(",")]
    candidates: list[str] = []
    for value in raw_candidates:
        candidate = str(value or "").strip()
        if candidate and candidate not in candidates:
            candidates.append(candidate)
    return candidates


def _is_model_availability_error(exc: Exception) -> bool:
    message = str(exc).strip().lower()
    return any(marker in message for marker in _MODEL_AVAILABILITY_MARKERS)


class GeminiLiveSession:
    """Manages a bidirectional audio/video session with Gemini Live API.

    This is used for real-time voice conversations where the user speaks
    and OI responds with audio in real-time, rather than request/response.
    """

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self._client: Any = None
        self._session_ctx: Any = None
        self._session: Any = None
        self.model_name: str | None = None

    async def start(self) -> None:
        """Initialize the Gemini Live API session."""
        try:
            from google import genai
            from google.genai import types

            self._client = genai.Client(
                vertexai=settings.google_genai_use_vertexai,
                project=settings.gcp_project,
                location=settings.gcp_location,
                api_key=None if settings.google_genai_use_vertexai else (settings.google_api_key or None),
            )

            live_config = types.LiveConnectConfig(
                response_modalities=["AUDIO"],
                speech_config={
                    "voice_config": {
                        "prebuilt_voice_config": {"voice_name": settings.gemini_live_voice_name}
                    }
                },
                input_audio_transcription={},
                output_audio_transcription={},
                system_instruction=(
                    "You are OI live mode. Keep casual voice replies natural. "
                    "When the user wants OI to execute, schedule, automate, or handle a concrete task, "
                    "call the oi_delegate_turn tool with the user's request instead of improvising task execution yourself."
                ),
                tools=[
                    types.Tool(
                        function_declarations=[
                            types.FunctionDeclaration(
                                name="oi_delegate_turn",
                                description=(
                                    "Delegate the user's actionable request into OI's task and scheduling pipeline. "
                                    "Use this for scheduling, browser work, operational tasks, or multi-step requests."
                                ),
                                parametersJsonSchema={
                                    "type": "object",
                                    "properties": {
                                        "request_text": {
                                            "type": "string",
                                            "description": "The user's request in plain text.",
                                        },
                                    },
                                    "required": ["request_text"],
                                },
                            ),
                        ]
                    )
                ],
            )

            last_error: Exception | None = None
            for model_name in _candidate_models():
                try:
                    self._session_ctx = self._client.aio.live.connect(
                        model=model_name,
                        config=live_config,
                    )
                    self._session = await self._session_ctx.__aenter__()
                    self.model_name = model_name
                    logger.info("Gemini Live session started: %s model=%s", self.session_id, model_name)
                    return
                except Exception as exc:
                    last_error = exc
                    self._session = None
                    self._session_ctx = None
                    if _is_model_availability_error(exc):
                        logger.warning(
                            "Gemini Live model unavailable, trying fallback: session=%s model=%s error=%s",
                            self.session_id,
                            model_name,
                            exc,
                        )
                        continue
                    raise

            if last_error is not None:
                raise last_error
            raise RuntimeError("Gemini Live could not find a usable model configuration.")

        except Exception as exc:
            logger.error("Failed to start Gemini Live session: %s", exc)
            raise RuntimeError(f"Gemini Live unavailable: {exc}") from exc

    async def send_audio(self, audio_chunk: bytes, end_of_turn: bool = False) -> None:
        """Send an audio chunk to the live session."""
        if self._session is None:
            raise RuntimeError("Session not started")

        await self._session.send_realtime_input(
            audio={"data": audio_chunk, "mime_type": "audio/pcm;rate=16000"},
        )
        if end_of_turn:
            await self.end_audio_turn()

    async def end_audio_turn(self) -> None:
        """Mark the current audio turn as finished."""
        if self._session is None:
            raise RuntimeError("Session not started")

        await self._session.send_realtime_input(audio_stream_end=True)

    async def send_text(self, text: str) -> None:
        """Send a text message to the live session."""
        if self._session is None:
            raise RuntimeError("Session not started")

        await self._session.send_realtime_input(text=text)

    async def send_image(self, image_bytes: bytes, *, mime_type: str) -> None:
        """Send an image frame to the live session."""
        if self._session is None:
            raise RuntimeError("Session not started")

        await self._session.send_realtime_input(
            media={"data": image_bytes, "mime_type": mime_type},
        )

    async def send_tool_response(self, responses: list[dict[str, Any]]) -> None:
        if self._session is None:
            raise RuntimeError("Session not started")

        await self._session.send_tool_response(function_responses=responses)

    async def receive(self) -> dict[str, Any]:
        """Receive the next response chunk from the live session.

        Returns a dict with keys: type ("audio" or "text"), data.
        """
        if self._session is None:
            raise RuntimeError("Session not started")

        async for response in self._session.receive():
            tool_call = getattr(response, "tool_call", None)
            if tool_call is not None:
                function_calls = list(getattr(tool_call, "function_calls", []) or [])
                if function_calls:
                    return {
                        "type": "tool_call",
                        "calls": [
                            {
                                "id": str(getattr(call, "id", "") or ""),
                                "name": str(getattr(call, "name", "") or ""),
                                "args": dict(getattr(call, "args", {}) or {}),
                            }
                            for call in function_calls
                        ],
                    }

            server_content = getattr(response, "server_content", None)
            if server_content is not None:
                input_transcription = getattr(server_content, "input_transcription", None)
                if input_transcription and getattr(input_transcription, "text", None):
                    return {
                        "type": "input_text",
                        "data": input_transcription.text,
                        "is_final": bool(getattr(input_transcription, "finished", False)),
                    }

                output_transcription = getattr(server_content, "output_transcription", None)
                if output_transcription and getattr(output_transcription, "text", None):
                    return {
                        "type": "text",
                        "data": output_transcription.text,
                        "is_final": bool(getattr(output_transcription, "finished", False)),
                    }

                parts = getattr(server_content, "model_turn", None)
                if parts:
                    for part in getattr(parts, "parts", []):
                        if hasattr(part, "inline_data") and part.inline_data:
                            return {
                                "type": "audio",
                                "data": part.inline_data.data,
                                "mime_type": part.inline_data.mime_type,
                            }
                        if hasattr(part, "text") and part.text:
                            return {"type": "text", "data": part.text}

                if bool(getattr(server_content, "turn_complete", False)):
                    return {"type": "end", "data": None}

        return {"type": "end", "data": None}

    async def close(self) -> None:
        """Close the live session."""
        if self._session is not None:
            try:
                if self._session_ctx is not None:
                    await self._session_ctx.__aexit__(None, None, None)
                else:
                    await self._session.close()
            except Exception as exc:
                logger.warning("Error closing Gemini Live session: %s", exc)
            self._session = None
            self._session_ctx = None
        logger.info("Gemini Live session closed: %s", self.session_id)
