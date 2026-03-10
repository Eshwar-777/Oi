from __future__ import annotations

import re
from typing import Any

PASS_THROUGH_ACTIONS = {
    "navigate",
    "open",
    "wait",
    "press",
    "keyboard",
    "screenshot",
    "read_dom",
    "extract_structured",
    "highlight",
    "snapshot",
    "media_state",
    "scroll",
    "click",
    "type",
    "hover",
    "select",
    "upload",
    "tab",
    "frame",
}

VALID_ACT_KINDS = {"click", "type", "hover", "select"}
SAFE_KEYBOARD_KEYS = {
    "Enter", "Tab", "Escape", "Backspace", "Delete",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", " ",
}
KEYBOARD_CANONICAL = {
    "enter": "Enter",
    "tab": "Tab",
    "escape": "Escape",
    "esc": "Escape",
    "backspace": "Backspace",
    "delete": "Delete",
    "arrowup": "ArrowUp",
    "arrowdown": "ArrowDown",
    "arrowleft": "ArrowLeft",
    "arrowright": "ArrowRight",
    "space": "Space",
}


def _normalize_ref(raw: Any) -> str | None:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    if text.startswith("@"):
        text = text[1:]
    if text.lower().startswith("ref="):
        text = text.split("=", 1)[1].strip()
    text = text.lower()
    if not re.fullmatch(r"e\d+", text):
        return None
    return text


def _is_safe_css(selector: str) -> bool:
    s = selector.strip()
    if not s:
        return False
    # Allowed stable forms only.
    if re.fullmatch(r"#[A-Za-z_][A-Za-z0-9_\-:.]*", s):
        return True
    if re.fullmatch(r'\[data-testid="[^"]+"\]', s):
        return True
    if re.fullmatch(r'\[aria-label="[^"]+"\]', s):
        return True
    if s in {"input[type=file]", 'input[type="file"]'}:
        return True
    if re.fullmatch(r'\[role="[^"]+"\]\[name="[^"]+"\]', s):
        return True
    return False


def _normalize_disambiguation(raw: Any) -> dict[str, Any]:
    data = raw if isinstance(raw, dict) else {}
    max_matches = data.get("max_matches", 1)
    try:
        max_matches = int(max_matches)
    except Exception:
        max_matches = 1
    max_matches = max(1, min(5, max_matches))
    return {
        "max_matches": max_matches,
        "must_be_visible": bool(data.get("must_be_visible", True)),
        "must_be_enabled": bool(data.get("must_be_enabled", True)),
        "prefer_topmost": bool(data.get("prefer_topmost", True)),
    }


def _inject_interactive_preconditions(step: dict[str, Any]) -> None:
    existing = step.get("preconditions", [])
    normalized: list[dict[str, Any]] = []
    if isinstance(existing, list):
        for item in existing:
            if isinstance(item, dict) and item.get("type"):
                normalized.append(item)
    required_types = {
        "no_security_gate",
        "no_blocker_or_resolved",
        "target_clickable",
    }
    existing_types = {str(i.get("type", "")).strip() for i in normalized}
    for rtype in required_types:
        if rtype not in existing_types:
            normalized.append({"type": rtype})
    step["preconditions"] = normalized


def _normalize_act_step(step: dict[str, Any]) -> dict[str, Any] | None:
    ref = _normalize_ref(step.get("ref"))
    kind = str(step.get("kind", "")).strip().lower()
    if not ref or kind not in VALID_ACT_KINDS:
        return None
    out: dict[str, Any] = {
        "type": "browser",
        "command": "act",
        "ref": ref,
        "kind": kind,
        "description": step.get("description", f"{kind} {ref}"),
    }
    snapshot_id = str(step.get("snapshot_id", "")).strip()
    if snapshot_id:
        out["snapshot_id"] = snapshot_id
    if kind in {"type", "select"}:
        out["value"] = step.get("value", "")
    _inject_interactive_preconditions(out)
    return out


def _normalize_interaction_target(target: Any) -> Any:
    """Normalize known target shapes without dropping interaction steps."""
    if isinstance(target, dict):
        by = str(target.get("by", "")).strip().lower()
        if by in {"css", "selector", "css selector"}:
            css = target.get("value") or target.get("selector")
            if isinstance(css, str) and _is_safe_css(css):
                return {"by": "css", "value": css.strip()}
            return None
        if by == "xpath":
            # Reject xpath for deterministic executor.
            return None
        if by in {"coords", "coordinate", "xy"}:
            # Planner should not drive interactions by raw coordinates.
            return None
        if by in {"testid", "label", "role", "name", "placeholder", "text", "css"}:
            out = dict(target)
            if by in {"text", "name", "placeholder", "label"}:
                val = str(out.get("value", "")).strip()
                if not val:
                    return None
                out["value"] = val
            if by == "css":
                val = str(out.get("value", "")).strip()
                if not _is_safe_css(val):
                    return None
                out["value"] = val
            return out
    if isinstance(target, str):
        s = target.strip()
        # Avoid raw xpath strings, which extension can't reliably resolve.
        if s.startswith("//") or s.startswith("./"):
            return None
        if _is_safe_css(s):
            return {"by": "css", "value": s}
        return s
    return target


