class InMemorySessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, list[str]] = {}

    def append(self, session_id: str, message: str) -> None:
        self._sessions.setdefault(session_id, []).append(message)

    def get(self, session_id: str) -> list[str]:
        return self._sessions.get(session_id, [])
