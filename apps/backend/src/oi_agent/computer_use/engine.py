from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
from io import BytesIO
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse

import httpx

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


async def _reconnect_page(cdp_url: str, current_playwright: Any | None) -> tuple[Any, Any, Any, Any, bool]:
    if current_playwright is not None:
        try:
            await current_playwright.stop()
        except Exception:
            logger.debug("computer_use_playwright_reconnect_stop_failed", exc_info=True)
    return await _connect_page(cdp_url)


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


def _normalize_url_identity(value: str | None) -> tuple[str, str]:
    parsed = urlparse(str(value or "").strip())
    host = (parsed.netloc or parsed.path or "").lower().strip()
    if host.startswith("www."):
        host = host[4:]
    path = parsed.path or "/"
    return host, path.rstrip("/") or "/"


def _url_matches_target(current_url: str | None, target_url: str | None) -> bool:
    current_host, current_path = _normalize_url_identity(current_url)
    target_host, target_path = _normalize_url_identity(target_url)
    if not current_host or not target_host or current_host != target_host:
        return False
    if target_path in {"", "/"}:
        return True
    return current_path == target_path or current_path.startswith(f"{target_path}/")


def _is_simple_navigation_task(prompt: str) -> bool:
    normalized = re.sub(r"\s+", " ", str(prompt or "").strip().lower())
    if not normalized:
        return False
    has_open_intent = any(
        phrase in normalized
        for phrase in (
            "open ",
            "go to ",
            "navigate to ",
            "visit ",
        )
    )
    if not has_open_intent:
        return False
    has_follow_up_task = any(
        phrase in normalized
        for phrase in (
            "search ",
            "find ",
            "click ",
            "select ",
            "choose ",
            "filter ",
            "apply ",
            "checkout",
            "add to cart",
            "sign in",
            "log in",
            "fill ",
            "type ",
        )
    )
    if has_follow_up_task:
        return False
    return any(
        phrase in normalized
        for phrase in (
            "stop when it is loaded",
            "stop when loaded",
            "once it is loaded",
            "once loaded",
        )
    )


def _task_requests_results_page(prompt: str) -> bool:
    normalized = re.sub(r"\s+", " ", str(prompt or "").strip().lower())
    if not normalized:
        return False
    return any(
        phrase in normalized
        for phrase in (
            "stop when the filtered results are visible",
            "stop when filtered results are visible",
            "stop when the results are visible",
            "stop when results are visible",
            "show the filtered results",
            "show the results",
            "stop at the results",
            "stop on the results page",
        )
    )


def _task_is_explicit_search_flow(prompt: str) -> bool:
    normalized = re.sub(r"\s+", " ", str(prompt or "").strip().lower())
    if not normalized:
        return False
    return "search for" in normalized or "look for" in normalized or "find " in normalized


def _task_requests_first_result_selection(prompt: str) -> bool:
    normalized = re.sub(r"\s+", " ", str(prompt or "").strip().lower())
    if not normalized:
        return False
    return any(
        phrase in normalized
        for phrase in (
            "first from the list",
            "first from list",
            "first result",
            "select the first",
            "choose the first",
            "open the first",
            "click the first",
        )
    )


def _task_requests_filtering(prompt: str) -> bool:
    normalized = re.sub(r"\s+", " ", str(prompt or "").strip().lower())
    if not normalized:
        return False
    return any(
        marker in normalized
        for marker in (
            " with size ",
            " size ",
            " under ",
            " below ",
            " less than ",
            " price ",
            " color ",
            " colour ",
            " filter ",
            " filters ",
            " brand ",
        )
    )


