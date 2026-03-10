from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any

from oi_agent.config import settings
from oi_agent.prompts.loader import load_prompt

logger = logging.getLogger(__name__)

_BACKEND_TEXT_MODEL_ALLOWLIST = {
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-2.0-pro",
}


def _truncate_log_text(value: Any, limit: int = 2000) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return text[:limit] + "...<truncated>"

def _load_intent_extraction_prompt() -> str:
    try:
        return load_prompt("tasks/browser_intent_interpreter.md")
    except Exception as exc:
        logger.debug("Failed to load browser intent interpreter prompt: %s", exc)
        return (
            "You extract structured browser automation intent from a user request. "
            "Return valid JSON only with fields for user_goal, goal_type, task_kind, "
            "execution_intent, workflow_outline, clarification_hints, entities, timing_mode, "
            "timing_candidates, can_automate, confidence, risk_flags, and missing_fields."
        )


@dataclass
class IntentExtraction:
    user_goal: str
    goal_type: str
    task_kind: str = "unknown"
    execution_intent: str = "unspecified"
    workflow_outline: list[str] = field(default_factory=list)
    clarification_hints: list[str] = field(default_factory=list)
    entities: dict[str, Any] = field(default_factory=dict)
    timing_mode: str = "unknown"
    timing_candidates: list[str] = field(default_factory=list)
    can_automate: bool = False
    confidence: float = 0.0
    risk_flags: list[str] = field(default_factory=list)
    missing_fields: list[str] = field(default_factory=list)


def _normalize_string_list(values: list[Any] | tuple[Any, ...] | None) -> list[str]:
    if not values:
        return []
    return [str(item).strip() for item in values if str(item).strip()]


def _normalize_execution_intent(value: str, timing_mode: str) -> str:
    normalized = str(value or "").strip()
    if normalized in {"unspecified", "immediate", "once", "recurring"}:
        return normalized
    if timing_mode == "immediate":
        return "immediate"
    if timing_mode == "once":
        return "once"
    if timing_mode in {"interval", "multi_time"}:
        return "recurring"
    return "unspecified"


def _sanitize_missing_fields(
    *,
    text: str,
    entities: dict[str, Any],
    ai_missing_fields: list[str] | None,
) -> list[str]:
    normalized = _normalize_string_list(ai_missing_fields)
    cleaned: list[str] = []
    seen: set[str] = set()
    for field in normalized:
        if field in seen:
            continue
        seen.add(field)
        if field == "goal" and text.strip():
            continue
        if field in {"recipient", "app", "subject", "message_text", "body", "target"} and str(
            entities.get(field, "") or ""
        ).strip():
            continue
        if field == "message_text" and str(entities.get("body", "") or "").strip():
            continue
        if field == "body" and str(entities.get("message_text", "") or "").strip():
            continue
        cleaned.append(field)
    if not text.strip() and "goal" not in cleaned:
        cleaned.insert(0, "goal")
    return cleaned


def flatten_inputs(inputs: list[dict[str, Any]] | list[Any]) -> str:
    parts: list[str] = []
    for item in inputs:
        text = getattr(item, "text", None) if not isinstance(item, dict) else item.get("text")
        transcript = getattr(item, "transcript", None) if not isinstance(item, dict) else item.get("transcript")
        caption = getattr(item, "caption", None) if not isinstance(item, dict) else item.get("caption")
        ocr_text = getattr(item, "ocr_text", None) if not isinstance(item, dict) else item.get("ocr_text")
        summary = getattr(item, "summary", None) if not isinstance(item, dict) else item.get("summary")
        for value in (text, transcript, caption, ocr_text, summary):
            if isinstance(value, str) and value.strip():
                parts.append(value.strip())
    return " ".join(parts).strip()


