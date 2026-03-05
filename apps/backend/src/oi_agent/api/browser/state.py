from __future__ import annotations

from typing import Any

PAUSED_RUN_TTL_SECONDS = 30 * 60
paused_navigator_runs: dict[str, dict[str, Any]] = {}
STREAM_MAX_SECONDS = 240.0
STREAM_MAX_PLANNER_SECONDS = 35.0
STREAM_MAX_COMMAND_SECONDS = 120.0
PASSIVE_BROWSER_ACTIONS = {
    "wait",
    "snapshot",
    "screenshot",
    "read_dom",
    "extract_structured",
    "highlight",
    "media_state",
}