def _extract_search_terms(prompt: str) -> list[str]:
    normalized = re.sub(r"\s+", " ", str(prompt or "").strip().lower())
    if not normalized:
        return []
    match = re.search(r"(?:search for|look for|find)\s+(.+)", normalized)
    candidate = match.group(1) if match else normalized
    candidate = re.split(
        r"\b(?:with|under|below|less than|then|and stop|stop when|stop at|checkout|check out|select|choose)\b",
        candidate,
        maxsplit=1,
    )[0]
    candidate = re.sub(r"[^a-z0-9\s-]+", " ", candidate)
    words = [word for word in candidate.split() if len(word) >= 3]
    stop_words = {
        "the",
        "this",
        "that",
        "from",
        "into",
        "onto",
        "your",
        "website",
        "page",
        "results",
        "visible",
        "show",
        "open",
        "stop",
    }
    filtered_words = [word for word in words if word not in stop_words]
    candidates: list[str] = []
    phrase = " ".join(filtered_words[:4]).strip()
    if phrase:
        candidates.append(phrase)
    candidates.extend(filtered_words[:6])
    seen: set[str] = set()
    terms: list[str] = []
    for candidate_value in candidates:
        token = candidate_value.strip()
        if not token or token in seen:
            continue
        seen.add(token)
        terms.append(token)
    return terms


def _price_token_count(text: str) -> int:
    return len(re.findall(r"(?:₹|rs\\.?|inr|\\$|€|£)\\s?\\d{2,6}", str(text or ""), re.IGNORECASE))


def _page_looks_like_product_detail(page_state: dict[str, Any]) -> bool:
    url = str(page_state.get("url", "") or "")
    title = str(page_state.get("title", "") or "")
    body = str(page_state.get("body_text", "") or "")
    combined = f"{url} {title} {body}".lower()
    product_markers = (
        "/buy",
        "/product/",
        "/products/",
        "/dp/",
        "add to bag",
        "add to cart",
        "select size",
        "size chart",
        "delivery options",
        "product details",
    )
    marker_hits = sum(1 for marker in product_markers if marker in combined)
    price_count = _price_token_count(combined)
    if marker_hits >= 2:
        return True
    return marker_hits >= 1 and price_count <= 2


def _page_looks_like_results_listing(page_state: dict[str, Any], prompt: str) -> bool:
    if _page_looks_like_product_detail(page_state):
        return False
    url = str(page_state.get("url", "") or "")
    title = str(page_state.get("title", "") or "")
    body = str(page_state.get("body_text", "") or "")
    combined = f"{url} {title} {body}".lower()
    price_count = _price_token_count(combined)
    search_terms = _extract_search_terms(prompt)
    term_hits = sum(1 for term in search_terms if term and term in combined)
    results_markers = (
        "sort by",
        "filter",
        "filters",
        "results",
        "products",
        "items",
        "rawquery",
        "search",
    )
    results_hits = sum(1 for marker in results_markers if marker in combined)
    if term_hits >= 1 and (price_count >= 3 or results_hits >= 1):
        return True
    return price_count >= 5 and results_hits >= 1


def _recent_steps_show_filter_work(previous_steps: list[ComputerUseStepRecord]) -> bool:
    if len(previous_steps) < 3:
        return False
    combined = " ".join(
        f"{step.action} {step.reason} {step.title} {step.url}".lower()
        for step in previous_steps[-8:]
    )
    return any(
        marker in combined
        for marker in (
            "filter",
            "filters",
            "size",
            "price",
            "slider",
            "sort",
            "under",
            "below",
            "less than",
        )
    ) or sum(1 for step in previous_steps[-8:] if step.action in {"click", "scroll", "press"}) >= 4


def _recent_steps_stuck_on_results_filters(
    previous_steps: list[ComputerUseStepRecord],
    *,
    page_state: dict[str, Any],
) -> bool:
    current_url = str(page_state.get("url", "") or "")
    current_title = str(page_state.get("title", "") or "")
    if not current_url and not current_title:
        return False
    relevant_steps = [
        step for step in previous_steps[-8:]
        if step.url == current_url and step.title == current_title
    ]
    if len(relevant_steps) < 3:
        return False
    filter_mentions = sum(
        1
        for step in relevant_steps
        if any(
            marker in f"{step.reason} {step.title}".lower()
            for marker in ("filter", "size", "price", "slider", "under", "below", "less than", "scroll")
        )
    )
    scroll_steps = sum(1 for step in relevant_steps if step.action == "scroll")
    return filter_mentions >= 2 and scroll_steps >= 2


