from __future__ import annotations

import base64
import logging
import re
from typing import Any

from oi_agent.computer_use.engine import (
    ComputerUseEventCallback,
    ComputerUseResult,
    ComputerUseStepRecord,
    _capture_screenshot,
    _connect_page,
    _navigate_with_retries,
    _page_state,
    _reconnect_page,
    _select_active_page,
    _stabilize_page,
)

logger = logging.getLogger(__name__)

_MYNTRA_REQUIRED_TOKENS = (
    "myntra",
    "maroon",
    "shirt",
    "size m",
    "1000",
)
_MYNTRA_CHECKOUT_TOKENS = (
    "first",
    "add to cart",
    "add to card",
    "checkout",
)


def matches_myntra_demo_prompt(prompt: str) -> bool:
    normalized = re.sub(r"\s+", " ", str(prompt or "").strip().lower())
    if not normalized:
        return False
    required = all(token in normalized for token in _MYNTRA_REQUIRED_TOKENS)
    checkout = any(token in normalized for token in _MYNTRA_CHECKOUT_TOKENS)
    return required and checkout


async def _emit(callback: ComputerUseEventCallback | None, event: dict[str, Any]) -> None:
    if callback is None:
        return
    await callback(event)


async def _append_step(
    *,
    steps: list[ComputerUseStepRecord],
    index: int,
    action: str,
    reason: str,
    page: Any,
) -> dict[str, Any]:
    await _stabilize_page(page)
    state = await _page_state(page)
    screenshot_bytes = await _capture_screenshot(page)
    steps.append(
        ComputerUseStepRecord(
            index=index,
            action=action,
            reason=reason,
            url=str(state.get("url", "") or ""),
            title=str(state.get("title", "") or ""),
            screenshot_base64=base64.b64encode(screenshot_bytes).decode("ascii"),
        ),
    )
    return state


async def _emit_observation(on_event: ComputerUseEventCallback | None, index: int, page: Any) -> dict[str, Any]:
    state = await _page_state(page)
    await _emit(
        on_event,
        {
            "type": "observation",
            "payload": {
                "index": index,
                "url": str(state.get("url", "") or ""),
                "title": str(state.get("title", "") or ""),
                "viewport": state.get("viewport", {}),
            },
        },
    )
    return state


async def _emit_action(
    on_event: ComputerUseEventCallback | None,
    *,
    index: int,
    action: str,
    reason: str,
) -> None:
    await _emit(
        on_event,
        {
            "type": "action",
            "payload": {
                "index": index,
                "action": action,
                "reason": reason,
            },
        },
    )


async def _dismiss_myntra_overlays(page: Any) -> None:
    overlay_targets = [
        "[data-testid='close-button']",
        "button[aria-label='Close']",
        "button[aria-label='close']",
        "button[title='Close']",
        "div[role='button'][aria-label='Close']",
    ]
    for selector in overlay_targets:
        try:
            locator = page.locator(selector).first
            if await locator.count() == 0:
                continue
            await locator.click(timeout=1_200)
            await page.wait_for_timeout(250)
        except Exception:
            continue
    try:
        await page.keyboard.press("Escape")
        await page.wait_for_timeout(150)
    except Exception:
        return


async def _search_for_maroon_shirt(page: Any) -> None:
    search_input = None
    for selector in (
        "input.desktop-searchBar",
        "input[placeholder*='Search for products']",
        "input[aria-label*='Search']",
        "input[type='search']",
    ):
        try:
            locator = page.locator(selector).first
            if await locator.count() == 0:
                continue
            await locator.click(timeout=2_500)
            await locator.fill("maroon shirt", timeout=2_500)
            await locator.press("Enter", timeout=1_500)
            search_input = locator
            break
        except Exception:
            continue
    if search_input is None:
        raise RuntimeError("Could not find Myntra search input.")
    await page.wait_for_timeout(700)
    await _stabilize_page(page)


async def _find_first_affordable_result(page: Any, max_price: int) -> dict[str, Any] | None:
    candidates = await page.evaluate(
        """(limit) => {
            const pricePattern = /(?:₹|Rs\\.?)[\\s]*([\\d,]+)/gi;
            const anchors = Array.from(document.querySelectorAll("a[href*='/buy']"));
            return anchors
                .map((anchor) => {
                    const rect = anchor.getBoundingClientRect();
                    if (rect.width < 120 || rect.height < 160 || rect.top < 120) return null;
                    const text = String(anchor.innerText || "").replace(/\\s+/g, " ").trim();
                    if (!text || text.length < 12) return null;
                    const prices = [];
                    let match;
                    while ((match = pricePattern.exec(text)) !== null) {
                        const numeric = Number(String(match[1] || "").replace(/,/g, ""));
                        if (Number.isFinite(numeric)) prices.push(numeric);
                    }
                    if (prices.length === 0) return null;
                    const price = Math.min(...prices);
                    if (price > limit) return null;
                    return {
                        href: anchor.href,
                        title: text.slice(0, 220),
                        x: rect.left + rect.width / 2,
                        y: rect.top + Math.min(rect.height / 2, 180),
                        price,
                    };
                })
                .filter(Boolean)
                .slice(0, 12);
        }""",
        max_price,
    )
    if not isinstance(candidates, list) or not candidates:
        return None
    return dict(candidates[0])


