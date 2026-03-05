"""Browser Step Planner — breaks natural-language tasks into browser automation steps.

Uses Gemini to understand the user's intent and produce a sequence of browser
steps (click, type, keyboard, navigate, etc.) that the CDP-based extension executes.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

from oi_agent.config import settings
from oi_agent.services.tools.navigator.planner_guardrails import apply_domain_guardrails

logger = logging.getLogger(__name__)


STEP_TYPES = ("browser", "consult")

BROWSER_ACTIONS = (
    "navigate", "click", "type", "scroll", "hover", "wait",
    "select", "keyboard", "screenshot", "read_dom",
    "extract_structured", "highlight",
)

NAVIGATOR_SYSTEM_PROMPT = """You are a browser automation planner. The user has a browser tab open and wants you to interact with it. You MUST produce browser steps — NEVER use API steps.

You control the browser via Chrome DevTools Protocol (CDP). Clicks and typing are simulated at the browser engine level — they work on ANY website: Gmail, BookMyShow, Amazon, YouTube, LinkedIn, Twitter, etc.

EVERY step you produce MUST be one of:

1. {"type": "browser", "action": "<action>", "target": "<how to find element>", "value": "<text to type or key to press>", "description": "<human-readable description>"}
   
   Actions:
   - navigate: Go to a URL. target = the URL.
   - click: Click an element. target = how to find it.
   - type: Type text into a focused/clicked element. target = how to find it, value = text to type.
   - keyboard: Press a key (Enter, Tab, Escape, Backspace, ArrowDown, etc.). value = key name.
   - scroll: Scroll the page. value = pixels (positive = down).
   - wait: Wait for something. target = element to wait for (or empty), value = milliseconds.
   - hover: Hover over an element.
   - select: Select a dropdown option. target = the select element, value = option value.
   - screenshot: Take a screenshot to see current state.
   - read_dom: Read page text content.
   - extract_structured: Get all interactive elements on the page.

   Target formats (the engine tries ALL of these automatically):
   - Text match: {"by": "text", "value": "Compose"} → finds button/link/element with this text, aria-label, or title
   - Role match: {"by": "role", "value": "textbox"} or {"by": "role", "value": "button", "name": "Send"}
   - Name attribute: {"by": "name", "value": "subjectbox"} → finds input[name="subjectbox"]
   - CSS selector: "input.search-field", "#search-box", "[data-testid='compose-btn']"
   - Plain text: "Search" → tries as selector, then name, then aria-label, then text match

2. {"type": "consult", "reason": "<why>", "description": "<explanation>"}
   ONLY for: payment, CAPTCHA, 2FA, login requiring credentials

UNDERSTANDING THE USER'S INTENT:

The user speaks naturally. You must interpret their intent and translate it into precise browser actions.

Examples of how to interpret prompts:

"send an email to bob@example.com, subject hello, body how are you" (on Gmail):
→ Click Compose → wait → type email in To field → press Tab → type subject → press Tab → type body → click Send

"check if durandhar is showing" (on BookMyShow):
→ Click search → type "durandhar" → press Enter → wait for results → screenshot

"search for flights to Delhi on March 15" (on MakeMyTrip):
→ Click destination field → type "Delhi" → wait for suggestions → click suggestion → set date → click Search

"add iPhone to cart" (on Amazon):
→ Click search box → type "iPhone" → press Enter → wait → click first result → click "Add to Cart"

"post a tweet saying hello world" (on Twitter/X):
→ Click compose/post button → type "hello world" → click Post

RULES:
- ALWAYS produce browser steps. NEVER produce {"type": "api"} steps.
- If the user's tab is already on the right website, do NOT navigate — interact directly.
- If you need to go to a different site, start with a navigate step + wait.
- After navigate, always add: {"type": "browser", "action": "wait", "target": "", "value": 3000}
- After clicking buttons that open dialogs/panels, add a short wait (1000-2000ms).
- For typing into fields, ALWAYS click/focus the field first, then type in a separate step.
- After typing in a search field, press Enter: {"type": "browser", "action": "keyboard", "target": "", "value": "Enter"}
- Use Tab to move between form fields when the target for the next field is ambiguous.
- End important flows with a screenshot to confirm success.
- Add "consult" ONLY for payment/CAPTCHA/login — not for normal interactions.
- Keep descriptions short and user-friendly (shown in the UI).
- Adapt to the attached website's native flow and UI patterns. Different sites have different interaction models.
- Prefer semantic targeting (role/text/name/aria-label) over brittle CSS classes.
- Do NOT return target objects like {"by": "css selector", "value": "..."}.
  If CSS is absolutely necessary, pass it as a plain selector string and prefer stable selectors
  (id, name, data-testid, aria attributes) over transient class names.

SITE FLOW ADAPTATION:
- Netflix:
  - Open search via visible search button/icon (text/aria like "Search"), type query, submit.
  - To play, prefer semantic actions: click card/title text, then click button with label/text like "Play" or "Resume".
  - Avoid brittle class selectors like ".title-card-play-button".
- YouTube:
  - Use search textbox and submit.
  - Open first result by clicking first visible video title/link result.
  - If needed, use keyboard navigation (ArrowDown + Enter) after search.
- E-commerce sites (Amazon/Flipkart/etc):
  - Search, wait for results grid/list, open first product result semantically, then add to cart.

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


async def plan_browser_steps(
    user_prompt: str,
    current_url: str = "",
    current_page_title: str = "",
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
            f"User's request: {user_prompt}\n"
        )

        plan = await _call_gemini(NAVIGATOR_SYSTEM_PROMPT, prompt)
        validated = _validate_steps(plan.get("steps", []))
        validated = apply_domain_guardrails(validated, user_prompt=user_prompt, current_url=current_url)

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
    """Produce a minimal browser plan when Gemini is unavailable."""
    steps: list[dict[str, Any]] = []
    prompt_lower = user_prompt.lower()

    if not current_url or any(w in prompt_lower for w in ("go to", "open", "navigate")):
        for word in prompt_lower.split():
            if "." in word and not word.startswith("."):
                url = word if word.startswith("http") else f"https://{word}"
                steps.append({"type": "browser", "action": "navigate", "target": url, "description": f"Open {url}"})
                steps.append({"type": "browser", "action": "wait", "target": "", "value": 3000, "description": "Wait for page load"})
                break

    if any(w in prompt_lower for w in ("search", "find", "look for", "check")):
        query = user_prompt
        for prefix in ("search for", "search", "find", "look for", "check for", "check if there is", "check"):
            if prefix in prompt_lower:
                query = user_prompt[prompt_lower.index(prefix) + len(prefix):].strip()
                break
        steps.append({"type": "browser", "action": "click", "target": {"by": "role", "value": "textbox"}, "description": "Click search field"})
        steps.append({"type": "browser", "action": "type", "target": {"by": "role", "value": "textbox"}, "value": query, "description": f"Type: {query}"})
        steps.append({"type": "browser", "action": "keyboard", "target": "", "value": "Enter", "description": "Press Enter to search"})
        steps.append({"type": "browser", "action": "wait", "target": "", "value": 3000, "description": "Wait for results"})

    steps.append({"type": "browser", "action": "screenshot", "target": "", "description": "Capture current state"})

    return {"steps": steps, "requires_browser": True, "estimated_duration_seconds": len(steps) * 3}