def _normalize_extracted_entities(entities: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for key, raw_value in entities.items():
        if raw_value is None:
            continue
        value = str(raw_value).strip()
        if not value:
            continue
        normalized[key] = value

    if not normalized.get("message_text"):
        body = str(normalized.get("body", "")).strip()
        if body:
            normalized["message_text"] = body

    if not normalized.get("body"):
        message_text = str(normalized.get("message_text", "")).strip()
        if message_text:
            normalized["body"] = message_text

    app = str(normalized.get("app", "")).strip()
    if app:
        normalized["app"] = app.title()

    return normalized


def _fallback_extract(text: str) -> IntentExtraction:
    cleaned = (text or "").strip()
    workflow_outline = [cleaned] if cleaned else []
    missing_fields = ["goal"] if not cleaned else []
    return IntentExtraction(
        user_goal=cleaned or "Untitled request",
        goal_type="unknown",
        task_kind="unknown",
        execution_intent="unspecified",
        workflow_outline=workflow_outline,
        clarification_hints=[],
        entities={},
        timing_mode="unknown",
        timing_candidates=[],
        can_automate=False,
        confidence=0.0,
        risk_flags=[],
        missing_fields=missing_fields,
    )


def _ai_available() -> bool:
    return (
        (bool(settings.gcp_project.strip()) and bool(settings.google_genai_use_vertexai))
        or bool(settings.google_api_key.strip())
    )


def _is_supported_backend_text_model(model: str) -> bool:
    normalized = str(model or "").strip()
    if not normalized:
        return False
    if normalized in _BACKEND_TEXT_MODEL_ALLOWLIST:
        return True
    if "live" in normalized.lower():
        return False
    return normalized.startswith("gemini-2.5-")


def resolve_model_selection(requested_model: str | None = None) -> tuple[str, str]:
    raw_model = str(requested_model or "").strip()
    model = raw_model
    if not model or model == "auto":
        model = settings.gemini_model
    elif not _is_supported_backend_text_model(model):
        logger.warning(
            "backend_model_selection_fallback",
            extra={
                "requested_model": raw_model,
                "fallback_model": settings.gemini_model,
                "reason": "unsupported_for_backend_text_generation",
            },
        )
        model = settings.gemini_model

    location = settings.gcp_location
    # if model.startswith("gemini-3"):
    #     location = "global"
    return model, location


async def _extract_with_ai(text: str, requested_model: str | None = None) -> IntentExtraction | None:
    if not _ai_available():
        logger.warning(
            "intent_extraction_ai_unavailable",
            extra={
                "requested_model": str(requested_model or ""),
                "input_excerpt": _truncate_log_text(text, 500),
            },
        )
        return None
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
                contents=[
                    {
                        "role": "user",
                        "parts": [{"text": f"{_load_intent_extraction_prompt()}\n\nUser input: {text}"}],
                    }
                ],
                config=types.GenerateContentConfig(temperature=0.1),
            ),
            timeout=min(settings.request_timeout_seconds, 30),
        )
        raw = (response.text or "").strip()
        logger.info(
            "intent_extraction_llm_raw_response",
            extra={
                "model_name": model_name,
                "location": location,
                "input_excerpt": _truncate_log_text(text, 500),
                "raw_text": _truncate_log_text(raw, 4000),
            },
        )
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw
            if raw.endswith("```"):
                raw = raw[: raw.rfind("```")]
            raw = raw.strip()
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            logger.warning(
                "intent_extraction_invalid_payload_type",
                extra={
                    "model_name": model_name,
                    "payload_type": type(parsed).__name__,
                    "input_excerpt": _truncate_log_text(text, 500),
                    "raw_text": _truncate_log_text(raw, 2000),
                },
            )
            return None
        entities = parsed.get("entities", {})
        if not isinstance(entities, dict):
            entities = {}
        entities = _normalize_extracted_entities(entities)
        timing_mode = str(parsed.get("timing_mode") or "unknown").strip()
        if timing_mode not in {"unknown", "immediate", "once", "interval", "multi_time"}:
            timing_mode = "unknown"
        timing_candidates = _normalize_string_list(list(parsed.get("timing_candidates") or []))
        goal_type = str(parsed.get("goal_type") or "").strip()
        if goal_type not in {"ui_automation", "general_chat", "unknown"}:
            goal_type = "unknown"
        task_kind = str(parsed.get("task_kind") or "").strip()
        if task_kind not in {"browser_automation", "general_chat", "unknown"}:
            task_kind = "unknown"
        execution_intent = _normalize_execution_intent(
            str(parsed.get("execution_intent") or ""),
            timing_mode,
        )
        missing_fields = _sanitize_missing_fields(
            text=text,
            entities=entities,
            ai_missing_fields=list(parsed.get("missing_fields") or []),
        )
        workflow_outline = _normalize_string_list(list(parsed.get("workflow_outline") or []))
        clarification_hints = _normalize_string_list(list(parsed.get("clarification_hints") or []))
        risk_flags = _normalize_string_list(list(parsed.get("risk_flags") or []))
        logger.info(
            "intent_extraction_llm_parsed",
            extra={
                "model_name": model_name,
                "input_excerpt": _truncate_log_text(text, 500),
                "goal_type": goal_type,
                "task_kind": task_kind,
                "can_automate": bool(parsed.get("can_automate", goal_type == "ui_automation")),
                "missing_fields": missing_fields,
                "entities": entities,
                "confidence": float(parsed.get("confidence", 0.0) or 0.0),
            },
        )
        return IntentExtraction(
            user_goal=str(parsed.get("user_goal") or text or "Untitled request"),
            goal_type=goal_type,
            task_kind=task_kind,
            execution_intent=execution_intent,
            workflow_outline=workflow_outline,
            clarification_hints=clarification_hints,
            entities=entities,
            timing_mode=timing_mode,
            timing_candidates=timing_candidates,
            can_automate=bool(parsed.get("can_automate", goal_type == "ui_automation")),
            confidence=float(parsed.get("confidence", 0.0) or 0.0),
            risk_flags=risk_flags,
            missing_fields=missing_fields,
        )
    except Exception as exc:
        logger.warning(
            "intent_extraction_ai_failed",
            extra={
                "requested_model": str(requested_model or ""),
                "input_excerpt": _truncate_log_text(text, 500),
                "error": str(exc),
                "error_type": type(exc).__name__,
            },
        )
        return None


