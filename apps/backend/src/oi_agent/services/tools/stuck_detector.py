"""Stuck Detector — uses Gemini Vision to analyze browser screenshots for states
that require human intervention.

Detected states:
- CAPTCHA / reCAPTCHA
- Payment pages (credit card forms, UPI, checkout)
- Login walls / session expired
- MFA / 2FA / OTP prompts
- Bot detection (Cloudflare, "Are you human?")
- Terms & conditions acceptance
- Identity verification
- Unexpected popups / modals / overlays
"""
from __future__ import annotations

import base64
import logging
from dataclasses import dataclass
from typing import Any

from oi_agent.config import settings

logger = logging.getLogger(__name__)

ANALYSIS_PROMPT = """Analyze this browser screenshot and determine if the automation should pause for human intervention.

Look for ANY of these blocking states:
1. CAPTCHA or reCAPTCHA (image puzzles, "I'm not a robot" checkbox, visual challenges)
2. Payment page (credit card form, UPI input, payment gateway, checkout with card fields)
3. Login required (sign-in form, "please log in", session expired)
4. MFA/2FA (enter code, authenticator, SMS verification, OTP input)
5. Bot detection (Cloudflare challenge, "checking your browser", "verify you are human")
6. Terms acceptance (legal agreement, cookie consent blocking content, "accept terms")
7. Identity verification (upload documents, verify identity, KYC)
8. Blocking popup/modal (survey, promo overlay that blocks interaction, age verification)
9. Error page (404, 500, "something went wrong", connection error)

Respond with ONLY a JSON object:
{
  "is_stuck": true/false,
  "reason": "short description of what's blocking" or null,
  "type": "captcha" | "payment" | "login_required" | "mfa" | "bot_detection" | "terms" | "identity" | "popup" | "error" | null,
  "confidence": 0.0 to 1.0,
  "suggested_action": "what the user should do" or null
}
"""


@dataclass
class StuckAnalysis:
    is_stuck: bool
    reason: str | None = None
    stuck_type: str | None = None
    confidence: float = 0.0
    suggested_action: str | None = None


async def analyze_screenshot(screenshot_base64: str) -> StuckAnalysis:
    """Use Gemini Vision to determine if a browser screenshot shows a stuck state.

    Args:
        screenshot_base64: Base64-encoded JPEG/PNG image (may include data: prefix)

    Returns:
        StuckAnalysis with detection results
    """
    try:
        from google import genai
        from google.genai import types

        client = genai.Client(
            vertexai=settings.google_genai_use_vertexai,
            project=settings.gcp_project,
            location=settings.gcp_location,
        )

        image_data = screenshot_base64
        if "," in image_data:
            image_data = image_data.split(",", 1)[1]

        raw_bytes = base64.b64decode(image_data)

        response = await client.aio.models.generate_content(
            model=settings.gemini_model,
            contents=[
                {
                    "role": "user",
                    "parts": [
                        {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(raw_bytes).decode()}},
                        {"text": ANALYSIS_PROMPT},
                    ],
                },
            ],
            config=types.GenerateContentConfig(temperature=0.1),
        )

        raw = (response.text or "{}").strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw
            if raw.endswith("```"):
                raw = raw[:raw.rfind("```")]

        import json
        result = json.loads(raw)

        return StuckAnalysis(
            is_stuck=result.get("is_stuck", False),
            reason=result.get("reason"),
            stuck_type=result.get("type"),
            confidence=result.get("confidence", 0.0),
            suggested_action=result.get("suggested_action"),
        )

    except Exception as exc:
        logger.warning("Stuck detection failed: %s", exc)
        return StuckAnalysis(is_stuck=False)


async def check_if_stuck(screenshot_base64: str, threshold: float = 0.7) -> StuckAnalysis | None:
    """Convenience wrapper that returns StuckAnalysis only if confident enough.

    Returns None if not stuck or confidence is below threshold.
    """
    analysis = await analyze_screenshot(screenshot_base64)
    if analysis.is_stuck and analysis.confidence >= threshold:
        logger.info(
            "Stuck detected: type=%s confidence=%.2f reason=%s",
            analysis.stuck_type, analysis.confidence, analysis.reason,
        )
        return analysis
    return None
