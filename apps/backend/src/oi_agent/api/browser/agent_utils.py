from __future__ import annotations

import asyncio
import json
import time
import uuid
from datetime import datetime
from typing import Any

from oi_agent.api.browser.state import PAUSED_RUN_TTL_SECONDS, paused_navigator_runs


def is_retriable_error(error: str) -> bool:
    text = error.lower()
    retriable = (
        "not found",
        "not ready",
        "loading",
        "element not found",
        "unknown ref",
        "ref not found",
        "stale",
        "intercept",
        "not clickable",
        "not interactable",
        "obscured",
        "detached",
        "timeout waiting",
        "target not topmost",
    )
    return any(r in text for r in retriable)


def friendly_browser_error(
    connection_manager: Any,
    device_id: str,
    tab_id: int | None,
    raw_error: str,
) -> str:
    lower = raw_error.lower()
    if "requested tab" in lower or "tab not found" in lower or "stale targetid" in lower:
        tabs = connection_manager.get_attached_tabs(device_id)
        if not tabs:
            return "The target tab is no longer attached. Attach the tab via the Oi extension icon and retry."
        preview = ", ".join(
            f"{t.get('tab_id')}:{(str(t.get('title', '') or '')[:40] or 'untitled')}"
            for t in tabs[:6]
            if isinstance(t, dict)
        )
        if tab_id is not None:
            return f"Tab {tab_id} is stale or detached. Attached tabs now: {preview}. Refresh and retry."
        return f"Current tab target is stale. Attached tabs now: {preview}. Refresh and retry."
    return raw_error


def cleanup_paused_runs() -> None:
    now = time.time()
    expired = [
        token
        for token, entry in paused_navigator_runs.items()
        if now - float(entry.get("created_at", now)) > PAUSED_RUN_TTL_SECONDS
    ]
    for token in expired:
        paused_navigator_runs.pop(token, None)


def requires_user_intervention(step: dict[str, Any], raw_error: str) -> bool:
    action = str(step.get("action", "")).lower()
    if action not in {"click", "type", "hover", "select", "keyboard"}:
        return False
    lower = raw_error.lower()
    user_required_signals = (
        "manual intervention required",
        "security_gate",
        "system_permission",
        "security-verification",
        "permission-prompt",
        "captcha",
        "2fa",
        "otp",
        "credential",
        "login required",
        "payment",
        "purchase",
        "confirm payment",
    )
    return any(s in lower for s in user_required_signals)


def store_paused_run(
    *,
    user_id: str,
    prompt: str,
    device_id: str,
    tab_id: int | None,
    remaining_steps: list[dict[str, Any]],
) -> str:
    cleanup_paused_runs()
    token = f"resume-{str(uuid.uuid4())[:10]}"
    paused_navigator_runs[token] = {
        "created_at": time.time(),
        "user_id": user_id,
        "prompt": prompt,
        "device_id": device_id,
        "tab_id": tab_id,
        "remaining_steps": remaining_steps,
    }
    return token


def is_media_intent(prompt: str) -> bool:
    p = prompt.lower()
    return any(k in p for k in (" play ", "play ", "watch ", "listen ", "start playing"))


def is_interactive_intent(prompt: str) -> bool:
    p = prompt.lower()
    triggers = (
        "click",
        "open",
        "play",
        "watch",
        "listen",
        "submit",
        "search",
        "type",
        "fill",
        "select",
        "create",
        "send",
    )
    return any(t in p for t in triggers)


async def check_media_playing(
    *,
    connection_manager: Any,
    device_id: str,
    tab_id: int | None,
    run_id: str,
) -> tuple[bool, str]:
    async def _probe() -> tuple[bool, dict[str, Any], str]:
        cmd_id = str(uuid.uuid4())[:8]
        command: dict[str, Any] = {
            "type": "extension_command",
            "payload": {
                "cmd_id": cmd_id,
                "run_id": run_id,
                "action": "media_state",
                "target": "",
                "value": "",
            },
            "timestamp": datetime.utcnow().isoformat(),
        }
        if tab_id is not None:
            command["payload"]["tab_id"] = tab_id

        result = await connection_manager.send_command_and_wait(device_id, command, timeout=15.0)
        if result.get("status") == "error":
            return False, {}, str(result.get("data", "Could not verify playback state"))
        raw = result.get("data", "")
        try:
            parsed = json.loads(raw if isinstance(raw, str) else "{}")
        except Exception:
            return False, {}, "Could not parse playback state"
        return True, parsed if isinstance(parsed, dict) else {}, ""

    ok1, p1, err1 = await _probe()
    if not ok1:
        return False, err1
    await asyncio.sleep(1.2)
    ok2, p2, err2 = await _probe()
    if not ok2:
        return False, err2

    has_media = bool(p2.get("hasMedia"))
    media_count = int(p2.get("mediaCount", 0) or 0)
    playing_count1 = int(p1.get("playingCount", 0) or 0)
    playing_count2 = int(p2.get("playingCount", 0) or 0)
    t1 = float(p1.get("maxCurrentTime", 0) or 0)
    t2 = float(p2.get("maxCurrentTime", 0) or 0)
    progressed = (t2 - t1) > 0.15

    if not has_media or media_count <= 0:
        return False, "No media element detected after playback steps"
    if playing_count2 <= 0:
        return False, "Media elements exist but none are in active playing state"
    if not progressed:
        return False, "Media appears unpaused but playback time is not advancing"
    if playing_count1 <= 0 and playing_count2 > 0:
        return True, "Playback started after verification retry"
    return True, "Playback is active"
