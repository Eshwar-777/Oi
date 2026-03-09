from __future__ import annotations

from fastapi import HTTPException

ACTION_ALLOWED_STATES: dict[str, set[str]] = {
    "pause": {"queued", "starting", "running", "retrying", "reconciling", "resuming"},
    "resume": {"paused", "waiting_for_user_action", "waiting_for_human", "human_controlling", "reconciling"},
    "stop": {
        "queued",
        "starting",
        "running",
        "paused",
        "retrying",
        "waiting_for_user_action",
        "waiting_for_human",
        "human_controlling",
        "reconciling",
        "resuming",
        "scheduled",
    },
    "retry": {"failed", "cancelled", "canceled", "expired", "timed_out"},
    "interrupt": {"queued", "starting", "running", "retrying", "reconciling", "resuming"},
    "approve_sensitive_action": {"waiting_for_human", "waiting_for_user_action", "reconciling"},
}

TERMINAL_STATES = {"completed", "succeeded", "cancelled", "canceled", "failed", "expired", "timed_out"}


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
