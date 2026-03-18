from __future__ import annotations

import base64
import logging
import re
from dataclasses import dataclass
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


@dataclass
class GmailWhatsAppDemoRequest:
    email_to: str
    email_subject: str
    email_body: str
    whatsapp_contact: str


def parse_gmail_whatsapp_demo_prompt(prompt: str) -> GmailWhatsAppDemoRequest | None:
    normalized = re.sub(r"\s+", " ", str(prompt or "").strip())
    lowered = normalized.lower()
    if "gmail" not in lowered or "whatsapp" not in lowered or "send an email" not in lowered:
        return None

    email_match = re.search(r"send an email to\s+([A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,})", normalized, re.IGNORECASE)
    subject_match = re.search(r"subject\s+is\s+(.+?)(?:,\s*email\s+is|\s+email\s+is|$)", normalized, re.IGNORECASE)
    body_match = re.search(
        r"(?:email\s+is|body\s+is)\s+(.+?)(?:,\s*(?:and then )?go to whatsapp|\s+(?:and then )?go to whatsapp|$)",
        normalized,
        re.IGNORECASE,
    )
    contact_match = re.search(
        r"(?:go to whatsapp(?: and then)? send the same message to|go to whatsapp and then send the same message to|send the same message to)\s+([A-Za-z0-9 _.\-]+)$",
        lowered,
        re.IGNORECASE,
    )

    if not email_match or not subject_match or not body_match or not contact_match:
        return None

    email_to = email_match.group(1).strip()
    email_subject = subject_match.group(1).strip(" ,.")
    email_body = body_match.group(1).strip(" ,.")
    whatsapp_contact = contact_match.group(1).strip(" ,.")
    if not email_to or not email_subject or not email_body or not whatsapp_contact:
        return None

    return GmailWhatsAppDemoRequest(
        email_to=email_to,
        email_subject=email_subject,
        email_body=email_body,
        whatsapp_contact=whatsapp_contact,
    )


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


async def _emit_action(on_event: ComputerUseEventCallback | None, *, index: int, action: str, reason: str) -> None:
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


def _gmail_login_needed(state: dict[str, Any]) -> bool:
    text = f"{state.get('title', '')} {state.get('body_text', '')} {state.get('url', '')}".lower()
    return any(marker in text for marker in ("sign in", "choose an account", "use your google account"))


def _whatsapp_login_needed(state: dict[str, Any]) -> bool:
    text = f"{state.get('title', '')} {state.get('body_text', '')} {state.get('url', '')}".lower()
    return any(marker in text for marker in ("link with phone", "scan this qr code", "use whatsapp on your computer"))


async def _click_first(page: Any, selectors: list[tuple[str, str]]) -> bool:
    for kind, value in selectors:
        try:
            if kind == "role_button":
                await page.get_by_role("button", name=re.compile(value, re.IGNORECASE)).first.click(timeout=3_500)
            elif kind == "role_link":
                await page.get_by_role("link", name=re.compile(value, re.IGNORECASE)).first.click(timeout=3_500)
            elif kind == "text":
                await page.locator(f"text=/{value}/i").first.click(timeout=3_500)
            else:
                locator = page.locator(value).first
                if await locator.count() == 0:
                    continue
                await locator.click(timeout=3_500)
            await page.wait_for_timeout(500)
            return True
        except Exception:
            continue
    return False


async def _open_gmail_compose(page: Any) -> bool:
    return await _click_first(
        page,
        [
            ("role_button", "^compose$"),
            ("css", "div[role='button'][gh='cm']"),
            ("css", "div.T-I.T-I-KE.L3"),
            ("text", "^compose$"),
        ],
    )


async def _fill_gmail_message(page: Any, request: GmailWhatsAppDemoRequest) -> bool:
    try:
        to_input = page.locator("input[aria-label*='To recipients'], input[peoplekit-id='BbVjBd']").first
        await to_input.fill(request.email_to, timeout=4_000)
        await page.wait_for_timeout(300)
    except Exception:
        return False

    try:
        subject_input = page.locator("input[name='subjectbox']").first
        await subject_input.fill(request.email_subject, timeout=4_000)
    except Exception:
        return False

    try:
        body_input = page.locator("div[aria-label='Message Body'], div[role='textbox'][aria-label='Message Body']").first
        await body_input.click(timeout=3_000)
        await body_input.fill(request.email_body, timeout=4_000)
        return True
    except Exception:
        return False


