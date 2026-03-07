from __future__ import annotations

from fastapi import HTTPException


ACTION_ALLOWED_STATES: dict[str, set[str]] = {
    "pause": {"queued", "running", "retrying"},
    "resume": {"paused", "waiting_for_user_action"},
    "stop": {"queued", "running", "paused", "retrying", "waiting_for_user_action", "scheduled"},
    "retry": {"failed", "cancelled", "expired"},
    "interrupt": {"queued", "running", "retrying"},
}

TERMINAL_STATES = {"completed", "cancelled", "failed", "expired"}


def ensure_action_allowed(current_state: str, action: str) -> None:
    allowed = ACTION_ALLOWED_STATES.get(action)
    if allowed is None:
        raise HTTPException(status_code=400, detail="Unsupported run action.")
    if current_state not in allowed:
        raise HTTPException(
            status_code=409,
            detail=f"Run action '{action}' is not allowed while state is '{current_state}'.",
        )


def is_terminal_state(state: str) -> bool:
    return state in TERMINAL_STATES
