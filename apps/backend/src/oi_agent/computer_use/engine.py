from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from oi_agent.config import settings

logger = logging.getLogger(__name__)

ComputerUseEventCallback = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass
class ComputerUseAction:
    action: str
    reason: str = ""
    x: int | None = None
    y: int | None = None
    text: str | None = None
    url: str | None = None
    key: str | None = None
    delta_y: int | None = None


@dataclass
class ComputerUseStepRecord:
    index: int
    action: str
    reason: str
    url: str
    title: str
    screenshot_base64: str = ""
    status: str = "completed"


@dataclass
class ComputerUseResult:
    success: bool
    final_message: str
    steps: list[ComputerUseStepRecord] = field(default_factory=list)
    error: str = ""


def _candidate_models() -> list[str]:
    values = [
        settings.gemini_computer_use_model,
        *str(settings.gemini_computer_use_model_fallbacks or "").split(","),
    ]
    seen: set[str] = set()
    candidates: list[str] = []
    for value in values:
        candidate = str(value or "").strip()
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        candidates.append(candidate)
    return candidates or [settings.gemini_model]


def _extract_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?", "", cleaned).strip()
        cleaned = re.sub(r"```$", "", cleaned).strip()
    try:
        parsed = json.loads(cleaned)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        match = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if not match:
            return {}
        try:
            parsed = json.loads(match.group(0))
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}


async def _playwright_import() -> Any:
    from playwright.async_api import async_playwright

    return async_playwright


async def _connect_page(cdp_url: str) -> tuple[Any, Any, Any, Any, bool]:
    async_playwright = await _playwright_import()
    playwright = await async_playwright().start()
    browser = await playwright.chromium.connect_over_cdp(cdp_url)
    created_context = not browser.contexts
    context = browser.contexts[0] if browser.contexts else await browser.new_context()
    page = context.pages[0] if context.pages else await context.new_page()
    return playwright, browser, context, page, created_context


def _is_navigation_context_error(exc: Exception) -> bool:
    message = str(exc or "")
    lowered = message.lower()
    return "execution context was destroyed" in lowered or "most likely because of a navigation" in lowered


def _is_closed_target_error(exc: Exception) -> bool:
    lowered = str(exc or "").lower()
    return "target closed" in lowered or "page closed" in lowered or "has been closed" in lowered


async def _stabilize_page(page: Any) -> None:
    for state in ("domcontentloaded", "load", "networkidle"):
        try:
            await page.wait_for_load_state(state, timeout=1_500)
        except Exception:
            continue


def _clamp(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, value))


def _normalize_text(value: str | None) -> str | None:
    cleaned = str(value or "").strip()
    return cleaned or None


def _sanitize_action(action: ComputerUseAction, page_state: dict[str, Any]) -> ComputerUseAction:
    viewport = dict(page_state.get("viewport", {}) or {})
    width = int(viewport.get("width", 1280) or 1280)
    height = int(viewport.get("height", 720) or 720)
    normalized = ComputerUseAction(
        action=str(action.action or "wait").strip().lower() or "wait",
        reason=_normalize_text(action.reason) or "",
        x=action.x,
        y=action.y,
        text=_normalize_text(action.text),
        url=_normalize_text(action.url),
        key=_normalize_text(action.key),
        delta_y=action.delta_y,
    )
    if normalized.action not in {"click", "type", "scroll", "press", "navigate", "wait", "done"}:
        normalized.action = "wait"
        normalized.reason = normalized.reason or "Unsupported action emitted; waiting instead."
    if normalized.x is not None:
        normalized.x = _clamp(int(normalized.x), 0, max(0, width - 1))
    if normalized.y is not None:
        normalized.y = _clamp(int(normalized.y), 0, max(0, height - 1))
    if normalized.action in {"click", "type"} and (normalized.x is None or normalized.y is None):
        if normalized.action == "type" and normalized.text:
            normalized.action = "press"
            normalized.key = "Tab"
            normalized.reason = normalized.reason or "No coordinates returned; moving focus before typing."
        else:
            normalized.action = "wait"
            normalized.reason = normalized.reason or "Missing coordinates; waiting for a clearer UI state."
    if normalized.action == "type" and not normalized.text:
        normalized.action = "wait"
        normalized.reason = normalized.reason or "Missing input text; waiting."
    if normalized.action == "navigate":
        url = str(normalized.url or "")
        if not (url.startswith("http://") or url.startswith("https://")):
            normalized.action = "wait"
            normalized.reason = normalized.reason or "Navigation URL was not absolute; waiting."
            normalized.url = None
    if normalized.action == "scroll":
        normalized.delta_y = _clamp(int(normalized.delta_y or 640), -2200, 2200)
    if normalized.action == "press":
        allowed_keys = {
            "Enter",
            "Tab",
            "Shift+Tab",
            "Escape",
            "ArrowDown",
            "ArrowUp",
            "ArrowLeft",
            "ArrowRight",
            "PageDown",
            "PageUp",
            "Home",
            "End",
            "Backspace",
            "Space",
        }
        normalized.key = normalized.key or "Enter"
        if normalized.key not in allowed_keys:
            normalized.action = "wait"
            normalized.reason = normalized.reason or "Unsafe key emitted; waiting."
    return normalized


