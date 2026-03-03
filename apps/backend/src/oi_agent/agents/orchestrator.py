from __future__ import annotations

from oi_agent.agents.converse import ConverseChatbot


class AgentOrchestrator:
    """Routes user messages to the appropriate agent system.

    System A (Converse): standalone chatbot for conversation, Q&A, multimodal.
    System B (Task Graph): LangGraph state machine for Curate/Companion/Consult.

    The orchestrator inspects the message to decide which system handles it.
    For now, all messages go to Converse. Task routing is added in Phase 3.
    """

    def __init__(self) -> None:
        self._converse = ConverseChatbot()

    async def handle(self, user_id: str, session_id: str, message: str) -> str:
        """Route a user message and return the response."""
        return await self._converse.chat(
            user_id=user_id,
            session_id=session_id,
            message=message,
        )
