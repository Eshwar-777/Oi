from __future__ import annotations

import json
from typing import Any

from oi_agent.services.tools.base import ToolContext
from oi_agent.services.tools.navigator.command_client import send_extension_command


def _tokenize(text: str) -> set[str]:
    """Split text into lowercase word tokens, filtering noise."""
    import re
    return {w for w in re.split(r"[\s\-_./]+", text.lower()) if len(w) > 1}


def pick_adaptive_click_candidate(
    elements: Any,
    *,
    failed_step: dict[str, Any],
    viewport: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Pick the best matching visible element and return a coordinate click target.

    Scoring is fully dynamic — it computes word-overlap between the failed
    step's description/target and each candidate element's semantic attributes
    (text, ariaLabel, placeholder, name, id, title, alt, role).  No site-
    specific keywords are used.
    """
    if not isinstance(elements, list):
        return None

    description = str(failed_step.get("description", "")).lower()
    target_text = str(failed_step.get("target", "")).lower()
    intent_tokens = _tokenize(f"{description} {target_text}")
    if not intent_tokens:
        return None

    _SEMANTIC_KEYS = ("text", "ariaLabel", "placeholder", "name", "id", "title", "alt", "role")

    viewport_w = 0.0
    viewport_h = 0.0
    if isinstance(viewport, dict):
        try:
            viewport_w = float(viewport.get("w", 0) or 0)
            viewport_h = float(viewport.get("h", 0) or 0)
        except Exception:
            viewport_w = 0.0
            viewport_h = 0.0

    def visible_el(el: Any) -> bool:
        if not (isinstance(el, dict) and bool(el.get("visible")) and isinstance(el.get("rect"), dict)):
            return False
        rect = el.get("rect", {})
        try:
            x = float(rect.get("x", 0))
            y = float(rect.get("y", 0))
            w = float(rect.get("w", 0))
            h = float(rect.get("h", 0))
        except Exception:
            return False
        # Ignore invalid/off-screen coordinates to avoid impossible coordinate clicks.
        if w <= 0 or h <= 0:
            return False
        if x < 0 or y < 0:
            return False
        if x > 5000 or y > 5000:
            return False
        if viewport_w > 0 and viewport_h > 0:
            cx = x + (w / 2.0)
            cy = y + (h / 2.0)
            # Keep candidates inside current viewport; coords are viewport-relative.
            if cx < 0 or cx > viewport_w or cy < 0 or cy > viewport_h:
                return False
        return True

    candidates = [el for el in elements if visible_el(el)]
    if not candidates:
        return None

    ranked: list[tuple[float, float, float, dict[str, Any]]] = []
    for el in candidates:
        # Build a combined text blob for this element from all semantic keys
        blob = " ".join(str(el.get(k, "") or "") for k in _SEMANTIC_KEYS)
        el_tokens = _tokenize(blob)

        # Core score: fraction of intent tokens that appear in the element
        overlap = intent_tokens & el_tokens
        score = len(overlap) / len(intent_tokens) if intent_tokens else 0.0

        # Boost interactive element types (buttons, links)
        el_type = str(el.get("type", "")).lower()
        el_role = str(el.get("role", "")).lower()
        if el_type in ("button", "a") or el_role in ("button", "link"):
            score += 0.15

        rect = el.get("rect", {})
        y = float(rect.get("y", 0))
        x = float(rect.get("x", 0))
        ranked.append((score, y, x, el))

    # Sort by score (highest first), then topmost on page, then leftmost
    ranked.sort(key=lambda t: (-t[0], t[1], t[2]))
    best_score, _, _, best = ranked[0]

    # Require at least some overlap to avoid random clicks
    if best_score < 0.1:
        return None

    rect = best.get("rect", {})
    cx = float(rect.get("x", 0)) + max(1.0, float(rect.get("w", 1)) / 2)
    cy = float(rect.get("y", 0)) + max(1.0, float(rect.get("h", 1)) / 2)
    return {"by": "coords", "x": round(cx), "y": round(cy)}


async def attempt_adaptive_recovery(
    *,
    connection_manager: Any,
    device_id: str,
    context: ToolContext,
    run_id: str,
    failed_step: dict[str, Any],
    step_index: int,
    total_steps: int,
) -> dict[str, Any] | None:
    """Try to recover a failed interaction step by inspecting interactive elements.

    Supports click, type, hover, and select actions. For type/select, the
    recovery first clicks the best-matching element to focus it, then retries
    the original action with an empty target (focused element).
    """
    action = failed_step.get("action", "")
    if action not in ("click", "type", "hover", "select"):
        return None

    tab_id = context.action_config.get("tab_id")

    # 1) Extract all interactive elements from the current page
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
        viewport=parsed.get("viewport") if isinstance(parsed, dict) else None,
    )
    if candidate is None:
        return None

    if action == "click":
        # 2a) For click: just click the candidate directly
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

    # 2b) For type/select/hover: click candidate to focus, then retry action on same candidate
    focus_result = await send_extension_command(
        connection_manager=connection_manager,
        device_id=device_id,
        run_id=run_id,
        action="click",
        target=candidate,
        value="",
        step_index=step_index,
        step_label=f"adaptive-focus-{failed_step.get('description', '')}",
        total_steps=total_steps,
        timeout=30.0,
        tab_id=tab_id,
    )
    if focus_result.get("status") == "error":
        return None

    # Retry the original action with empty target (use focused element)
    return await send_extension_command(
        connection_manager=connection_manager,
        device_id=device_id,
        run_id=run_id,
        action=action,
        target=candidate,
        value=failed_step.get("value", ""),
        step_index=step_index,
        step_label=f"adaptive-{action}-{failed_step.get('description', '')}",
        total_steps=total_steps,
        timeout=30.0,
        tab_id=tab_id,
    )


# Backward-compatible alias
attempt_adaptive_click_recovery = attempt_adaptive_recovery