def _select_active_page(browser: Any, current_page: Any) -> Any:
    all_pages: list[Any] = []
    for context in list(getattr(browser, "contexts", []) or []):
        all_pages.extend([page for page in list(getattr(context, "pages", []) or []) if not page.is_closed()])
    if not all_pages:
        return current_page
    if current_page in all_pages and not current_page.is_closed():
        return current_page
    return all_pages[-1]


async def _page_state(page: Any) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            viewport = page.viewport_size or {}
            if not viewport:
                viewport = await page.evaluate(
                    """() => ({
                        width: window.innerWidth || document.documentElement.clientWidth || 1280,
                        height: window.innerHeight || document.documentElement.clientHeight || 720,
                        dpr: window.devicePixelRatio || 1,
                    })"""
                )
            return {
                "url": str(page.url or ""),
                "title": str(await page.title()),
                "viewport": {
                    "width": int(viewport.get("width", 1280) or 1280),
                    "height": int(viewport.get("height", 720) or 720),
                    "dpr": float(viewport.get("dpr", 1) or 1),
                },
            }
        except Exception as exc:
            last_error = exc
            if not _is_navigation_context_error(exc) or attempt == 3:
                raise
            await _stabilize_page(page)
            await page.wait_for_timeout(250 * (attempt + 1))
    raise RuntimeError(str(last_error or "Failed to read page state."))


async def _capture_screenshot(page: Any) -> bytes:
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            return await page.screenshot(type="png", full_page=False)
        except Exception as exc:
            last_error = exc
            if not _is_navigation_context_error(exc) or attempt == 3:
                raise
            await _stabilize_page(page)
            await page.wait_for_timeout(250 * (attempt + 1))
    raise RuntimeError(str(last_error or "Failed to capture screenshot."))


def _build_genai_client() -> Any:
    from google import genai

    return genai.Client(
        vertexai=settings.google_genai_use_vertexai,
        project=settings.gcp_project,
        location=settings.gcp_location,
        api_key=None if settings.google_genai_use_vertexai else (settings.google_api_key or None),
    )


def _decision_prompt(*, prompt: str, page_state: dict[str, Any], previous_steps: list[ComputerUseStepRecord]) -> str:
    return "\n".join(
        [
            "You are OI computer use mode.",
            "Decide the next exact browser action from the screenshot and task.",
            "Stay concise. Return JSON only.",
            "Allowed actions: click, type, scroll, press, navigate, wait, done.",
            "For click/type, provide x and y coordinates within the visible viewport.",
            "For type, include the text.",
            "For scroll, include delta_y.",
            "For press, include the key.",
            "Use done only when the user's requested outcome is already achieved.",
            "Do not explain outside JSON.",
            "",
            f"Task: {prompt}",
            f"Current URL: {page_state.get('url', '')}",
            f"Current title: {page_state.get('title', '')}",
            f"Viewport: {json.dumps(page_state.get('viewport', {}), ensure_ascii=True)}",
            f"Previous steps: {json.dumps([step.__dict__ for step in previous_steps[-6:]], ensure_ascii=True)}",
            "",
            'JSON schema: {"action":"click|type|scroll|press|navigate|wait|done","reason":"short reason","x":0,"y":0,"text":"","url":"","key":"","delta_y":0}',
        ]
    )


async def _generate_action(*, client: Any, prompt: str, screenshot: bytes) -> ComputerUseAction:
    from google.genai import types

    last_error: Exception | None = None
    for model_name in _candidate_models():
        try:
            response = await client.aio.models.generate_content(
                model=model_name,
                contents=[
                    types.Part.from_text(text=prompt),
                    types.Part.from_bytes(data=screenshot, mime_type="image/png"),
                ],
                config=types.GenerateContentConfig(
                    temperature=0.2,
                    response_mime_type="application/json",
                ),
            )
            data = _extract_json_object(str(getattr(response, "text", "") or ""))
            action = str(data.get("action", "") or "").strip().lower() or "wait"
            return ComputerUseAction(
                action=action,
                reason=str(data.get("reason", "") or "").strip(),
                x=int(data["x"]) if data.get("x") is not None else None,
                y=int(data["y"]) if data.get("y") is not None else None,
                text=str(data.get("text", "") or "").strip() or None,
                url=str(data.get("url", "") or "").strip() or None,
                key=str(data.get("key", "") or "").strip() or None,
                delta_y=int(data["delta_y"]) if data.get("delta_y") is not None else None,
            )
        except Exception as exc:
            last_error = exc
            logger.warning("computer_use_model_attempt_failed model=%s error=%s", model_name, exc)
    raise RuntimeError(f"Computer use model failed: {last_error or 'unknown error'}")


