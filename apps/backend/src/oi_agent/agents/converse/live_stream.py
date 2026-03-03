from __future__ import annotations

import logging
from typing import Any

from oi_agent.config import settings

logger = logging.getLogger(__name__)


class GeminiLiveSession:
    """Manages a bidirectional audio/video session with Gemini Live API.

    This is used for real-time voice conversations where the user speaks
    and OI responds with audio in real-time, rather than request/response.
    """

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self._client: Any = None
        self._session: Any = None

    async def start(self) -> None:
        """Initialize the Gemini Live API session."""
        try:
            from google import genai

            self._client = genai.Client(
                vertexai=settings.google_genai_use_vertexai,
                project=settings.gcp_project,
                location=settings.gcp_location,
            )

            live_config = {
                "response_modalities": ["AUDIO", "TEXT"],
                "speech_config": {
                    "voice_config": {
                        "prebuilt_voice_config": {"voice_name": "Aoede"}
                    }
                },
            }

            self._session = await self._client.aio.live.connect(
                model=settings.gemini_live_model,
                config=live_config,
            )

            logger.info("Gemini Live session started: %s", self.session_id)

        except Exception as exc:
            logger.error("Failed to start Gemini Live session: %s", exc)
            raise RuntimeError(f"Gemini Live unavailable: {exc}") from exc

    async def send_audio(self, audio_chunk: bytes) -> None:
        """Send an audio chunk to the live session."""
        if self._session is None:
            raise RuntimeError("Session not started")

        await self._session.send(
            input={"data": audio_chunk, "mime_type": "audio/pcm"},
            end_of_turn=False,
        )

    async def send_text(self, text: str) -> None:
        """Send a text message to the live session."""
        if self._session is None:
            raise RuntimeError("Session not started")

        await self._session.send(input=text, end_of_turn=True)

    async def receive(self) -> dict[str, Any]:
        """Receive the next response chunk from the live session.

        Returns a dict with keys: type ("audio" or "text"), data.
        """
        if self._session is None:
            raise RuntimeError("Session not started")

        async for response in self._session.receive():
            server_content = getattr(response, "server_content", None)
            if server_content is None:
                continue

            parts = getattr(server_content, "model_turn", {})
            if not parts:
                continue

            for part in getattr(parts, "parts", []):
                if hasattr(part, "inline_data") and part.inline_data:
                    return {
                        "type": "audio",
                        "data": part.inline_data.data,
                        "mime_type": part.inline_data.mime_type,
                    }
                if hasattr(part, "text") and part.text:
                    return {"type": "text", "data": part.text}

        return {"type": "end", "data": None}

    async def close(self) -> None:
        """Close the live session."""
        if self._session is not None:
            try:
                await self._session.close()
            except Exception as exc:
                logger.warning("Error closing Gemini Live session: %s", exc)
            self._session = None
        logger.info("Gemini Live session closed: %s", self.session_id)
