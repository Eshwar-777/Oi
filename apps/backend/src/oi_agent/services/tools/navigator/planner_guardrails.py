from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

SAFE_ESCALATION_MESSAGES = {
    "no_interactive_steps": "Need a clearer actionable step from the current UI before proceeding.",
    "interactive_steps_not_deterministic": "The current UI does not expose a deterministic action yet.",
    "interactive_steps_require_ref_after_snapshot": "The page already has refs, but the action is not grounded to one of them.",
    "insufficient_live_ui_evidence": "The current page does not provide enough live evidence to automate safely.",
    "no_verifiable_entity_activation_path": "The target entity is visible, but it has not been opened into an active context yet.",
    "unknown_ui_needs_disambiguation": "This appears to be an unknown or weakly-labeled UI and needs stronger disambiguation first.",
}

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


def _is_interactive_action(action: str) -> bool:
    return action in {"click", "type", "hover", "select", "upload", "act", "press", "keyboard"}


def _is_target_bound_interactive_action(action: str) -> bool:
    return action in {"click", "type", "hover", "select", "upload", "act"}


def _prompt_is_interactive(prompt: str) -> bool:
    p = prompt.lower()
    keys = (
        "click", "open", "play", "watch", "listen", "search", "type", "fill",
        "select", "send", "message", "submit", "create", "book", "order",
    )
    return any(k in p for k in keys)


def _has_interactive_step(steps: list[dict[str, Any]]) -> bool:
    return any(
        s.get("type") == "browser" and _is_interactive_action(str(s.get("command", "")).lower())
        for s in steps
    )


def _has_navigation_step(steps: list[dict[str, Any]]) -> bool:
    return any(
        s.get("type") == "browser" and str(s.get("command", "")).strip().lower() in {"open", "navigate"}
        for s in steps
    )


def _is_email_intent(prompt: str) -> bool:
    p = prompt.lower()
    return ("email" in p or "gmail" in p or "mail" in p) and "send" in p


def safe_escalation_steps(reason: str) -> list[dict[str, Any]]:
    logger.warning("navigator_planner_safe_escalation", extra={"reason": reason})
    return [
        {
            "type": "browser",
            "command": "snapshot",
            "target": "",
            "description": "Capture latest page snapshot for deterministic targeting",
        },
        {
            "type": "browser",
            "command": "extract_structured",
            "target": "",
            "description": "Extract interactive structure for disambiguation",
        },
        {
            "type": "consult",
            "reason": reason,
            "description": SAFE_ESCALATION_MESSAGES.get(
                reason,
                "Need user help or refined plan due to ambiguous or unsafe targets.",
            ),
        },
    ]


def _is_deterministic_target(target: Any, *, disambiguation: dict[str, Any] | None = None) -> bool:
    if isinstance(target, dict):
        by = str(target.get("by", "")).strip().lower()
        if by == "coords":
            return False
        if by in {"testid", "label", "placeholder"}:
            return bool(str(target.get("value", "")).strip())
        if by == "css":
            return _is_safe_css(str(target.get("value", "")).strip())
        if by == "role":
            name = str(target.get("name", "")).strip()
            role = str(target.get("value", "")).strip()
            return bool(role and name and _disambiguation_is_strict(disambiguation))
        if by == "name":
            return bool(str(target.get("value", "")).strip() and _disambiguation_is_strict(disambiguation))
        if by == "text":
            return False
    if isinstance(target, str):
        if _normalize_ref(target):
            return True
        return _is_safe_css(target)
    return False


def _disambiguation_is_strict(disambiguation: dict[str, Any] | None) -> bool:
    d = disambiguation or {}
    max_matches = d.get("max_matches", 999)
    try:
        max_matches = int(max_matches)
    except Exception:
        return False
    return (
        max_matches == 1
        and bool(d.get("must_be_visible", False))
        and bool(d.get("must_be_enabled", False))
        and bool(d.get("prefer_topmost", False))
    )


def _is_deterministic_step(step: dict[str, Any]) -> bool:
    if step.get("type") != "browser":
        return False
    action = str(step.get("command", "")).strip().lower()
    if action == "act":
        return bool(_normalize_ref(step.get("ref")) and str(step.get("snapshot_id", "")).strip())
    if action in {"click", "type", "hover", "select", "upload"}:
        disambiguation = _normalize_disambiguation(step.get("disambiguation", {}))
        return _is_deterministic_target(step.get("target"), disambiguation=disambiguation)
    return action in {"navigate", "open", "wait", "snapshot", "extract_structured", "screenshot", "read_dom", "highlight", "media_state", "scroll", "keyboard", "press", "tab", "frame"}


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
        key = str(out.get("value", "")).strip()
        if key:
            key = KEYBOARD_CANONICAL.get(key.lower(), key)
        if key in SAFE_KEYBOARD_KEYS or len(key) == 1:
            out["value"] = key
        else:
            return None
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
        for step in guarded:
            action = str(step.get("command", "")).strip().lower()
            if _is_target_bound_interactive_action(action) and not _target_uses_ref(step.get("target")):
                return safe_escalation_steps("interactive_steps_require_ref_after_snapshot")

    interactive_prompt = _prompt_is_interactive(user_prompt)
    has_navigation_step = _has_navigation_step(guarded)
    if interactive_prompt and not _has_interactive_step(guarded) and not has_navigation_step:
        return safe_escalation_steps("no_interactive_steps")

    if interactive_prompt:
        has_snapshot = any(str(step.get("command", "")).strip().lower() == "snapshot" for step in guarded)
        if not has_snapshot and not has_navigation_step:
            guarded.insert(
                0,
                {
                    "type": "browser",
                    "command": "snapshot",
                    "description": "Capture the current interactive snapshot before acting",
                },
            )
        deterministic_interactions = [
            s for s in guarded
            if _is_interactive_action(str(s.get("command", "")).lower()) and _is_deterministic_step(s)
        ]
        if not deterministic_interactions and not has_navigation_step:
            return safe_escalation_steps("interactive_steps_not_deterministic")

    return guarded
