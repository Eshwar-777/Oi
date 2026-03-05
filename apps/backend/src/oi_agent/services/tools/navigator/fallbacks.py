from __future__ import annotations

import json
from typing import Any

from oi_agent.services.tools.base import ToolContext
from oi_agent.services.tools.navigator.command_client import send_extension_command


def pick_adaptive_click_candidate(
    elements: Any,
    *,
    failed_step: dict[str, Any],
) -> dict[str, Any] | None:
    """Pick a semantic element and convert it to coordinate click target."""
    if not isinstance(elements, list):
        return None

    description = str(failed_step.get("description", "")).lower()
    target = str(failed_step.get("target", "")).lower()
    intent = f"{description} {target}"

    def visible_el(el: Any) -> bool:
        return isinstance(el, dict) and bool(el.get("visible")) and isinstance(el.get("rect"), dict)

    candidates = [el for el in elements if visible_el(el)]
    if not candidates:
        return None

    def text_blob(el: dict[str, Any]) -> str:
        return " ".join(
            str(el.get(k, "") or "").lower()
            for k in ("text", "ariaLabel", "placeholder", "name", "id")
        )

    ranked: list[tuple[int, float, float, dict[str, Any]]] = []
    for el in candidates:
        blob = text_blob(el)
        rect = el.get("rect", {})
        x = float(rect.get("x", 0))
        y = float(rect.get("y", 0))
        score = 0
        if "play" in intent and ("play" in blob or "resume" in blob or "watch" in blob):
            score += 50
        if "first result" in intent or "first search result" in intent:
            score += 10
        if el.get("type") in ("button", "a"):
            score += 5
        ranked.append((score, y, x, el))

    ranked.sort(key=lambda t: (-t[0], t[1], t[2]))
    best = ranked[0][3] if ranked else None
    if not best:
        return None

    rect = best.get("rect", {})
    x = float(rect.get("x", 0)) + max(1.0, float(rect.get("w", 1)) / 2)
    y = float(rect.get("y", 0)) + max(1.0, float(rect.get("h", 1)) / 2)
    return {"by": "coords", "x": round(x), "y": round(y)}


async def attempt_adaptive_click_recovery(
    *,
    connection_manager: Any,
    device_id: str,
    context: ToolContext,
    run_id: str,
    failed_step: dict[str, Any],
    step_index: int,
    total_steps: int,
) -> dict[str, Any] | None:
    """Try to recover failed click steps by inspecting interactive elements."""
    tab_id = context.action_config.get("tab_id")
    extracted = await send_extension_command(
        connection_manager=connection_manager,
        device_id=device_id,
        run_id=run_id,
        action="extract_structured",
        target="",
        value="",
        step_index=step_index,
        step_label=f"adaptive-extract-{failed_step.get('description', '')}",
        total_steps=total_steps,
        timeout=30.0,
        tab_id=tab_id,
    )
    if extracted.get("status") == "error":
        return None

    data_raw = extracted.get("data", "")
    if not isinstance(data_raw, str):
        return None

    try:
        parsed = json.loads(data_raw)
    except Exception:
        return None

    candidate = pick_adaptive_click_candidate(
        parsed.get("elements", []),
        failed_step=failed_step,
    )
    if candidate is None:
        return None

    return await send_extension_command(
        connection_manager=connection_manager,
        device_id=device_id,
        run_id=run_id,
        action="click",
        target=candidate,
        value="",
        step_index=step_index,
        step_label=f"adaptive-click-{failed_step.get('description', '')}",
        total_steps=total_steps,
        timeout=30.0,
        tab_id=tab_id,
    )

