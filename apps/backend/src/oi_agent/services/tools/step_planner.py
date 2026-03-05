"""Browser Step Planner — builds safe browser automation steps.

Uses Gemini to understand user intent and produce browser steps for the
Navigator flow. DOM interactions are ref-based (`snapshot` + `act`) to avoid
fragile selector targeting.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

from oi_agent.config import settings
from oi_agent.services.tools.navigator.planner_guardrails import apply_flow_guardrails

logger = logging.getLogger(__name__)


STEP_TYPES = ("browser", "consult")

BROWSER_ACTIONS = (
    "navigate", "wait", "keyboard", "screenshot", "read_dom",
    "extract_structured", "highlight", "snapshot", "act", "media_state",
    # Interactive semantic actions are allowed and preferred; guardrails sanitize brittle selectors.
    "click", "type", "scroll", "hover", "select",
)

NAVIGATOR_SYSTEM_PROMPT = """You are a browser automation planner. The user has a browser tab open and wants you to interact with it. You MUST produce browser steps — NEVER use API steps.

You control the browser via Chrome DevTools Protocol (CDP). Interactions work on ANY website.

STEP FORMATS:
- Browser step:
  {"type":"browser","action":"<action>", ...}

  Ref-based format (recommended when snapshot refs are available):
  {"type":"browser","action":"act","kind":"click|type|hover|select","ref":"e5","value":"<optional>","description":"<human description>"}

- Consult step:
   {"type": "consult", "reason": "<why>", "description": "<explanation>"}
  ONLY for: payment, CAPTCHA, 2FA, login requiring credentials

IMPORTANT:
- Use ONLY executable actions from this set:
  navigate, wait, keyboard, screenshot, read_dom, extract_structured, highlight, snapshot, act, click, type, hover, select, scroll.
- Locator strategy (in order):
  1) Use semantic targets for click/type/hover/select (role/text/name/aria/placeholder based).
  2) Use `act` + `ref` when snapshot refs are clearly available.
  3) Never use brittle CSS class chains or XPath.
  4) Never return coordinate-based targets as a primary strategy.
- Accept ref forms (`e5`, `@e5`, `ref=e5`) but normalize to `ref: "e5"` in output.
- Keep descriptions short and concrete.
- Complete the full intent in one plan:
  if user says "play/watch/listen X", do not stop at search; include opening the result and a confirmation wait/screenshot.
- For messaging intents ("send message to <name>"), keep recipient locator clean:
  recipient target must be only the entity name (example: "tortoise"), never include extra clauses like "message content", "send any message", or platform suffix text.
- Do not output passive-only plans (snapshot/wait/screenshot) for interactive user requests.
- If user's tab is already on relevant site, do not navigate away unnecessarily.

Return ONLY a JSON object: {"steps": [...], "requires_browser": true, "estimated_duration_seconds": number}
"""


def _load_ui_navigator_prompt() -> str:
    """Load project UI navigator requirements from markdown prompt file."""
    prompt_path = Path(__file__).resolve().parents[4] / "UI_NAVIGATOR_PROMPT.md"
    try:
        if prompt_path.exists():
            return prompt_path.read_text(encoding="utf-8")
    except Exception as exc:
        logger.debug("Failed to load UI navigator prompt: %s", exc)
    return ""


async def _call_gemini(system_prompt: str, user_prompt: str) -> dict[str, Any]:
    """Shared Gemini call that returns parsed plan JSON."""
    from google import genai
    from google.genai import types

    client = genai.Client(
        vertexai=settings.google_genai_use_vertexai,
        project=settings.gcp_project,
        location=settings.gcp_location,
    )

    response = await client.aio.models.generate_content(
        model=settings.gemini_model,
        contents=[
            {"role": "user", "parts": [{"text": f"{system_prompt}\n\n{user_prompt}"}]},
        ],
        config=types.GenerateContentConfig(temperature=0.2),
    )

    raw = (response.text or "{}").strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else raw
        if raw.endswith("```"):
            raw = raw[:raw.rfind("```")]

    return json.loads(raw)


def _validate_steps(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Filter steps to only those with valid types and actions."""
    validated = []
    for step in steps:
        step_type = step.get("type", "")
        if step_type not in STEP_TYPES:
            continue
        if step_type == "browser" and step.get("action") not in BROWSER_ACTIONS:
            continue
        validated.append(step)
    return validated

def _format_snapshot_context(snapshot: dict[str, Any]) -> str:
    """Format an aria page snapshot into context for the LLM prompt."""
    snapshot_text = snapshot.get("snapshot", "")
    if not snapshot_text:
        return ""

    ref_count = snapshot.get("refCount", 0)
    return (
        f"\nPAGE SNAPSHOT — {ref_count} interactive elements on the current page:\n"
        f"(Use these refs e0, e1, e2... in act steps; do not use selectors)\n\n"
        f"{snapshot_text}"
    )


def _format_structured_context(structured: dict[str, Any]) -> str:
    elements = structured.get("elements", [])
    if not isinstance(elements, list) or not elements:
        return ""

    lines: list[str] = []
    for idx, el in enumerate(elements[:80]):
        if not isinstance(el, dict):
            continue
        tag = str(el.get("tag", "") or "")
        role = str(el.get("role", "") or "")
        text = str(el.get("text", "") or "").strip()
        aria = str(el.get("ariaLabel", "") or "").strip()
        placeholder = str(el.get("placeholder", "") or "").strip()
        name = str(el.get("name", "") or "").strip()
        ref = el.get("ref")
        label = text or aria or placeholder or name
        label = label[:90]
        lines.append(f"- i{idx} ref={ref} tag={tag} role={role} label=\"{label}\"")

    if not lines:
        return ""
    return (
        "\nSTRUCTURED INTERACTIVE ELEMENTS (fallback context when aria refs are sparse):\n"
        "(Prefer meaningful labels like Compose, New message, Send, Subject, To)\n"
        + "\n".join(lines)
    )