async def _send_gmail_message(page: Any) -> bool:
    if await _click_first(
        page,
        [
            ("role_button", "^send$"),
            ("css", "div[role='button'][data-tooltip^='Send']"),
            ("text", "^send$"),
        ],
    ):
        return True
    try:
        await page.keyboard.press("Meta+Enter")
        await page.wait_for_timeout(800)
        return True
    except Exception:
        return False


async def _open_whatsapp_contact(page: Any, contact_name: str) -> bool:
    search_selectors = [
        "div[contenteditable='true'][data-tab='3']",
        "div[contenteditable='true'][role='textbox']",
        "div[aria-label*='Search input textbox']",
    ]
    for selector in search_selectors:
        try:
            search = page.locator(selector).first
            if await search.count() == 0:
                continue
            await search.click(timeout=3_000)
            try:
                await page.keyboard.press("Meta+A")
            except Exception:
                try:
                    await page.keyboard.press("Control+A")
                except Exception:
                    pass
            await search.fill(contact_name, timeout=4_000)
            await page.wait_for_timeout(800)
            break
        except Exception:
            continue
    else:
        return False

    contact_patterns = [
        f"^{re.escape(contact_name)}$",
        re.escape(contact_name),
    ]
    for pattern in contact_patterns:
        if await _click_first(
            page,
            [
                ("role_button", pattern),
                ("text", pattern),
            ],
        ):
            return True
    try:
        candidate = page.locator(f"span[title='{contact_name}']").first
        if await candidate.count() > 0:
            await candidate.click(timeout=3_000)
            await page.wait_for_timeout(500)
            return True
    except Exception:
        return False
    return False


async def _send_whatsapp_message(page: Any, text: str) -> bool:
    message_box_selectors = [
        "div[contenteditable='true'][data-tab='10']",
        "footer div[contenteditable='true'][role='textbox']",
        "div[aria-placeholder='Type a message']",
    ]
    for selector in message_box_selectors:
        try:
            box = page.locator(selector).last
            if await box.count() == 0:
                continue
            await box.click(timeout=3_000)
            await box.fill(text, timeout=4_000)
            await page.wait_for_timeout(250)
            break
        except Exception:
            continue
    else:
        return False

    if await _click_first(
        page,
        [
            ("role_button", "^send$"),
            ("css", "button[aria-label='Send']"),
            ("css", "span[data-icon='send']"),
        ],
    ):
        return True
    try:
        await page.keyboard.press("Enter")
        await page.wait_for_timeout(500)
        return True
    except Exception:
        return False


