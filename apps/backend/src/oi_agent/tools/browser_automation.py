from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_browser: Any = None
_playwright: Any = None


async def _get_browser() -> Any:
    """Lazy-init a headless Chromium browser via Playwright."""
    global _browser, _playwright
    if _browser is not None:
        return _browser

    try:
        from playwright.async_api import async_playwright

        _playwright = await async_playwright().start()
        _browser = await _playwright.chromium.launch(headless=True)
        logger.info("Playwright browser launched")
    except Exception as exc:
        raise RuntimeError(f"Playwright not available: {exc}") from exc

    return _browser


async def navigate_to(url: str) -> dict[str, Any]:
    """Open a URL in a new browser page and return the page title."""
    browser = await _get_browser()
    page = await browser.new_page()
    await page.goto(url, wait_until="domcontentloaded", timeout=30000)
    title = await page.title()
    return {"url": url, "title": title, "page": page}


async def click_element(page: Any, selector: str) -> str:
    """Click an element on the page by CSS selector."""
    try:
        await page.click(selector, timeout=10000)
        return f"Clicked: {selector}"
    except Exception as exc:
        return f"Click failed on {selector}: {exc}"


async def fill_input(page: Any, selector: str, value: str) -> str:
    """Fill a text input on the page."""
    try:
        await page.fill(selector, value, timeout=10000)
        return f"Filled {selector} with value"
    except Exception as exc:
        return f"Fill failed on {selector}: {exc}"


async def take_screenshot(page: Any) -> bytes:
    """Capture a screenshot of the current page."""
    return await page.screenshot(full_page=False)


async def get_page_text(page: Any) -> str:
    """Extract visible text content from the page."""
    return await page.inner_text("body")


async def close_page(page: Any) -> None:
    """Close a browser page."""
    try:
        await page.close()
    except Exception:
        pass


async def shutdown_browser() -> None:
    """Close the browser and Playwright instance."""
    global _browser, _playwright
    if _browser:
        await _browser.close()
        _browser = None
    if _playwright:
        await _playwright.stop()
        _playwright = None