async def extract_intent(text: str, requested_model: str | None = None) -> IntentExtraction:
    cleaned = (text or "").strip()
    fallback = _fallback_extract(cleaned)
    resolved_model, resolved_location = resolve_model_selection(requested_model)
    logger.info(
        "intent_extraction_request_started",
        extra={
            "runtime_marker": "backend-intent-debug-v2",
            "requested_model": str(requested_model or ""),
            "resolved_model": resolved_model,
            "resolved_location": resolved_location,
            "ai_available": _ai_available(),
            "input_excerpt": _truncate_log_text(cleaned, 500),
        },
    )
    if not cleaned or (
        fallback.goal_type == "general_chat"
        and cleaned.lower() in {"hi", "hello", "hey", "hii", "yo", "good morning", "good afternoon", "good evening"}
    ):
        return fallback

    ai_result = await _extract_with_ai(cleaned, requested_model=requested_model)
    if ai_result is not None:
        ai_result.entities = _normalize_extracted_entities(dict(ai_result.entities))
        if not ai_result.workflow_outline:
            ai_result.workflow_outline = [cleaned] if cleaned else []
        if not ai_result.user_goal:
            ai_result.user_goal = cleaned or "Untitled request"
        ai_result.execution_intent = _normalize_execution_intent(
            ai_result.execution_intent,
            ai_result.timing_mode,
        )
        ai_result.missing_fields = _sanitize_missing_fields(
            text=cleaned,
            entities=ai_result.entities,
            ai_missing_fields=list(ai_result.missing_fields),
        )
        if not ai_result.missing_fields and not cleaned:
            ai_result.missing_fields = ["goal"]
        logger.info(
            "intent_extraction_completed",
            extra={
                "requested_model": str(requested_model or ""),
                "source": "llm",
                "input_excerpt": _truncate_log_text(cleaned, 500),
                "goal_type": ai_result.goal_type,
                "task_kind": ai_result.task_kind,
                "can_automate": ai_result.can_automate,
                "missing_fields": list(ai_result.missing_fields),
                "entities": dict(ai_result.entities),
                "confidence": ai_result.confidence,
            },
        )
        return ai_result
    logger.warning(
        "intent_extraction_fell_back",
        extra={
            "requested_model": str(requested_model or ""),
            "source": "fallback",
            "input_excerpt": _truncate_log_text(cleaned, 500),
            "goal_type": fallback.goal_type,
            "task_kind": fallback.task_kind,
            "can_automate": fallback.can_automate,
            "missing_fields": list(fallback.missing_fields),
        },
    )
    return fallback
