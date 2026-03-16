from __future__ import annotations

import uuid
from datetime import UTC, datetime

from oi_agent.automation.store import save_session_turn


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def publish_assistant_run_update(
    *,
    user_id: str,
    session_id: str,
    run_id: str,
    text: str,
    run_state: str,
) -> None:
    cleaned = str(text or "").strip()
    normalized_state = str(run_state or "").strip().lower()
    if not cleaned or normalized_state not in {"completed", "failed", "waiting_for_human"}:
        return

    turn_id = f"assistant-run:{run_id}:{normalized_state}:{uuid.uuid4()}"
    await save_session_turn(
        session_id,
        turn_id,
        {
            "turn_id": turn_id,
            "session_id": session_id,
            "user_id": user_id,
            "role": "assistant",
            "text": cleaned,
            "timestamp": _now_iso(),
            "metadata": {
                "source": "run_update",
                "run_id": run_id,
                "run_state": normalized_state,
            },
        },
    )
