from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from oi_agent.automation.intent_extractor import resolve_model_selection
from oi_agent.config import settings

logger = logging.getLogger(__name__)


def _ai_available() -> bool:
    return (
        (bool(settings.gcp_project.strip()) and bool(settings.google_genai_use_vertexai))
        or bool(settings.google_api_key.strip())
    )


def _slot_extraction_prompt(text: str, field_names: list[str]) -> str:
    schema = {field_name: "string" for field_name in field_names}
    return (
        "Extract only values that are explicitly present in the user text for the requested fields.\n"
        "Return valid JSON only as an object mapping field names to extracted string values.\n"
        "Do not infer, guess, or synthesize missing values.\n"
        "If a requested field is not explicitly provided, omit it from the JSON.\n"
        f"Requested fields: {json.dumps(field_names)}\n"
        f"Output schema: {json.dumps(schema)}\n\n"
        f"User text: {text}"
    )


def _normalize_extracted_slots(payload: dict[str, Any], field_names: list[str]) -> dict[str, str]:
    allowed = set(field_names)
    normalized: dict[str, str] = {}
    for key, raw_value in payload.items():
        if key not in allowed or raw_value is None:
            continue
        value = str(raw_value).strip()
        if value:
            normalized[key] = value
    return normalized


async def extract_slots_for_fields(
    text: str,
    field_names: list[str],
    *,
    requested_model: str | None = None,
) -> dict[str, str]:
    requested = [str(field_name).strip() for field_name in field_names if str(field_name).strip()]
    if not text.strip() or not requested or not _ai_available():
        return {}
    try:
        from google import genai
        from google.genai import types

        model_name, location = resolve_model_selection(requested_model)
        client = genai.Client(
            vertexai=settings.google_genai_use_vertexai,
            project=settings.gcp_project or None,
            location=location,
            api_key=None if settings.google_genai_use_vertexai else (settings.google_api_key or None),
        )
        response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=model_name,
                contents=[{"role": "user", "parts": [{"text": _slot_extraction_prompt(text, requested)}]}],
                config=types.GenerateContentConfig(temperature=0.0),
            ),
            timeout=min(settings.request_timeout_seconds, 20),
        )
        raw = str(response.text or "").strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw
            if raw.endswith("```"):
                raw = raw[: raw.rfind("```")]
            raw = raw.strip()
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            return {}
        return _normalize_extracted_slots(parsed, requested)
    except Exception:
        logger.warning(
            "slot_extraction_failed",
            extra={"requested_fields": requested, "requested_model": str(requested_model or "")},
            exc_info=True,
        )
        return {}
