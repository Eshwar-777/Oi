from __future__ import annotations

from typing import Any
from urllib.parse import urlparse


def normalize_target(step: dict[str, Any]) -> dict[str, Any]:
    """Convert unsupported CSS target objects into plain selector strings."""
    if step.get("type") != "browser":
        return step

    target = step.get("target")
    if not isinstance(target, dict):
        return step

    by = str(target.get("by", "")).strip().lower()
    if by in {"css", "css selector", "selector"}:
        css = target.get("value") or target.get("selector")
        if isinstance(css, str) and css.strip():
            step["target"] = css.strip()
    return step


def _extract_domain(url: str) -> str:
    if not url:
        return ""
    parsed = urlparse(url if "://" in url else f"https://{url}")
    return (parsed.netloc or "").lower()


def apply_domain_guardrails(
    steps: list[dict[str, Any]],
    user_prompt: str,
    current_url: str,
) -> list[dict[str, Any]]:
    """Patch brittle site-specific plans into semantic, robust actions."""
    domain = _extract_domain(current_url)
    prompt = user_prompt.lower()
    guarded = [normalize_target(dict(step)) for step in steps]

    if "netflix.com" in domain and "play" in prompt:
        for step in guarded:
            if step.get("type") != "browser" or step.get("action") != "click":
                continue
            desc = str(step.get("description", "")).lower()
            target = step.get("target")
            if "play" in desc and isinstance(target, str) and "title-card-play-button" in target:
                # Netflix uses dynamic cards/overlays; semantic button targeting is more stable.
                step["target"] = {"by": "role", "value": "button", "name": "Play"}
    return guarded