async def _emit(callback: ComputerUseEventCallback | None, event: dict[str, Any]) -> None:
    if callback is None:
        return
    await callback(event)


async def _apply_action(page: Any, action: ComputerUseAction) -> None:
    if action.action == "navigate":
        if not action.url:
            raise RuntimeError("Computer use navigate action requires url.")
        await page.goto(action.url, wait_until="domcontentloaded")
    elif action.action == "click":
        if action.x is None or action.y is None:
            raise RuntimeError("Computer use click action requires coordinates.")
        await page.mouse.click(action.x, action.y)
    elif action.action == "type":
        if action.x is not None and action.y is not None:
            await page.mouse.click(action.x, action.y)
        await page.keyboard.type(action.text or "")
    elif action.action == "press":
        await page.keyboard.press(action.key or "Enter")
    elif action.action == "scroll":
        await page.mouse.wheel(0, int(action.delta_y or 640))
    elif action.action == "wait":
        await page.wait_for_timeout(max(300, settings.computer_use_action_delay_ms))
        return
    elif action.action == "done":
        return
    else:
        raise RuntimeError(f"Unsupported computer use action '{action.action}'.")
    await page.wait_for_timeout(max(300, settings.computer_use_action_delay_ms))
    await _stabilize_page(page)


async def run_computer_use(
    *,
    prompt: str,
    cdp_url: str,
    on_event: ComputerUseEventCallback | None = None,
) -> ComputerUseResult:
    if not settings.enable_computer_use:
        raise RuntimeError("Computer use is disabled.")

    playwright = None
    browser = None
    context = None
    page = None
    created_context = False
    steps: list[ComputerUseStepRecord] = []
    try:
        playwright, browser, context, page, created_context = await _connect_page(cdp_url)
        client = _build_genai_client()
        for index in range(settings.computer_use_max_steps):
            page = _select_active_page(browser, page)
            state = await _page_state(page)
            screenshot_bytes = await _capture_screenshot(page)
            screenshot_b64 = base64.b64encode(screenshot_bytes).decode("ascii")
            await _emit(
                on_event,
                {
                    "type": "observation",
                    "payload": {
                        "index": index,
                        "url": state["url"],
                        "title": state["title"],
                        "viewport": state["viewport"],
                    },
                },
            )
            action = await _generate_action(
                client=client,
                prompt=_decision_prompt(prompt=prompt, page_state=state, previous_steps=steps),
                screenshot=screenshot_bytes,
            )
            action = _sanitize_action(action, state)
            await _emit(
                on_event,
                {
                    "type": "action",
                    "payload": {
                        "index": index,
                        "action": action.action,
                        "reason": action.reason,
                        "x": action.x,
                        "y": action.y,
                        "text": action.text,
                        "url": action.url,
                        "key": action.key,
                        "delta_y": action.delta_y,
                    },
                },
            )
            if action.action == "done":
                message = action.reason or "The task looks complete."
                steps.append(
                    ComputerUseStepRecord(
                        index=index,
                        action=action.action,
                        reason=message,
                        url=state["url"],
                        title=state["title"],
                        screenshot_base64=screenshot_b64,
                    )
                )
                await _emit(on_event, {"type": "done", "payload": {"message": message}})
                return ComputerUseResult(success=True, final_message=message, steps=steps)
            try:
                await _apply_action(page, action)
            except Exception as exc:
                if _is_navigation_context_error(exc) or _is_closed_target_error(exc):
                    page = _select_active_page(browser, page)
                    await _stabilize_page(page)
                else:
                    raise
            page = _select_active_page(browser, page)
            updated = await _page_state(page)
            steps.append(
                ComputerUseStepRecord(
                    index=index,
                    action=action.action,
                    reason=action.reason,
                    url=updated["url"],
                    title=updated["title"],
                    screenshot_base64=screenshot_b64,
                )
            )
        return ComputerUseResult(
            success=False,
            final_message="Computer use stopped before Gemini marked the task complete.",
            steps=steps,
            error="step_limit_reached",
        )
    finally:
        if created_context and context is not None:
            try:
                await context.close()
            except Exception:
                logger.debug("computer_use_context_close_failed", exc_info=True)
        if playwright is not None:
            await playwright.stop()