async def _select_size_m(page: Any) -> bool:
    size_selectors = [
        "button",
        "[role='button']",
        "label",
        "div",
    ]
    for selector in size_selectors:
        try:
            locator = page.locator(selector).filter(has_text=re.compile(r"^M$")).first
            if await locator.count() == 0:
                continue
            box = await locator.bounding_box()
            if not box or box["width"] < 20 or box["height"] < 20:
                continue
            await locator.click(timeout=2_000)
            await page.wait_for_timeout(350)
            return True
        except Exception:
            continue
    return False


async def _click_add_to_bag(page: Any) -> bool:
    for name in ("ADD TO BAG", "ADD TO CART"):
        try:
            button = page.get_by_role("button", name=re.compile(f"^{re.escape(name)}$", re.IGNORECASE)).first
            await button.click(timeout=3_000)
            await page.wait_for_timeout(500)
            return True
        except Exception:
            continue
    for selector in (
        "div",
        "span",
        "a",
    ):
        for name in ("ADD TO BAG", "ADD TO CART"):
            try:
                locator = page.locator(selector).filter(has_text=re.compile(f"^{re.escape(name)}$", re.IGNORECASE)).first
                if await locator.count() == 0:
                    continue
                await locator.scroll_into_view_if_needed(timeout=2_000)
                await locator.click(timeout=3_000)
                await page.wait_for_timeout(700)
                return True
            except Exception:
                continue
    for name in ("ADD TO BAG", "ADD TO CART"):
        try:
            clicked = await page.evaluate(
                """(targetLabel) => {
                    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                    const candidates = Array.from(document.querySelectorAll('button, a, div, span'));
                    const target = normalize(targetLabel);
                    for (const candidate of candidates) {
                        const text = normalize(candidate.innerText || candidate.textContent);
                        if (text !== target) continue;
                        const rect = candidate.getBoundingClientRect();
                        if (rect.width < 40 || rect.height < 20) continue;
                        const style = window.getComputedStyle(candidate);
                        if (style.visibility === 'hidden' || style.display === 'none') continue;
                        candidate.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                        return true;
                    }
                    return false;
                }""",
                name,
            )
            if clicked:
                await page.wait_for_timeout(700)
                return True
        except Exception:
            continue
    return False


async def _open_bag(page: Any) -> bool:
    bag_targets = [
        ("link", re.compile(r"GO TO BAG", re.IGNORECASE)),
        ("link", re.compile(r"BAG", re.IGNORECASE)),
        ("button", re.compile(r"GO TO BAG", re.IGNORECASE)),
        ("button", re.compile(r"BAG", re.IGNORECASE)),
    ]
    for role, name in bag_targets:
        try:
            locator = page.get_by_role(role, name=name).first
            await locator.click(timeout=3_000)
            await page.wait_for_timeout(700)
            return True
        except Exception:
            continue
    try:
        locator = page.locator("text=/^GO TO BAG$/i").first
        if await locator.count() > 0:
            await locator.click(timeout=3_000)
            await page.wait_for_timeout(700)
            return True
    except Exception:
        pass
    try:
        locator = page.locator("a[href*='checkout/cart'], a[href*='bag']").first
        if await locator.count() > 0:
            await locator.click(timeout=3_000)
            await page.wait_for_timeout(700)
            return True
    except Exception:
        pass
    try:
        await page.goto("https://www.myntra.com/checkout/cart", wait_until="domcontentloaded", timeout=8_000)
        await page.wait_for_timeout(900)
        return True
    except Exception:
        return False
    return False


async def _place_order(page: Any) -> bool:
    for role in ("button", "link"):
        try:
            locator = page.get_by_role(role, name=re.compile(r"PLACE ORDER", re.IGNORECASE)).first
            await locator.click(timeout=4_000)
            await page.wait_for_timeout(1_000)
            return True
        except Exception:
            continue
    for selector in ("div", "span", "a"):
        try:
            locator = page.locator(selector).filter(has_text=re.compile(r"^PLACE ORDER$", re.IGNORECASE)).first
            if await locator.count() == 0:
                continue
            await locator.scroll_into_view_if_needed(timeout=2_000)
            await locator.click(timeout=4_000)
            await page.wait_for_timeout(1_000)
            return True
        except Exception:
            continue
    return False


def _checkout_ready(page_state: dict[str, Any]) -> bool:
    combined = f"{page_state.get('url', '')} {page_state.get('title', '')} {page_state.get('body_text', '')}".lower()
    return any(
        marker in combined
        for marker in (
            "checkout",
            "place order",
            "login or signup",
            "login to continue",
            "shipping address",
            "select delivery address",
            "payment",
        )
    )


