from __future__ import annotations

import asyncio
import logging

from oi_agent.automation.intent_extractor import resolve_model_selection
from oi_agent.config import settings

logger = logging.getLogger(__name__)


REWRITE_SYSTEM_PROMPT = """You rewrite user browser-automation prompts into explicit, execution-safe instructions.

Rules:
- Preserve intent exactly; do not add new goals.
- Remove platform suffix noise from entities (example: "tortoise on whatsapp" -> "tortoise" as contact name, with platform context kept separately).
- Avoid assumptions. If a detail is unknown, keep it generic ("the target chat", "first matching result").
- Keep output short, imperative, and agent-friendly.
- Do not include explanations.
- Return only rewritten prompt text.
"""


async def _call_rewriter(raw_prompt: str, context: str, model_override: str | None = None) -> str:
    from google import genai
    from google.genai import types

    model_name, location = resolve_model_selection(model_override)
    client = genai.Client(
        vertexai=settings.google_genai_use_vertexai,
        project=settings.gcp_project or None,
        location=location,
        api_key=None if settings.google_genai_use_vertexai else (settings.google_api_key or None),
    )
    response = await client.aio.models.generate_content(
        model=model_name,
        contents=[
            {
                "role": "user",
                "parts": [
                    {
                        "text": (
                            f"{REWRITE_SYSTEM_PROMPT}\n\n"
                            f"Context: {context}\n"
                            f"Original prompt: {raw_prompt}\n"
                            "Rewritten prompt:"
                        )
                    }
                ],
            }
        ],
        config=types.GenerateContentConfig(temperature=0.1),
    )
    text = (response.text or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        if text.endswith("```"):
            text = text[:text.rfind("```")]
        text = text.strip()
    return text


async def rewrite_user_prompt(
    *,
    user_prompt: str,
    current_url: str = "",
    current_page_title: str = "",
    model_override: str | None = None,
    timeout_seconds: float = 8.0,
) -> str:
    """Rewrite prompt for planning robustness; fallback to original prompt on failures."""
    prompt = (user_prompt or "").strip()
    if not prompt:
        return prompt

    context = f"url={current_url or 'unknown'}; title={current_page_title or 'unknown'}"
    try:
        rewritten = await asyncio.wait_for(
            _call_rewriter(prompt, context, model_override=model_override),
            timeout=timeout_seconds,
        )
        rewritten = (rewritten or "").strip()
        if not rewritten:
            return prompt
        # prevent runaway expansions
        if len(rewritten) > max(800, len(prompt) * 3):
            return prompt
        return rewritten
    except Exception as exc:
        logger.debug("Prompt rewrite failed, using original: %s", exc)
        return prompt
