from __future__ import annotations

import json
import re
from typing import Any

from oi_agent.services.tools.base import ToolContext
from oi_agent.services.tools.navigator.command_client import send_extension_command


def _tokenize(text: str) -> set[str]:
    """Split text into lowercase word tokens, filtering noise."""
    return {w for w in re.split(r"[\s\-_./]+", text.lower()) if len(w) > 1}


RISKY_TERMS = {
    "delete", "remove", "pay", "purchase", "order", "transfer",
    "confirm", "submit", "buy", "checkout", "place order",
}
CLICK_ROLES = {"button", "link", "menuitem", "tab", "checkbox", "radio", "switch"}
TYPE_ROLES = {"textbox", "searchbox", "combobox"}
SELECT_ROLES = {"combobox", "listbox", "option"}


def _extract_target_semantics(target: Any) -> str:
    if isinstance(target, dict):
        parts = [
            str(target.get("by", "") or ""),
            str(target.get("value", "") or ""),
            str(target.get("name", "") or ""),
            str(target.get("role", "") or ""),
            str(target.get("ref", "") or ""),
        ]
        return " ".join(parts)
    return str(target or "")


def _is_visible_element(el: Any) -> bool:
    if not (isinstance(el, dict) and bool(el.get("visible"))):
        return False
    rect = el.get("rect", {})
    if not isinstance(rect, dict):
        return False
    try:
        return float(rect.get("w", 0)) > 0 and float(rect.get("h", 0)) > 0
    except Exception:
        return False


def _role_type_tag(el: dict[str, Any]) -> tuple[str, str, str]:
    role = str(el.get("role", "") or "").strip().lower()
    typ = str(el.get("type", "") or "").strip().lower()
    tag = str(el.get("tag", "") or "").strip().lower()
    return role, typ, tag


def _compatible_for_action(el: dict[str, Any], action: str) -> bool:
    role, typ, tag = _role_type_tag(el)
    if action in {"click", "hover"}:
        if role in CLICK_ROLES:
            return True
        if tag in {"button", "a"}:
            return True
        if tag == "input" and typ in {"button", "submit", "checkbox", "radio"}:
            return True
        return False
    if action == "type":
        if role in TYPE_ROLES:
            return True
        if tag in {"input", "textarea"}:
            return typ not in {"checkbox", "radio", "button", "submit", "file", "hidden"}
        return False
    if action == "select":
        if role in SELECT_ROLES:
            return True
        if tag == "select":
            return True
        return False
    return False


def _candidate_blob(el: dict[str, Any]) -> str:
    keys = ("text", "ariaLabel", "placeholder", "name", "id", "title", "alt", "role", "type", "tag")
    return " ".join(str(el.get(k, "") or "") for k in keys).strip()


def _target_from_element(el: dict[str, Any], action: str) -> dict[str, Any] | None:
    # Prefer stable identity.
    element_id = str(el.get("id", "") or "").strip()
    if element_id:
        safe_id = element_id.replace("\\", "\\\\").replace('"', '\\"')
        return {"by": "css", "value": f"#{safe_id}", "disambiguation": {"max_matches": 1, "must_be_visible": True, "must_be_enabled": True, "prefer_topmost": True}}
    aria = str(el.get("ariaLabel", "") or "").strip()
    if aria:
        return {"by": "label", "value": aria, "disambiguation": {"max_matches": 1, "must_be_visible": True, "must_be_enabled": True, "prefer_topmost": True}}
    name = str(el.get("name", "") or "").strip()
    if name and action in {"type", "select"}:
        return {"by": "name", "value": name, "disambiguation": {"max_matches": 1, "must_be_visible": True, "must_be_enabled": True, "prefer_topmost": True}}
    role, _, _ = _role_type_tag(el)
    text = str(el.get("text", "") or "").strip()
    label = aria or text or str(el.get("placeholder", "") or "").strip()
    if role and label:
        return {
            "by": "role",
            "value": role,
            "name": label,
            "disambiguation": {"max_matches": 1, "must_be_visible": True, "must_be_enabled": True, "prefer_topmost": True},
        }
    return None


def _looks_risky(el: dict[str, Any]) -> bool:
    blob = _candidate_blob(el).lower()
    return any(term in blob for term in RISKY_TERMS)


def pick_adaptive_target(
    elements: Any,
    *,
    failed_step: dict[str, Any],
) -> dict[str, Any] | None:
    """Pick a deterministic, stable target for recovery; never use coordinates."""
    if not isinstance(elements, list):
        return None
    action = str(failed_step.get("action", "")).strip().lower()
    if action not in {"click", "type", "hover", "select"}:
        return None
    failed_target = failed_step.get("target", {}) if isinstance(failed_step.get("target"), dict) else {}
    failed_target_role = str(failed_target.get("value", "") if str(failed_target.get("by", "")).lower() == "role" else "").strip().lower()
    failed_target_name = str(failed_target.get("name", "") or failed_target.get("value", "")).strip().lower()

    description = str(failed_step.get("description", "")).strip().lower()
    target_semantics = _extract_target_semantics(failed_step.get("target", "")).strip().lower()
    intent_tokens = _tokenize(f"{description} {target_semantics}")
    if not intent_tokens:
        return None

    candidates: list[tuple[float, int, dict[str, Any], dict[str, Any]]] = []
    for raw in elements:
        if not isinstance(raw, dict) or not _is_visible_element(raw):
            continue
        if not _compatible_for_action(raw, action):
            continue
        if _looks_risky(raw):
            continue

        target = _target_from_element(raw, action)
        if target is None:
            continue

        blob_tokens = _tokenize(_candidate_blob(raw))
        overlap = intent_tokens & blob_tokens
        overlap_count = len(overlap)
        if overlap_count < 2:
            continue
        score = overlap_count / max(1, len(intent_tokens))
        role, _, _ = _role_type_tag(raw)
        if failed_target_role and role == failed_target_role:
            score += 0.25
        if failed_target_name:
            blob_text = _candidate_blob(raw).lower()
            if failed_target_name == blob_text.strip():
                score += 0.35
            elif failed_target_name in blob_text:
                score += 0.2
        candidates.append((score, overlap_count, raw, target))

    if not candidates:
        return None
    candidates.sort(key=lambda row: (row[0], row[1]), reverse=True)
    best_score, _, _, best_target = candidates[0]
    second_score = candidates[1][0] if len(candidates) > 1 else 0.0

    # Confidence + margin gate to avoid accidental clicks.
    if best_score < 0.6:
        return None
    if len(candidates) > 1 and (best_score - second_score) < 0.15:
        return None
    return best_target


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
    """Try to recover a failed interaction step using stable deterministic targets."""
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

    candidate = pick_adaptive_target(
        parsed.get("elements", []),
        failed_step=failed_step,
    )
    if candidate is None:
        return None

    return await send_extension_command(
        connection_manager=connection_manager,
        device_id=device_id,
        run_id=run_id,
        action=action,
        target=candidate,
        value=failed_step.get("value", ""),
        step_index=step_index,
        step_label=f"adaptive-deterministic-{action}-{failed_step.get('description', '')}",
        total_steps=total_steps,
        timeout=30.0,
        tab_id=tab_id,
    )


# Backward-compatible alias
attempt_adaptive_click_recovery = attempt_adaptive_recovery
