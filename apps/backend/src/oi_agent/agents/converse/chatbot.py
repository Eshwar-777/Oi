from __future__ import annotations

from typing import Any

from oi_agent.config import settings


class ConverseChatbot:
    """Multimodal chatbot powered by Google ADK Runner.

    Handles text, image, and document inputs through the Converse system.
    For voice and live streaming, see live_stream.py.
    """

    def __init__(self) -> None:
        self._ready = False
        self._known_sessions: set[tuple[str, str]] = set()
        self._agent: Any | None = None
        self._runner: Any | None = None
        self._session_service: Any | None = None
        self._types: Any | None = None

    def _ensure_ready(self) -> None:
        if self._ready:
            return

        self._validate_auth_config()

        try:
            from google.adk.agents import Agent
            from google.adk.runners import Runner
            from google.adk.sessions import InMemorySessionService
            from google.genai import types
        except Exception as exc:
            raise RuntimeError(
                "Google ADK SDK is not available. Install dependencies from requirements.txt"
            ) from exc

        self._session_service = InMemorySessionService()
        self._agent = Agent(
            name="oi_converse_agent",
            model=settings.gemini_model,
            description="OI Converse -- multimodal chatbot",
            instruction=(
                "You are OI, a helpful and friendly AI assistant. "
                "You can understand text, images, and documents. "
                "Be concise but thorough. "
                "When the user describes a task they want automated, "
                "respond with: I'll help you set that up as a task. "
                "Ask clarifying questions when requirements are ambiguous."
            ),
        )
        self._runner = Runner(
            app_name=settings.adk_app_name,
            agent=self._agent,
            session_service=self._session_service,
        )
        self._types = types
        self._ready = True

    def _validate_auth_config(self) -> None:
        if not settings.google_genai_use_vertexai:
            raise RuntimeError("ADC mode requires GOOGLE_GENAI_USE_VERTEXAI=true in .env.")
        if not settings.gcp_project.strip():
            raise RuntimeError("ADC mode requires GOOGLE_CLOUD_PROJECT in .env.")

    async def chat(self, user_id: str, session_id: str, message: str) -> str:
        """Send a text message and return the assistant's response."""
        self._ensure_ready()
        assert self._session_service is not None
        assert self._runner is not None
        assert self._types is not None

        session_key = (user_id, session_id)
        if session_key not in self._known_sessions:
            await self._session_service.create_session(
                app_name=settings.adk_app_name,
                user_id=user_id,
                session_id=session_id,
            )
            self._known_sessions.add(session_key)

        content = self._types.Content(
            role="user",
            parts=[self._types.Part(text=message)],
        )

        final_text = ""
        async for event in self._runner.run_async(
            user_id=user_id,
            session_id=session_id,
            new_message=content,
        ):
            text = _extract_text_from_event(event)
            if text:
                final_text = text

        return final_text or "I could not produce a response. Please try again."


def _extract_text_from_event(event: Any) -> str:
    """Pull text fragments from an ADK runner event."""
    content = getattr(event, "content", None)
    if content is None:
        return ""

    parts = getattr(content, "parts", None)
    if not parts:
        return ""

    fragments: list[str] = []
    for part in parts:
        text = getattr(part, "text", None)
        if text:
            fragments.append(text)

    return "\n".join(fragments).strip()