def _results_page_completion_message(
    *,
    prompt: str,
    page_state: dict[str, Any],
    previous_steps: list[ComputerUseStepRecord],
) -> str | None:
    if not _task_requests_results_page(prompt):
        return None
    if not _page_looks_like_results_listing(page_state, prompt):
        return None
    if _task_requests_filtering(prompt) and not _recent_steps_show_filter_work(previous_steps):
        return None
    title = str(page_state.get("title", "") or "").strip()
    url = str(page_state.get("url", "") or "").strip()
    target = title or url or "the results page"
    return f"The requested results are visible on {target}. Stopping at the results page as requested."


async def _first_visible_result_coordinates(page: Any) -> tuple[int, int] | None:
    candidates = [
        "main a[href*='/buy']",
        "main a[href*='/product']",
        "main a[href*='/p/']",
        "[data-testid*='product'] a[href]",
        "[data-testid*='product-card'] a[href]",
        "article a[href]",
        "li a[href]",
        "main a[href]",
    ]
    for selector in candidates:
        try:
            locator = page.locator(selector)
            count = await locator.count()
            for index in range(min(count, 18)):
                handle = locator.nth(index)
                box = await handle.bounding_box()
                if not box:
                    continue
                if box["width"] < 80 or box["height"] < 80:
                    continue
                if box["y"] < 120:
                    continue
                href = await handle.get_attribute("href")
                normalized_href = str(href or "").lower()
                if not normalized_href or normalized_href.startswith("#"):
                    continue
                if any(
                    blocked in normalized_href
                    for blocked in ("/login", "/signup", "/wishlist", "/help", "/cart", "/bag")
                ):
                    continue
                x = int(box["x"] + (box["width"] / 2))
                y = int(box["y"] + min(box["height"] / 2, 220))
                if x >= 0 and y >= 0:
                    return x, y
        except Exception:
            continue
    return None