async def run_gmail_whatsapp_demo_flow(
    *,
    prompt: str,
    cdp_url: str,
    on_event: ComputerUseEventCallback | None = None,
) -> ComputerUseResult:
    request = parse_gmail_whatsapp_demo_prompt(prompt)
    if request is None:
        return ComputerUseResult(success=False, final_message="I couldn't parse the Gmail to WhatsApp demo prompt.", error="invalid_demo_prompt")

    playwright = None
    browser = None
    context = None
    page = None
    created_context = False
    steps: list[ComputerUseStepRecord] = []
    whatsapp_message = f"Subject: {request.email_subject}\n{request.email_body}"

    try:
        playwright, browser, context, page, created_context = await _connect_page(cdp_url)

        await _emit_action(on_event, index=0, action="navigate", reason="Opening Gmail.")
        await _navigate_with_retries(page, "https://mail.google.com/mail/u/0/#inbox", cdp_url=cdp_url)
        playwright, browser, context, page, created_context = await _reconnect_page(cdp_url, playwright)
        page = _select_active_page(browser, page, preferred_url="https://mail.google.com/")
        state = await _append_step(steps=steps, index=0, action="navigate", reason="Opened Gmail.", page=page)
        await _emit_observation(on_event, 0, page)
        if _gmail_login_needed(state):
            message = "Gmail is asking for login or account confirmation. Please complete it and retry."
            return ComputerUseResult(success=True, final_message=message, steps=steps, terminal_state="waiting_for_human", reason_code="GMAIL_LOGIN_REQUIRED")

        await _emit_action(on_event, index=1, action="click", reason="Opening Gmail compose.")
        if not await _open_gmail_compose(page):
            return ComputerUseResult(success=False, final_message="I couldn't open Gmail compose in the current session.", steps=steps, error="gmail_compose_missing")
        state = await _append_step(steps=steps, index=1, action="click", reason="Opened Gmail compose.", page=page)
        await _emit_observation(on_event, 1, page)

        await _emit_action(on_event, index=2, action="type", reason="Filling recipient, subject, and email body.")
        if not await _fill_gmail_message(page, request):
            return ComputerUseResult(success=False, final_message="I couldn't fill the Gmail compose fields automatically.", steps=steps, error="gmail_fill_failed")
        state = await _append_step(steps=steps, index=2, action="type", reason="Filled the Gmail draft.", page=page)
        await _emit_observation(on_event, 2, page)

        await _emit_action(on_event, index=3, action="click", reason="Sending the email.")
        if not await _send_gmail_message(page):
            return ComputerUseResult(success=False, final_message="I filled the Gmail draft, but I couldn't send it automatically.", steps=steps, error="gmail_send_failed")
        state = await _append_step(steps=steps, index=3, action="click", reason="Sent the Gmail message.", page=page)
        await _emit_observation(on_event, 3, page)

        await _emit_action(on_event, index=4, action="navigate", reason="Opening WhatsApp Web.")
        await _navigate_with_retries(page, "https://web.whatsapp.com/", cdp_url=cdp_url)
        playwright, browser, context, page, created_context = await _reconnect_page(cdp_url, playwright)
        page = _select_active_page(browser, page, preferred_url="https://web.whatsapp.com/")
        state = await _append_step(steps=steps, index=4, action="navigate", reason="Opened WhatsApp Web.", page=page)
        await _emit_observation(on_event, 4, page)
        if _whatsapp_login_needed(state):
            message = "WhatsApp Web needs phone linking or login. Please complete that step and retry."
            return ComputerUseResult(success=True, final_message=message, steps=steps, terminal_state="waiting_for_human", reason_code="WHATSAPP_LOGIN_REQUIRED")

        await _emit_action(on_event, index=5, action="click", reason=f"Opening the WhatsApp chat for {request.whatsapp_contact}.")
        if not await _open_whatsapp_contact(page, request.whatsapp_contact):
            message = f"I couldn't find the WhatsApp contact '{request.whatsapp_contact}'. Please open that chat or check the contact name and retry."
            return ComputerUseResult(success=True, final_message=message, steps=steps, terminal_state="waiting_for_human", reason_code="WHATSAPP_CONTACT_NOT_FOUND")
        state = await _append_step(steps=steps, index=5, action="click", reason="Opened the WhatsApp chat.", page=page)
        await _emit_observation(on_event, 5, page)

        await _emit_action(on_event, index=6, action="type", reason="Sending the same message on WhatsApp.")
        if not await _send_whatsapp_message(page, whatsapp_message):
            return ComputerUseResult(success=False, final_message="I opened the WhatsApp chat, but I couldn't send the copied message automatically.", steps=steps, error="whatsapp_send_failed")
        await _append_step(steps=steps, index=6, action="type", reason="Sent the WhatsApp message.", page=page)
        await _emit_observation(on_event, 6, page)

        message = f"I sent the Gmail message to {request.email_to} and sent the same message to {request.whatsapp_contact} on WhatsApp."
        await _emit(on_event, {"type": "done", "payload": {"message": message}})
        return ComputerUseResult(success=True, final_message=message, steps=steps)
    finally:
        if created_context and context is not None:
            try:
                await context.close()
            except Exception:
                logger.debug("gmail_whatsapp_demo_context_close_failed", exc_info=True)
        if playwright is not None:
            await playwright.stop()
