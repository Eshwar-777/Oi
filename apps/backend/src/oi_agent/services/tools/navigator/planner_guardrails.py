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
    m = re.search(r"\be\d+\b", text.lower())
    if not m:
        return None
    return m.group(0)


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
    if kind in {"type", "select"}:
        out["value"] = step.get("value", "")
    return out


def _normalize_interaction_target(target: Any) -> Any:
    """Normalize known target shapes without dropping interaction steps."""
    if isinstance(target, dict):
        by = str(target.get("by", "")).strip().lower()
        if by in {"css", "selector", "css selector"}:
            css = target.get("value") or target.get("selector")
            if isinstance(css, str) and css.strip():
                return css.strip()
        if by == "xpath":
            # Extension does not support xpath robustly; preserve as text fallback.
            val = target.get("value")
            if isinstance(val, str) and val.strip():
                return {"by": "text", "value": val.strip()}
        if by in {"coords", "coordinate", "xy"}:
            # Planner should not drive interactions by raw coordinates.
            return None
    if isinstance(target, str):
        s = target.strip()
        # Avoid raw xpath strings, which extension can't reliably resolve.
        if s.startswith("//") or s.startswith("./"):
            return {"by": "text", "value": s}
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


def _build_email_send_repair(user_prompt: str) -> list[dict[str, Any]]:
    # Generic email flow without site-specific selectors.
    email_match = re.search(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", user_prompt)
    recipient = email_match.group(0) if email_match else ""
    return [
        {"type": "browser", "action": "click", "target": {"by": "text", "value": "Compose"}, "description": "Click Compose/New message"},
        {"type": "browser", "action": "wait", "target": "", "value": 1200, "description": "Wait for compose form"},
        {
            "type": "browser",
            "action": "type",
            "target": {"by": "role", "value": "textbox", "name": "to"},
            "value": recipient,
            "description": "Type recipient email",
        },
        {
            "type": "browser",
            "action": "type",
            "target": {"by": "role", "value": "textbox", "name": "subject"},
            "value": "Hello",
            "description": "Type subject",
        },
        {
            "type": "browser",
            "action": "type",
            "target": {"by": "role", "value": "textbox"},
            "value": "Hello, this is a generic email.",
            "description": "Type message body",
        },
        {"type": "browser", "action": "click", "target": {"by": "text", "value": "Send"}, "description": "Click Send"},
        {"type": "browser", "action": "wait", "target": "", "value": 1200, "description": "Wait for send confirmation"},
        {"type": "browser", "action": "screenshot", "target": "", "description": "Capture result"},
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


def _build_generic_interaction_repair(user_prompt: str) -> list[dict[str, Any]]:
    recipient, message_text = _extract_message_intent(user_prompt)
    steps: list[dict[str, Any]] = []
    if recipient:
        steps.extend([
            {"type": "browser", "action": "click", "target": {"by": "text", "value": recipient}, "description": f"Open chat/item for {recipient}"},
            {"type": "browser", "action": "wait", "target": "", "value": 1200, "description": "Wait for details panel/chat to load"},
        ])
    steps.extend([
        {"type": "browser", "action": "click", "target": {"by": "role", "value": "textbox"}, "description": "Focus input field"},
        {
            "type": "browser",
            "action": "type",
            "target": {"by": "role", "value": "textbox"},
            "value": message_text or "Hello from Oi",
            "description": "Type message/input text",
        },
        {"type": "browser", "action": "keyboard", "target": "", "value": "Enter", "description": "Submit action"},
        {"type": "browser", "action": "wait", "target": "", "value": 1200, "description": "Wait for UI confirmation"},
        {"type": "browser", "action": "screenshot", "target": "", "description": "Capture result"},
    ])
    return steps


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


def apply_flow_guardrails(
    *,
    steps: list[dict[str, Any]],
    user_prompt: str,
    current_url: str,
) -> list[dict[str, Any]]:
    """Hybrid strategy: semantic-first actions + optional ref-based act.

    - Keep semantic click/type/hover/select steps.
    - Keep act(ref) if valid.
    - Normalize fragile target shapes instead of dropping interactive steps.
    - Repair passive-only plans for interactive prompts.
    """
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
            if recipient and action in {"click", "select"}:
                step["target"] = _sanitize_message_locator_target(step.get("target"), recipient)

        guarded.append(step)

    if _prompt_is_interactive(user_prompt) and not _has_interactive_step(guarded):
        if _is_email_intent(user_prompt):
            return _build_email_send_repair(user_prompt)
        return _build_generic_interaction_repair(user_prompt)

    if _is_email_intent(user_prompt):
        has_email_actions = any(
            str(s.get("action", "")).lower() in {"click", "type"} and
            (
                "compose" in str(s.get("description", "")).lower()
                or "send" in str(s.get("description", "")).lower()
                or "subject" in str(s.get("description", "")).lower()
            )
            for s in guarded
        )
        if not has_email_actions:
            return _build_email_send_repair(user_prompt)

    return guarded
