from __future__ import annotations

from typing import Any

PAUSED_RUN_TTL_SECONDS = 30 * 60
paused_navigator_runs: dict[str, dict[str, Any]] = {}
PLAN_CACHE_TTL_SECONDS = 15 * 60
navigator_plan_cache: dict[str, dict[str, Any]] = {}
STREAM_MAX_SECONDS = 240.0
STREAM_MAX_PLANNER_SECONDS = 35.0
STREAM_MAX_COMMAND_SECONDS = 120.0
SNAPSHOT_FETCH_TIMEOUT_SECONDS = 20.0
STRUCTURED_FETCH_TIMEOUT_SECONDS = 20.0
STREAM_MAX_REPAIR_ROUNDS = 2
ENABLE_ADAPTIVE_RECOVERY = True
PASSIVE_BROWSER_ACTIONS = {
    "wait",
    "snapshot",
    "screenshot",
    "read_dom",
    "extract_structured",
    "highlight",
    "media_state",
}