def _is_target_bound_interactive_action(action: str) -> bool:
    return action in {"click", "type", "hover", "select", "upload", "act"}


def _target_uses_ref(target: Any) -> bool:
    if isinstance(target, str):
        return _normalize_ref(target) is not None
    if isinstance(target, dict):
        by = str(target.get("by", "")).strip().lower()
        if by == "ref":
            return _normalize_ref(target.get("value") or target.get("ref")) is not None
        if _normalize_ref(target.get("ref")) is not None:
            return True
    return False


def _normalize_action_params(step: dict[str, Any]) -> dict[str, Any] | None:
    action = str(step.get("command", "")).strip().lower()
    out = dict(step)
    if "command" not in out and action:
        out["command"] = action
    if action == "wait":
        value = out.get("value", 1200)
        try:
            ms = int(value)
        except Exception:
            ms = 1200
        out["value"] = max(100, min(30000, ms))
    elif action == "press":
        key = str(out.get("value", "")).strip()
        if key:
            key = KEYBOARD_CANONICAL.get(key.lower(), key)
        if key in SAFE_KEYBOARD_KEYS or len(key) == 1:
            out["value"] = key
        else:
            return None
    elif action == "keyboard":
        value = str(out.get("value", "")).strip()
        if not value:
            return None
        canonical = KEYBOARD_CANONICAL.get(value.lower(), value)
        if canonical in SAFE_KEYBOARD_KEYS or len(canonical) == 1:
            out["value"] = canonical
        else:
            # Allow focused-field text insertion for executor paths that support keyboard type.
            out["value"] = value
    elif action == "tab":
        value = str(out.get("value", "")).strip()
        if value:
            out["value"] = value
    elif action == "frame":
        target = out.get("target")
        value = str(out.get("value", "")).strip()
        if target in ("", None, {}) and value not in {"main"}:
            return None
    return out


def apply_flow_guardrails(
    *,
    steps: list[dict[str, Any]],
    user_prompt: str,
    current_url: str,
    has_snapshot: bool = False,
) -> list[dict[str, Any]]:
    """Determinism-first guardrails for planner output."""
    guarded: list[dict[str, Any]] = []

    for raw in steps:
        step = dict(raw)
        if step.get("type") != "browser":
            continue

        action = str(step.get("command", "")).strip().lower()
        if action == "act":
            normalized_act = _normalize_act_step(step)
            if normalized_act:
                step = {
                    "type": "browser",
                    "command": normalized_act["kind"],
                    "target": f"@{str(normalized_act['ref']).lstrip('@')}",
                    "description": normalized_act["description"],
                }
                if normalized_act.get("value", None) not in (None, ""):
                    step["value"] = normalized_act["value"]
                if normalized_act.get("snapshot_id"):
                    step["snapshot_id"] = normalized_act["snapshot_id"]
                action = str(step.get("command", "")).strip().lower()
            else:
                continue

        if action not in PASS_THROUGH_ACTIONS:
            continue

        # A targetless "type" step means "insert into the currently focused field".
        # Normalize that into keyboard text entry so it survives ref-centric guardrails.
        if action == "type" and step.get("target") in ("", None, {}) and step.get("value", None) not in (None, ""):
            step["command"] = "keyboard"
            step.pop("target", None)
            action = "keyboard"

        if _is_target_bound_interactive_action(action):
            step["target"] = _normalize_interaction_target(step.get("target"))
            if action != "act" and step.get("target") is None:
                continue
            if action in {"click", "type", "hover", "select", "upload"}:
                step["disambiguation"] = _normalize_disambiguation(step.get("disambiguation", {}))
                _inject_interactive_preconditions(step)

        normalized = _normalize_action_params(step)
        if normalized is None:
            continue
        guarded.append(normalized)

    if has_snapshot:
        guarded = [
            step
            for step in guarded
            if not (
                _is_target_bound_interactive_action(str(step.get("command", "")).strip().lower())
                and not _target_uses_ref(step.get("target"))
            )
        ]

    return guarded