def _is_retryable_navigation_error(exc: Exception) -> bool:
    lowered = str(exc or "").lower()
    return any(
        marker in lowered
        for marker in (
            "err_http2_protocol_error",
            "err_connection_reset",
            "err_connection_closed",
            "err_network_changed",
            "err_internet_disconnected",
            "err_timed_out",
            "navigation timeout",
            "timeout",
            "net::err_",
        )
    )


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
    reason_lower = (normalized.reason or "").lower()
    visible_inputs = list(page_state.get("visible_inputs", []) or [])

    def search_input_visible() -> bool:
        for entry in visible_inputs:
            if not isinstance(entry, dict):
                continue
            placeholder = str(entry.get("placeholder", "") or "").lower()
            aria_label = str(entry.get("ariaLabel", "") or "").lower()
            value = str(entry.get("value", "") or "").strip()
            input_type = str(entry.get("type", "") or "").lower()
            if value and (
                "search" in placeholder
                or "search" in aria_label
                or input_type == "search"
            ):
                return True
        return False

    def reason_implies_enter() -> bool:
        return any(
            marker in reason_lower
            for marker in (
                "press enter",
                "hit enter",
                "submit the search",
                "initiate the search",
                "search query is already",
                "enter key",
            )
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
        key_aliases = {
            "Return": "Enter",
            "return": "Enter",
            "Go": "Enter",
            "go": "Enter",
            "Search": "Enter",
            "search": "Enter",
        }
        normalized.key = key_aliases.get(str(normalized.key or ""), normalized.key or "Enter")
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
    if normalized.action == "wait" and reason_implies_enter() and search_input_visible():
        normalized.action = "press"
        normalized.key = "Enter"
    return normalized


def _is_error_page_url(url: str | None) -> bool:
    lowered = str(url or "").strip().lower()
    return lowered.startswith("chrome-error://") or lowered.startswith("about:blank")


def _select_active_page(browser: Any, current_page: Any, *, preferred_url: str | None = None) -> Any:
    all_pages: list[Any] = []
    for context in list(getattr(browser, "contexts", []) or []):
        all_pages.extend([page for page in list(getattr(context, "pages", []) or []) if not page.is_closed()])
    if not all_pages:
        return current_page
    if preferred_url:
        preferred_matches = [
            page for page in all_pages
            if _url_matches_target(str(getattr(page, "url", "") or ""), preferred_url)
        ]
        if preferred_matches:
            return preferred_matches[-1]
    current_url = str(getattr(current_page, "url", "") or "")
    if current_page in all_pages and not current_page.is_closed() and not _is_error_page_url(current_url):
        return current_page
    healthy_pages = [
        page for page in all_pages
        if not _is_error_page_url(str(getattr(page, "url", "") or ""))
    ]
    if healthy_pages:
        return healthy_pages[-1]
    if current_page in all_pages and not current_page.is_closed():
        return current_page
    return all_pages[-1]


async def _select_prompt_relevant_page(browser: Any, current_page: Any, *, prompt: str) -> Any:
    page = _select_active_page(browser, current_page)
    if not _task_requests_results_page(prompt):
        return page
    all_pages: list[Any] = []
    for context in list(getattr(browser, "contexts", []) or []):
        all_pages.extend([candidate for candidate in list(getattr(context, "pages", []) or []) if not candidate.is_closed()])
    if not all_pages:
        return page
    current_candidates: list[tuple[Any, dict[str, Any]]] = []
    fallback_candidates: list[tuple[Any, dict[str, Any]]] = []
    for candidate in all_pages:
        try:
            state = await _page_state(candidate)
        except Exception:
            continue
        if _page_looks_like_results_listing(state, prompt):
            if candidate == page:
                return candidate
            current_candidates.append((candidate, state))
        elif not _page_looks_like_product_detail(state):
            fallback_candidates.append((candidate, state))
    if current_candidates:
        return current_candidates[-1][0]
    if fallback_candidates and _page_looks_like_product_detail(await _page_state(page)):
        return fallback_candidates[-1][0]
    return page


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
            page_details = await page.evaluate(
                """() => {
                    const bodyText = String(document.body?.innerText || "")
                        .replace(/\\s+/g, " ")
                        .trim()
                        .slice(0, 1800);
                    const visibleInputs = Array.from(document.querySelectorAll("input, textarea"))
                        .map((element) => {
                            const rect = element.getBoundingClientRect();
                            const style = window.getComputedStyle(element);
                            if (
                                rect.width < 24 ||
                                rect.height < 18 ||
                                style.display === "none" ||
                                style.visibility === "hidden"
                            ) {
                                return null;
                            }
                            const type = String(element.getAttribute("type") || element.tagName || "text").toLowerCase();
                            const value =
                                type === "password"
                                    ? ""
                                    : String("value" in element ? element.value || "" : "")
                                          .replace(/\\s+/g, " ")
                                          .trim()
                                          .slice(0, 80);
                            return {
                                type,
                                placeholder: String(element.getAttribute("placeholder") || "").trim().slice(0, 80),
                                ariaLabel: String(element.getAttribute("aria-label") || "").trim().slice(0, 80),
                                value,
                            };
                        })
                        .filter(Boolean)
                        .slice(0, 6);
                    return { bodyText, visibleInputs };
                }"""
            )
            return {
                "url": str(page.url or ""),
                "title": str(await page.title()),
                "viewport": {
                    "width": int(viewport.get("width", 1280) or 1280),
                    "height": int(viewport.get("height", 720) or 720),
                    "dpr": float(viewport.get("dpr", 1) or 1),
                },
                "body_text": str(page_details.get("bodyText", "") or ""),
                "visible_inputs": list(page_details.get("visibleInputs", []) or []),
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


def _prepare_model_screenshot(
    screenshot: bytes,
    *,
    max_width: int | None = None,
    max_height: int | None = None,
    quality: int | None = None,
) -> tuple[bytes, str]:
    try:
        from PIL import Image
    except Exception:
        return screenshot, "image/png"

    try:
        with Image.open(BytesIO(screenshot)) as image:
            converted = image.convert("RGB")
            converted.thumbnail(
                (
                    max(320, int(max_width or settings.computer_use_screenshot_max_width or 768)),
                    max(240, int(max_height or settings.computer_use_screenshot_max_height or 512)),
                ),
                Image.Resampling.LANCZOS,
            )
            buffer = BytesIO()
            converted.save(
                buffer,
                format="JPEG",
                quality=max(35, min(90, int(quality or settings.computer_use_screenshot_quality or 60))),
                optimize=True,
            )
            prepared = buffer.getvalue()
            if prepared:
                return prepared, "image/jpeg"
    except Exception:
        logger.debug("computer_use_screenshot_prepare_failed", exc_info=True)
    return screenshot, "image/png"


def _model_screenshot_variants(screenshot: bytes) -> list[tuple[bytes, str]]:
    variants: list[tuple[bytes, str]] = []
    max_width = max(320, int(settings.computer_use_screenshot_max_width or 768))
    max_height = max(240, int(settings.computer_use_screenshot_max_height or 512))
    quality = max(35, min(90, int(settings.computer_use_screenshot_quality or 60)))
    resize_attempts = [
        (max_width, max_height, quality),
        (min(max_width, 640), min(max_height, 432), min(quality, 54)),
        (min(max_width, 512), min(max_height, 360), min(quality, 50)),
    ]
    seen: set[tuple[bytes, str]] = set()
    for width, height, attempt_quality in resize_attempts:
        prepared = _prepare_model_screenshot(
            screenshot,
            max_width=width,
            max_height=height,
            quality=attempt_quality,
        )
        if prepared not in seen:
            seen.add(prepared)
            variants.append(prepared)
    if not variants:
        variants.append((screenshot, "image/png"))
    return variants


async def _open_url_via_cdp(cdp_url: str, url: str) -> None:
    request_url = f"{cdp_url}/json/new?{url}"
    async with httpx.AsyncClient(timeout=httpx.Timeout(6.0, read=6.0)) as client:
        response = await client.put(request_url)
        if not response.is_success:
            response = await client.get(request_url)
        response.raise_for_status()


async def _navigate_with_retries(page: Any, url: str, *, cdp_url: str | None = None) -> None:
    last_error: Exception | None = None
    goto_strategies: tuple[tuple[str, int], ...] = (
        ("domcontentloaded", 20_000),
        ("load", 25_000),
        ("commit", 12_000),
    )
    for attempt, (wait_until, timeout_ms) in enumerate(goto_strategies, start=1):
        try:
            await page.goto(url, wait_until=wait_until, timeout=timeout_ms)
            await page.wait_for_timeout(250)
            await _stabilize_page(page)
            return
        except Exception as exc:
            last_error = exc
            if not _is_retryable_navigation_error(exc):
                raise
            logger.warning(
                "computer_use_navigation_retry url=%s attempt=%s wait_until=%s error=%s",
                url,
                attempt,
                wait_until,
                exc,
            )
            await page.wait_for_timeout(350 * attempt)
    if cdp_url:
        try:
            await _open_url_via_cdp(cdp_url, url)
            await page.wait_for_timeout(600)
            return
        except Exception as exc:
            logger.warning(
                "computer_use_navigation_cdp_fallback_failed url=%s error=%s",
                url,
                exc,
            )
            if last_error is None:
                last_error = exc
    try:
        await page.evaluate(
            """(nextUrl) => {
                window.location.assign(nextUrl);
            }""",
            url,
        )
        await page.wait_for_timeout(400)
        await _stabilize_page(page)
        return
    except Exception as exc:
        if last_error is not None:
            raise RuntimeError(str(last_error)) from exc
        raise


def _build_genai_client() -> Any:
    from google import genai

    return genai.Client(
        vertexai=settings.google_genai_use_vertexai,
        project=settings.gcp_project,
        location=settings.gcp_location,
        api_key=None if settings.google_genai_use_vertexai else (settings.google_api_key or None),
    )


def _decision_prompt(*, prompt: str, page_state: dict[str, Any], previous_steps: list[ComputerUseStepRecord]) -> str:
    compact_steps = [
        {
            "index": step.index,
            "action": step.action,
            "reason": step.reason,
            "url": step.url,
            "title": step.title,
            "status": step.status,
        }
        for step in previous_steps[-6:]
    ]
    stagnation_note = ""
    same_page_steps = [
        step for step in previous_steps[-4:]
        if step.url == str(page_state.get("url", "") or "") and step.title == str(page_state.get("title", "") or "")
    ]
    if len(same_page_steps) >= 3:
        stagnation_note = (
            "The page has not changed across several recent steps. Do not repeat the same click or wait action. "
            "Choose a different control, use Enter or a submit action when text is already present in a search field, "
            "or move to the next meaningful browser action."
        )
    results_page_note = (
        "The user asked to stop at the results page. Once the requested search/filter results are visible, return done. "
        "Do not open a product detail page, cart, or checkout unless the user explicitly asked for that."
        if _task_requests_results_page(prompt)
        else "n/a"
    )
    search_flow_note = (
        "The task includes an explicit search request. Use the website's visible search box with the user's query before "
        "choosing categories, promoted collections, or random product links. Apply only the filters the user asked for. "
        "If unrelated filters are already active, clear them instead of adding more unrelated filters."
        if _task_is_explicit_search_flow(prompt)
        else "n/a"
    )
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
            "If the task was only to open or go to a site, and the current URL already matches that site, return done instead of navigating again.",
            "If the latest steps already navigated to the same URL and the page is visibly on that site, prefer done or the next meaningful action over repeating navigate.",
            "Do not repeat the same navigate action in a loop once the target site is already open.",
            "Do not explain outside JSON.",
            "",
            f"Task: {prompt}",
            f"Current URL: {page_state.get('url', '')}",
            f"Current title: {page_state.get('title', '')}",
            f"Viewport: {json.dumps(page_state.get('viewport', {}), ensure_ascii=True)}",
            f"Visible inputs: {json.dumps(page_state.get('visible_inputs', []), ensure_ascii=True)}",
            f"Visible text excerpt: {page_state.get('body_text', '')}",
            f"Previous steps: {json.dumps(compact_steps, ensure_ascii=True)}",
            f"Search-flow note: {search_flow_note}",
            f"Results-page note: {results_page_note}",
            f"Stagnation note: {stagnation_note or 'n/a'}",
            "",
            'JSON schema: {"action":"click|type|scroll|press|navigate|wait|done","reason":"short reason","x":0,"y":0,"text":"","url":"","key":"","delta_y":0}',
        ]
    )