async def run_myntra_demo_flow(
    *,
    prompt: str,
    cdp_url: str,
    on_event: ComputerUseEventCallback | None = None,
) -> ComputerUseResult:
    playwright = None
    browser = None
    context = None
    page = None
    created_context = False
    steps: list[ComputerUseStepRecord] = []
    try:
        playwright, browser, context, page, created_context = await _connect_page(cdp_url)

        await _emit_action(on_event, index=0, action="navigate", reason="Opening Myntra.")
        await _navigate_with_retries(page, "https://www.myntra.com/", cdp_url=cdp_url)
        playwright, browser, context, page, created_context = await _reconnect_page(cdp_url, playwright)
        page = _select_active_page(browser, page, preferred_url="https://www.myntra.com/")
        await _dismiss_myntra_overlays(page)
        state = await _append_step(steps=steps, index=0, action="navigate", reason="Opened Myntra.", page=page)
        await _emit_observation(on_event, 0, page)

        await _emit_action(on_event, index=1, action="type", reason="Searching for maroon shirts.")
        await _search_for_maroon_shirt(page)
        await _dismiss_myntra_overlays(page)
        state = await _append_step(steps=steps, index=1, action="type", reason="Searched for maroon shirts.", page=page)
        await _emit_observation(on_event, 1, page)

        candidate = await _find_first_affordable_result(page, 1000)
        if not candidate:
            return ComputerUseResult(
                success=False,
                final_message="I couldn't find a visible maroon shirt under 1000 rupees on the current Myntra results page.",
                steps=steps,
                error="no_affordable_result",
            )

        await _emit_action(
            on_event,
            index=2,
            action="click",
            reason=f"Opening the first visible result under 1000 rupees ({candidate.get('price', 'unknown price')}).",
        )
        await page.mouse.click(int(candidate["x"]), int(candidate["y"]))
        await page.wait_for_timeout(1_100)
        page = _select_active_page(browser, page, preferred_url=str(candidate.get("href", "") or None))
        await _stabilize_page(page)
        state = await _append_step(
            steps=steps,
            index=2,
            action="click",
            reason="Opened the first qualifying shirt from the results list.",
            page=page,
        )
        await _emit_observation(on_event, 2, page)

        await _dismiss_myntra_overlays(page)
        await _emit_action(on_event, index=3, action="click", reason="Selecting size M.")
        if not await _select_size_m(page):
            return ComputerUseResult(
                success=False,
                final_message="I opened the first qualifying shirt, but size M was not available to select.",
                steps=steps,
                error="size_unavailable",
            )
        state = await _append_step(steps=steps, index=3, action="click", reason="Selected size M.", page=page)
        await _emit_observation(on_event, 3, page)

        await _emit_action(on_event, index=4, action="click", reason="Adding the shirt to the bag.")
        if not await _click_add_to_bag(page):
            return ComputerUseResult(
                success=False,
                final_message="I selected size M, but I couldn't find the add-to-bag button on the product page.",
                steps=steps,
                error="add_to_bag_not_found",
            )
        state = await _append_step(steps=steps, index=4, action="click", reason="Added the shirt to the bag.", page=page)
        await _emit_observation(on_event, 4, page)

        await _emit_action(on_event, index=5, action="click", reason="Opening the shopping bag.")
        if not await _open_bag(page):
            return ComputerUseResult(
                success=False,
                final_message="The shirt was added to the bag, but I couldn't open the bag automatically.",
                steps=steps,
                error="bag_navigation_failed",
            )
        state = await _append_step(steps=steps, index=5, action="click", reason="Opened the shopping bag.", page=page)
        await _emit_observation(on_event, 5, page)

        await _emit_action(on_event, index=6, action="click", reason="Proceeding to checkout.")
        if not await _place_order(page):
            return ComputerUseResult(
                success=False,
                final_message="The bag is open, but I couldn't find the place-order button to proceed to checkout.",
                steps=steps,
                error="checkout_button_missing",
            )
        state = await _append_step(steps=steps, index=6, action="click", reason="Proceeded to checkout.", page=page)
        await _emit_observation(on_event, 6, page)

        if _checkout_ready(state):
            message = "Myntra checkout is ready. Login, captcha, or payment may need your attention."
            await _emit(on_event, {"type": "done", "payload": {"message": message}})
            return ComputerUseResult(
                success=True,
                final_message=message,
                steps=steps,
                terminal_state="waiting_for_human",
                reason_code="CHECKOUT_READY",
            )

        return ComputerUseResult(
            success=False,
            final_message="I reached the checkout transition, but the final checkout screen did not become visible yet.",
            steps=steps,
            error="checkout_not_reached",
        )
    finally:
        if created_context and context is not None:
            try:
                await context.close()
            except Exception:
                logger.debug("myntra_demo_context_close_failed", exc_info=True)
        if playwright is not None:
            await playwright.stop()