def _format_completed_context(completed_steps: list[str] | None) -> str:
    if not completed_steps:
        return ""
    lines: list[str] = []
    for i, step in enumerate(completed_steps[-20:], start=1):
        lines.append(f"{i}. {step[:160]}")
    return (
        "\nALREADY COMPLETED STEPS (do not repeat these):\n"
        + "\n".join(lines)
    )


def _format_failure_context(
    failed_step: dict[str, Any] | None,
    error_message: str | None,
) -> str:
    if not failed_step and not error_message:
        return ""

    step_json = "{}"
    if isinstance(failed_step, dict):
        try:
            step_json = json.dumps(failed_step, ensure_ascii=False)
        except Exception:
            step_json = str(failed_step)
    error_text = (error_message or "").strip()[:500]
    return (
        "\nFAILURE CONTEXT:\n"
        f"failed_step={step_json}\n"
        f"error={error_text}\n"
        "Return a deterministic recovery sub-plan that starts from the CURRENT state. "
        "Do not repeat already completed steps.\n"
    )


async def plan_browser_steps(
    user_prompt: str,
    current_url: str = "",
    current_page_title: str = "",
    page_snapshot: dict[str, Any] | None = None,
    structured_context: dict[str, Any] | None = None,
    completed_steps: list[str] | None = None,
    failed_step: dict[str, Any] | None = None,
    error_message: str | None = None,
) -> dict[str, Any]:
    """Plan browser automation steps from a natural-language prompt.

    This is used by the Navigator tab where the user wants to control their
    attached browser tab. The prompt is interpreted in context of the website
    the user is currently viewing.
    """
    try:
        url_context = ""
        if current_url:
            domain = current_url.split("//")[-1].split("/")[0] if "//" in current_url else current_url
            url_context = (
                f"User's browser tab is currently on: {current_url}\n"
                f"Page title: {current_page_title or domain}\n"
                f"Website: {domain}\n\n"
                "The user is looking at this page right now. Interpret their request "
                "in context of this website. Do NOT navigate away unless the task "
                "clearly requires a different website.\n"
            )
        else:
            url_context = (
                "No specific URL is attached. If the task requires a website, "
                "start with a navigate step to the appropriate URL.\n"
            )

        prompt = (
            f"Today: {datetime.utcnow().strftime('%Y-%m-%d')}\n"
            f"{url_context}\n"
        )

        if page_snapshot:
            prompt += _format_snapshot_context(page_snapshot) + "\n\n"
        if structured_context:
            prompt += _format_structured_context(structured_context) + "\n\n"
        if completed_steps:
            prompt += _format_completed_context(completed_steps) + "\n\n"
        if failed_step or error_message:
            prompt += _format_failure_context(failed_step, error_message) + "\n\n"

        prompt += f"User's request: {user_prompt}\n"

        plan = await _call_gemini(NAVIGATOR_SYSTEM_PROMPT, prompt)
        validated = _validate_steps(plan.get("steps", []))
        validated = apply_flow_guardrails(
            steps=validated,
            user_prompt=user_prompt,
            current_url=current_url,
        )

        if not validated:
            logger.warning(
                "Navigator planner returned no browser steps for '%s'. Raw: %s",
                user_prompt, json.dumps(plan.get("steps", []))[:500],
            )

        result = {
            "steps": validated,
            "requires_browser": True,
            "estimated_duration_seconds": plan.get("estimated_duration_seconds", len(validated) * 5),
        }
        logger.info(
            "Navigator planner produced %d browser steps for '%s'",
            len(validated), user_prompt,
        )
        return result

    except Exception as exc:
        logger.error("Navigator planner failed: %s", exc)
        return _navigator_fallback(user_prompt, current_url)


def _navigator_fallback(user_prompt: str, current_url: str = "") -> dict[str, Any]:
    """Fallback planner using semantic actions only (no brittle selectors)."""
    steps: list[dict[str, Any]] = []
    prompt_lower = user_prompt.lower()

    if not current_url or any(w in prompt_lower for w in ("go to", "open", "navigate")):
        for word in prompt_lower.split():
            if "." in word and not word.startswith("."):
                url = word if word.startswith("http") else f"https://{word}"
                steps.append({"type": "browser", "action": "navigate", "target": url, "description": f"Open {url}"})
                steps.append({"type": "browser", "action": "wait", "target": "", "value": 3000, "description": "Wait for page load"})
                break

    if any(w in prompt_lower for w in ("search", "find", "look for", "check", "play ", "watch ", "listen ")):
        query = user_prompt
        for prefix in ("search for", "search", "find", "look for", "check for", "check if there is", "check", "play", "watch", "listen to", "listen"):
            if prefix in prompt_lower:
                query = user_prompt[prompt_lower.index(prefix) + len(prefix):].strip()
                break
        steps.append({"type": "browser", "action": "click", "target": {"by": "role", "value": "textbox"}, "description": "Focus search field"})
        steps.append({"type": "browser", "action": "type", "target": {"by": "role", "value": "textbox"}, "value": query, "description": f"Type: {query}"})
        steps.append({"type": "browser", "action": "keyboard", "target": "", "value": "Enter", "description": "Submit search"})
        steps.append({"type": "browser", "action": "wait", "target": "", "value": 2500, "description": "Wait for results"})

    steps.append({"type": "browser", "action": "screenshot", "target": "", "description": "Capture current state"})
    return {"steps": steps, "requires_browser": True, "estimated_duration_seconds": max(5, len(steps) * 3)}
