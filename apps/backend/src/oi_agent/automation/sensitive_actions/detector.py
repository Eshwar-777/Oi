from __future__ import annotations

from typing import Any


def _normalize_text(value: Any) -> str:
    return " ".join(str(value or "").lower().split())


def detect_sensitive_step(step: dict[str, Any]) -> dict[str, Any] | None:
    action = _normalize_text(step.get("command") or step.get("action"))
    target = step.get("target")
    parts = [
        _normalize_text(step.get("description")),
        _normalize_text(step.get("value")),
    ]
    if isinstance(target, str):
        parts.append(_normalize_text(target))
    elif isinstance(target, dict):
        parts.extend(
            _normalize_text(target.get(field))
            for field in ("value", "name", "text", "label", "role")
        )
    joined = " ".join(part for part in parts if part)

    if action == "type" and any(token in joined for token in ("password", "otp", "one time", "verification code")):
        return {
            "reason_code": "AUTH_INPUT",
            "reason_text": "A password or verification input is about to be filled. Human approval is required.",
            "signals": ["step:type", "credential_input"],
        }
    if action in {"click", "select"} and any(
        token in joined
        for token in ("delete", "remove", "destroy", "pay", "purchase", "transfer", "checkout", "confirm payment")
    ):
        return {
            "reason_code": "HIGH_RISK_ACTION",
            "reason_text": "The next step appears to confirm a payment or destructive action. Human approval is required.",
            "signals": ["step:click", "high_risk_text"],
        }
    return None


async def detect_sensitive_page(page: Any) -> dict[str, Any] | None:
    payload = await page.evaluate(
        """
        () => {
          const text = (document.body?.innerText || "").toLowerCase();
          const url = location.href.toLowerCase();
          const passwordInput = Boolean(document.querySelector('input[type="password"]'));
          const otpInput = Boolean(document.querySelector('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i]'));
          const captcha = Boolean(
            document.querySelector('iframe[src*="captcha" i], iframe[src*="recaptcha" i], [data-sitekey], .g-recaptcha')
          ) || text.includes("captcha");
          const payment = Boolean(
            document.querySelector('input[name*="card" i], input[autocomplete="cc-number"], [data-testid*="payment" i]')
          ) || /(checkout|pay now|purchase|billing|card number)/.test(text);
          const destructiveSelector = [
            'button',
            '[role="button"]',
            '[type="submit"]',
            '[aria-label]',
            '[title]',
            '[role="menuitem"]',
            '[role="option"]'
          ].join(', ');
          const destructiveKeywords = /(delete|remove|destroy|permanently|erase|discard account|delete account)/i;
          const visibleDestructiveControls = Array.from(document.querySelectorAll(destructiveSelector))
            .filter((el) => {
              if (!(el instanceof HTMLElement)) return false;
              const rect = el.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) return false;
              const style = getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') return false;
              const label = [
                el.innerText || el.textContent || '',
                el.getAttribute('aria-label') || '',
                el.getAttribute('title') || '',
                el.getAttribute('value') || '',
              ].join(' ').trim();
              return destructiveKeywords.test(label);
            })
            .slice(0, 5)
            .map((el) => {
              const label = [
                el.innerText || el.textContent || '',
                el.getAttribute('aria-label') || '',
                el.getAttribute('title') || '',
                el.getAttribute('value') || '',
              ].join(' ').trim();
              return label.toLowerCase();
            });
          const destructiveContext = /(are you sure|cannot be undone|permanently delete|remove .* from|delete .* account)/.test(text);
          const destructive = visibleDestructiveControls.length > 0 && destructiveContext;
          const permission = /(allow access|grant access|authorize app|oauth consent|permissions)/.test(text);
          const login = passwordInput || /(sign in|log in|login|continue with google|continue with microsoft)/.test(text) || /(login|signin|auth)/.test(url);
          const mfa = otpInput || /(two-factor|2fa|multi-factor|verification code|one-time code)/.test(text);

          return {
            url,
            login,
            mfa,
            captcha,
            payment,
            destructive,
            destructiveSignals: visibleDestructiveControls,
            permission,
          };
        }
        """
    )

    if payload.get("captcha"):
        return {
            "reason_code": "CAPTCHA",
            "reason_text": "A CAPTCHA or anti-bot challenge was detected. Human takeover is required.",
            "signals": ["dom:captcha"],
            "url": payload.get("url", ""),
        }
    if payload.get("mfa"):
        return {
            "reason_code": "MFA_REQUIRED",
            "reason_text": "A verification or MFA step was detected. Human approval is required.",
            "signals": ["dom:mfa"],
            "url": payload.get("url", ""),
        }
    if payload.get("login"):
        return {
            "reason_code": "LOGIN_REQUIRED",
            "reason_text": "A login or re-authentication page was detected. Human approval is required.",
            "signals": ["dom:login"],
            "url": payload.get("url", ""),
        }
    if payload.get("payment"):
        return {
            "reason_code": "PAYMENT_FLOW",
            "reason_text": "A payment or checkout flow was detected. Human approval is required.",
            "signals": ["dom:payment"],
            "url": payload.get("url", ""),
        }
    if payload.get("destructive"):
        return {
            "reason_code": "DESTRUCTIVE_ACTION",
            "reason_text": "A destructive action page was detected. Human approval is required.",
            "signals": ["dom:destructive", *list(payload.get("destructiveSignals", []) or [])[:3]],
            "url": payload.get("url", ""),
        }
    if payload.get("permission"):
        return {
            "reason_code": "PERMISSION_CHANGE",
            "reason_text": "A permission or consent flow was detected. Human approval is required.",
            "signals": ["dom:permission"],
            "url": payload.get("url", ""),
        }
    return None