async def _generate_action(
    *,
    client: Any,
    prompt: str,
    screenshot_variants: list[tuple[bytes, str]],
) -> ComputerUseAction:
    from google.genai import types

    last_error: Exception | None = None
    for model_name in _candidate_models():
        for screenshot, screenshot_mime_type in screenshot_variants:
            try:
                response = await client.aio.models.generate_content(
                    model=model_name,
                    contents=[
                        types.Part.from_text(text=prompt),
                        types.Part.from_bytes(data=screenshot, mime_type=screenshot_mime_type),
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
                if "input token count" in str(exc).lower():
                    continue
                break
    raise RuntimeError(f"Computer use model failed: {last_error or 'unknown error'}")


async def _emit(callback: ComputerUseEventCallback | None, event: dict[str, Any]) -> None:
    if callback is None:
        return
    await callback(event)


async def _apply_action(page: Any, action: ComputerUseAction, *, cdp_url: str | None = None) -> None:
    async def _fill_visible_search_input(text: str) -> bool:
        candidates = [
            "input[type='search']",
            "input[placeholder*='Search' i]",
            "input[aria-label*='Search' i]",
        ]
        for selector in candidates:
            locator = page.locator(selector).first
            try:
                if await locator.count() == 0:
                    continue
                await locator.click(timeout=1_500)
                await locator.fill(text, timeout=2_000)
                return True
            except Exception:
                continue
        return False

    async def _press_enter_on_search_input() -> bool:
        candidates = [
            "input[type='search']",
            "input[placeholder*='Search' i]",
            "input[aria-label*='Search' i]",
        ]
        for selector in candidates:
            locator = page.locator(selector).first
            try:
                if await locator.count() == 0:
                    continue
                value = await locator.input_value(timeout=1_500)
                if not str(value or "").strip():
                    continue
                await locator.focus(timeout=1_500)
                await locator.press("Enter", timeout=1_500)
                return True
            except Exception:
                continue
        return False

    if action.action == "navigate":
        if not action.url:
            raise RuntimeError("Computer use navigate action requires url.")
        await _navigate_with_retries(page, action.url, cdp_url=cdp_url)
        return
    elif action.action == "click":
        if action.x is None or action.y is None:
            raise RuntimeError("Computer use click action requires coordinates.")
        await page.mouse.click(action.x, action.y)
    elif action.action == "type":
        if action.text and await _fill_visible_search_input(action.text):
            await page.wait_for_timeout(max(300, settings.computer_use_action_delay_ms))
            await _stabilize_page(page)
            return
        if action.x is not None and action.y is not None:
            await page.mouse.click(action.x, action.y)
        await page.keyboard.type(action.text or "")
    elif action.action == "press":
        if (action.key or "Enter") == "Enter" and await _press_enter_on_search_input():
            await page.wait_for_timeout(max(300, settings.computer_use_action_delay_ms))
            await _stabilize_page(page)
            return
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
            page = await _select_prompt_relevant_page(browser, page, prompt=prompt)
            state = await _page_state(page)
            screenshot_bytes = await _capture_screenshot(page)
            model_screenshot_variants = _model_screenshot_variants(screenshot_bytes)
            screenshot_b64 = base64.b64encode(screenshot_bytes).decode("ascii")
            completion_message = _results_page_completion_message(
                prompt=prompt,
                page_state=state,
                previous_steps=steps,
            )
            if completion_message:
                steps.append(
                    ComputerUseStepRecord(
                        index=index,
                        action="done",
                        reason=completion_message,
                        url=state["url"],
                        title=state["title"],
                        screenshot_base64=screenshot_b64,
                    )
                )
                await _emit(on_event, {"type": "done", "payload": {"message": completion_message}})
                return ComputerUseResult(success=True, final_message=completion_message, steps=steps)
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
                screenshot_variants=model_screenshot_variants,
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
                await _apply_action(page, action, cdp_url=cdp_url)
            except Exception as exc:
                if _is_navigation_context_error(exc) or _is_closed_target_error(exc):
                    page = _select_active_page(
                        browser,
                        page,
                        preferred_url=action.url if action.action == "navigate" else None,
                    )
                    await _stabilize_page(page)
                else:
                    raise
            if action.action == "navigate" and cdp_url:
                playwright, browser, context, page, created_context = await _reconnect_page(cdp_url, playwright)
            page = _select_active_page(
                browser,
                page,
                preferred_url=action.url if action.action == "navigate" else None,
            )
            page = await _select_prompt_relevant_page(browser, page, prompt=prompt)
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
            completion_message = _results_page_completion_message(
                prompt=prompt,
                page_state=updated,
                previous_steps=steps,
            )
            if completion_message:
                await _emit(on_event, {"type": "done", "payload": {"message": completion_message}})
                return ComputerUseResult(success=True, final_message=completion_message, steps=steps)
            if action.action == "navigate" and action.url and _url_matches_target(updated["url"], action.url):
                if _is_simple_navigation_task(prompt):
                    message = f"The page {updated['title'] or updated['url']} is open and ready."
                    await _emit(on_event, {"type": "done", "payload": {"message": message}})
                    return ComputerUseResult(success=True, final_message=message, steps=steps)
                repeated_navigates = [
                    step for step in steps[-3:]
                    if step.action == "navigate" and _url_matches_target(step.url, action.url)
                ]
                if len(repeated_navigates) >= 2:
                    message = f"The page {updated['title'] or updated['url']} is already open."
                    await _emit(on_event, {"type": "done", "payload": {"message": message}})
                    return ComputerUseResult(success=True, final_message=message, steps=steps)
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
