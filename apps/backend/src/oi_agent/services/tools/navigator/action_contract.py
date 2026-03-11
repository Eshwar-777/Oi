from __future__ import annotations

import re
from typing import Any


def normalize_browser_ref(raw: Any) -> str | None:
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


def browser_target_uses_ref(target: Any) -> bool:
    if isinstance(target, str):
        return normalize_browser_ref(target) is not None
    if isinstance(target, dict):
        by = str(target.get("by", "")).strip().lower()
        if by == "ref":
            return normalize_browser_ref(target.get("value") or target.get("ref")) is not None
        if normalize_browser_ref(target.get("ref")) is not None:
            return True
    return False


def browser_target_uses_semantic_locator(target: Any) -> bool:
    if not isinstance(target, dict):
        return False
    return str(target.get("by", "")).strip().lower() in {
        "role",
        "label",
        "placeholder",
        "testid",
        "name",
        "text",
    }


def browser_action_target_supported(action: str, target: Any) -> bool:
    if target in (None, "", {}):
        return action in {
            "press",
            "keyboard",
            "wait",
            "diagnostics",
            "scan_ui_blockers",
            "extract_structured",
            "read_dom",
            "snapshot",
            "screenshot",
            "tab",
        }
    if browser_target_uses_ref(target):
        return action in {"click", "type", "hover", "select", "wait", "scroll", "highlight", "upload", "focus"}
    if isinstance(target, str):
        return action in {"click", "type", "select", "hover", "wait", "scroll", "highlight"}
    if not isinstance(target, dict):
        return False
    mode = str(target.get("by", "")).strip().lower()
    if mode in {"css", "name"}:
        return action in {"click", "type", "select", "hover", "wait", "scroll", "highlight"}
    if mode == "role":
        return action in {"click", "type", "hover", "select", "focus", "wait", "highlight"}
    if mode == "text":
        return action in {"click", "hover", "wait", "highlight"}
    if mode in {"label", "placeholder"}:
        return action in {"click", "type", "focus", "wait", "highlight"}
    if mode == "testid":
        return action in {"click", "type", "focus", "wait", "highlight"}
    return False


def rewrite_incompatible_browser_target(action: str, target: Any) -> Any:
    if not isinstance(target, dict):
        return target
    mode = str(target.get("by", "")).strip().lower()
    value = str(target.get("value", "")).strip()
    if action == "type" and mode == "text" and value:
        rewritten = dict(target)
        rewritten["by"] = "label"
        rewritten["value"] = value
        rewritten.pop("name", None)
        return rewritten
    return target
