from __future__ import annotations

import asyncio
import logging

from oi_agent.automation.intent_extractor import resolve_model_selection
from oi_agent.config import settings
from oi_agent.services.tools.navigator.context_builder import build_navigator_prompt_bundle

logger = logging.getLogger(__name__)

async def _call_rewriter(
    *,
    system_prompt: str,
    task_prompt: str,
    model_override: str | None = None,
) -> str:
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
                        "text": f"{system_prompt}\n\n{task_prompt}\n\nRewritten prompt:"
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
    playbook_context: str = "",
    model_override: str | None = None,
    timeout_seconds: float = 8.0,
) -> str:
    """Rewrite prompt for planning robustness; fallback to original prompt on failures."""
    prompt = (user_prompt or "").strip()
    if not prompt:
        return prompt

    bundle = build_navigator_prompt_bundle(
        task="browser_prompt_rewriter",
        user_prompt=prompt,
        current_url=current_url,
        current_page_title=current_page_title,
        runtime_metadata={"task": "prompt_rewrite"},
        sections=[("Playbook Context", playbook_context)],
    )
    logger.info("navigator_prompt_rewriter_context", extra=bundle.debug)
    try:
        rewritten = await asyncio.wait_for(
            _call_rewriter(
                system_prompt=bundle.system_prompt,
                task_prompt=bundle.task_prompt,
                model_override=model_override,
            ),
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
