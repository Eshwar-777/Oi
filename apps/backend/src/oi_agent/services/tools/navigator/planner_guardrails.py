from __future__ import annotations

import re
from typing import Any


PASS_THROUGH_ACTIONS = {
    "navigate",
    "wait",
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
        "action": "act",
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
    return action in {"click", "type", "hover", "select", "act"}


def _prompt_is_interactive(prompt: str) -> bool:
    p = prompt.lower()
    keys = (
        "click", "open", "play", "watch", "listen", "search", "type", "fill",
        "select", "send", "message", "submit", "create", "book", "order",
    )
    return any(k in p for k in keys)


def _has_interactive_step(steps: list[dict[str, Any]]) -> bool:
    return any(
        s.get("type") == "browser" and _is_interactive_action(str(s.get("action", "")).lower())
        for s in steps
    )


def _is_email_intent(prompt: str) -> bool:
    p = prompt.lower()
    return ("email" in p or "gmail" in p or "mail" in p) and "send" in p


def _safe_escalation_steps(reason: str) -> list[dict[str, Any]]:
    return [
        {
            "type": "browser",
            "action": "snapshot",
            "target": "",
            "description": "Capture latest page snapshot for deterministic targeting",
        },
        {
            "type": "browser",
            "action": "extract_structured",
            "target": "",
            "description": "Extract interactive structure for disambiguation",
        },
        {
            "type": "consult",
            "reason": reason,
            "description": "Need user help or refined plan due to ambiguous/unsafe targets.",
        },
    ]


def _extract_message_intent(prompt: str) -> tuple[str | None, str | None]:
    lower = prompt.lower()
    recipient = None
    message_text = None
    mq = re.search(r"send\s+(?:a\s+)?message\s+to\s+(?:contact\s+)?[\"']([^\"']+)[\"']", prompt, re.IGNORECASE)
    if mq:
        recipient = mq.group(1).strip().strip(" .,:;!?")
    m = re.search(r"send\s+(?:a\s+)?message\s+to\s+([a-z0-9 _.'-]+)", lower)
    if m and not recipient:
        candidate = m.group(1).strip()
        # Stop recipient capture at known clause boundaries.
        candidate = re.split(
            r"(?:\.\s*message\b|,\s*message\b|\s+message\s+content\b|\s+with\s+message\b|\s+saying\b|\n)",
            candidate,
            maxsplit=1,
        )[0].strip()
        # Strip medium/platform suffixes: "tortoise on whatsapp" -> "tortoise"
        candidate = re.sub(
            r"\s+on\s+(?:whatsapp|telegram|signal|slack|discord|teams|messenger|gmail|email|linkedin|x|twitter|instagram|facebook|youtube|netflix)\b.*$",
            "",
            candidate,
        ).strip()
        # Generic cleanup: "to tortoise in whatsapp" or trailing punctuation.
        candidate = re.sub(r"\s+(?:in|via)\s+[a-z0-9._-]+\b.*$", "", candidate).strip()
        candidate = re.sub(r"^(?:contact|chat|person|user|friend)\s+", "", candidate).strip()
        candidate = candidate.strip("'\"")
        candidate = candidate.strip(" .,:;!?")
        recipient = candidate or None
    m2 = re.search(r"(?:saying|message(?: is|:)?|text(?: is|:)?|send)\s+[\"']([^\"']+)[\"']", prompt, re.IGNORECASE)
    if m2:
        message_text = m2.group(1).strip()
    return recipient, message_text


def _sanitize_message_locator_target(target: Any, recipient: str) -> Any:
    """Normalize noisy message-intent click targets to recipient-only text."""
    if not recipient:
        return target

    def _normalize_text_value(text: str) -> str:
        value = text.strip()
        low = value.lower()
        noisy_signals = (
            "message content",
            "send any message",
            "any message you want",
            "contact ",
            "message:",
            "message is",
        )
        if any(s in low for s in noisy_signals):
            return recipient
        if recipient.lower() in low and len(value) > len(recipient) + 8:
            return recipient
        return value

    if isinstance(target, dict):
        by = str(target.get("by", "")).strip().lower()
        if by in {"text", "label", "name"} and isinstance(target.get("value"), str):
            normalized = _normalize_text_value(str(target.get("value")))
            if normalized != str(target.get("value")):
                return {"by": "text", "value": normalized}
        return target
    if isinstance(target, str):
        normalized = _normalize_text_value(target)
        return {"by": "text", "value": normalized} if normalized != target else target
    return target


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
    action = str(step.get("action", "")).strip().lower()
    if action == "act":
        return bool(_normalize_ref(step.get("ref")) and str(step.get("snapshot_id", "")).strip())
    if action in {"click", "type", "hover", "select"}:
        disambiguation = _normalize_disambiguation(step.get("disambiguation", {}))
        return _is_deterministic_target(step.get("target"), disambiguation=disambiguation)
    return action in {"navigate", "wait", "snapshot", "extract_structured", "screenshot", "read_dom", "highlight", "media_state", "scroll", "keyboard"}


def _normalize_action_params(step: dict[str, Any]) -> dict[str, Any] | None:
    action = str(step.get("action", "")).strip().lower()
    out = dict(step)
    if action == "wait":
        value = out.get("value", 1200)
        try:
            ms = int(value)
        except Exception:
            ms = 1200
        out["value"] = max(100, min(30000, ms))
    elif action == "keyboard":
        key = str(out.get("value", "")).strip()
        if key:
            key = KEYBOARD_CANONICAL.get(key.lower(), key)
        if key in SAFE_KEYBOARD_KEYS or len(key) == 1:
            out["value"] = key
        else:
            return None
    return out


def apply_flow_guardrails(
    *,
    steps: list[dict[str, Any]],
    user_prompt: str,
    current_url: str,
) -> list[dict[str, Any]]:
    """Determinism-first guardrails for planner output."""
    guarded: list[dict[str, Any]] = []
    recipient, _ = _extract_message_intent(user_prompt)

    for raw in steps:
        step = dict(raw)
        if step.get("type") != "browser":
            continue

        action = str(step.get("action", "")).strip().lower()
        if action == "act":
            normalized_act = _normalize_act_step(step)
            if normalized_act:
                guarded.append(normalized_act)
            continue

        if action not in PASS_THROUGH_ACTIONS:
            continue

        if _is_interactive_action(action):
            step["target"] = _normalize_interaction_target(step.get("target"))
            if action != "act" and step.get("target") is None:
                continue
            if action in {"click", "type", "hover", "select"}:
                step["disambiguation"] = _normalize_disambiguation(step.get("disambiguation", {}))
                _inject_interactive_preconditions(step)
            if recipient and action in {"click", "select"}:
                step["target"] = _sanitize_message_locator_target(step.get("target"), recipient)

        normalized = _normalize_action_params(step)
        if normalized is None:
            continue
        guarded.append(normalized)

    interactive_prompt = _prompt_is_interactive(user_prompt)
    if interactive_prompt and not _has_interactive_step(guarded):
        return _safe_escalation_steps("no_interactive_steps")

    if interactive_prompt:
        deterministic_interactions = [
            s for s in guarded
            if _is_interactive_action(str(s.get("action", "")).lower()) and _is_deterministic_step(s)
        ]
        if not deterministic_interactions:
            return _safe_escalation_steps("interactive_steps_not_deterministic")

    return guarded
