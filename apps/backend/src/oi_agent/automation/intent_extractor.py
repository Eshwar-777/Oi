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

IMMEDIATE_PATTERNS = (" now", " immediately", " right away", " asap", " at once")
INTERVAL_PATTERNS = ("every ", "each ")
MULTI_TIME_PATTERN = re.compile(r"\b(?:at|on)\s+[\d:apm,\sand]+", re.IGNORECASE)
ONCE_PATTERN = re.compile(
    r"\b(today|tomorrow|tonight|later|next\s+\w+|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b",
    re.IGNORECASE,
)
MESSAGE_PATTERN = re.compile(
    r"^\s*send\s+(?P<message>.+?)\s+to\s+(?P<recipient>[a-zA-Z][a-zA-Z0-9_ .-]{0,39}?)(?:\s+on\s+(?P<app>[a-zA-Z][a-zA-Z0-9 ._-]{1,30}?))?(?=(?:\s+(?:now|immediately|later|tomorrow|today)\b|$))(?:\s+(?:now|immediately|later|tomorrow|today).*)?$",
    re.IGNORECASE,
)
RECIPIENT_PATTERN = re.compile(
    r"\b(?:to|for)\s+(?P<recipient>[a-zA-Z][a-zA-Z0-9_ .-]{0,39}?)(?=(?:\s+on\b|\s+using\b|\s+via\b|\s+now\b|\s+immediately\b|\s+later\b|$))",
    re.IGNORECASE,
)
APP_PATTERN = re.compile(r"\b(?:on|using|via)\s+(?P<app>[a-zA-Z][a-zA-Z0-9 ._-]{1,30})\b", re.IGNORECASE)

RISKY_KEYWORDS = {
    "send": "MESSAGE_SEND",
    "submit": "SUBMISSION",
    "delete": "DESTRUCTIVE_ACTION",
    "pay": "PAYMENT",
    "purchase": "PURCHASE",
    "transfer": "TRANSFER",
    "book": "BOOKING",
}

AUTOMATION_KEYWORDS = {
    "open",
    "click",
    "scroll",
    "navigate",
    "send",
    "fill",
    "search",
    "select",
    "book",
    "play",
    "watch",
    "type",
}

APP_HINTS = {
    "whatsapp",
    "gmail",
    "slack",
    "chrome",
    "browser",
    "notion",
    "youtube",
    "spotify",
    "linkedin",
    "instagram",
    "telegram",
    "discord",
}

GENERIC_MESSAGE_VALUES = {
    "message",
    "a message",
    "the message",
    "msg",
    "a msg",
    "text",
    "a text",
}

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


def _detect_timing_mode(text: str) -> tuple[str, list[str]]:
    lowered = f" {text.lower()} "
    if any(pattern in lowered for pattern in IMMEDIATE_PATTERNS):
        return "immediate", ["explicit_immediate"]
    if any(pattern in lowered for pattern in INTERVAL_PATTERNS):
        return "interval", ["explicit_interval"]
    if MULTI_TIME_PATTERN.search(text) and "," in text:
        return "multi_time", ["explicit_multiple_times"]
    if ONCE_PATTERN.search(text):
        return "once", ["explicit_future_time"]
    return "unknown", []


def detect_timing_mode(text: str) -> tuple[str, list[str]]:
    return _detect_timing_mode(text)


def _goal_type(text: str) -> str:
    lowered = text.lower()
    if any(keyword in lowered for keyword in AUTOMATION_KEYWORDS) or any(app in lowered for app in APP_HINTS):
        return "ui_automation"
    if text.strip():
        return "general_chat"
    return "unknown"


def _risk_flags(text: str) -> list[str]:
    lowered = text.lower()
    return [flag for keyword, flag in RISKY_KEYWORDS.items() if keyword in lowered]


def _extract_entities_fallback(text: str) -> dict[str, Any]:
    entities: dict[str, Any] = {}
    lowered = text.lower().strip()

    message_match = MESSAGE_PATTERN.match(text.strip())
    if message_match:
        message_text = str(message_match.group("message") or "").strip().strip('"').strip("'")
        recipient = str(message_match.group("recipient") or "").strip()
        app = str(message_match.group("app") or "").strip()
        if message_text:
            entities["message_text"] = message_text
        if recipient:
            entities["recipient"] = recipient
        if app:
            entities["app"] = app.title()

    if "app" not in entities:
        app_match = APP_PATTERN.search(text)
        if app_match:
            app = str(app_match.group("app") or "").strip()
            if app:
                entities["app"] = app.title()
        else:
            for app_name in APP_HINTS:
                if app_name in lowered:
                    entities["app"] = app_name.title()
                    break

    if "recipient" not in entities:
        recipient_match = RECIPIENT_PATTERN.search(text)
        if recipient_match:
            recipient = str(recipient_match.group("recipient") or "").strip()
            if recipient:
                entities["recipient"] = recipient

    quoted = re.findall(r'"([^"]+)"', text)
    if quoted and "message_text" not in entities:
        entities["message_text"] = quoted[0].strip()

    message_text = str(entities.get("message_text", "")).strip().strip('"').strip("'")
    if message_text.lower() in GENERIC_MESSAGE_VALUES:
        entities.pop("message_text", None)

    return entities


def _workflow_outline_fallback(text: str) -> list[str]:
    cleaned = (text or "").strip()
    if not cleaned:
        return []
    parts = re.split(r"\b(?:then|and then|after that|afterwards)\b|,", cleaned, flags=re.IGNORECASE)
    outline = [part.strip(" .") for part in parts if part and part.strip(" .")]
    return outline[:6]


def _derive_missing_fields(text: str, entities: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    lowered = text.lower()
    if not text.strip():
        missing.append("goal")
    if "send" in lowered:
        if not str(entities.get("recipient", "")).strip():
            missing.append("recipient")
        if not str(entities.get("message_text", "")).strip():
            missing.append("message_text")
        if not str(entities.get("app", "")).strip():
            missing.append("app")
    return missing


def _derive_clarification_hints(
    text: str,
    entities: dict[str, Any],
    missing_fields: list[str],
    workflow_outline: list[str],
) -> list[str]:
    if not missing_fields:
        return []
    recipient = str(entities.get("recipient", "") or "").strip()
    message_text = str(entities.get("message_text", "") or "").strip()
    if "app" in missing_fields and recipient and "send" in text.lower():
        return [f"I can help with that. Which app should I use to message {recipient.title()}?"]
    if "message_text" in missing_fields and recipient and "send" in text.lower():
        return [f"I can help with that. What message should I send to {recipient.title()}?"]
    if "recipient" in missing_fields and message_text:
        return ["I can help with that. Who should I send it to?"]
    if workflow_outline:
        missing_label = ", ".join(missing_fields)
        return [f"I can continue with this browser workflow, but I still need {missing_label}."]
    return []


def derive_missing_fields(text: str, entities: dict[str, Any]) -> list[str]:
    return _derive_missing_fields(text, entities)


def _fallback_extract(text: str) -> IntentExtraction:
    entities = _extract_entities_fallback(text)
    timing_mode, timing_candidates = _detect_timing_mode(text)
    goal_type = _goal_type(text)
    task_kind = "browser_automation" if goal_type == "ui_automation" else goal_type
    execution_intent = (
        "immediate"
        if timing_mode == "immediate"
        else "once"
        if timing_mode == "once"
        else "recurring"
        if timing_mode in {"interval", "multi_time"}
        else "unspecified"
    )
    can_automate = goal_type == "ui_automation"
    risk_flags = _risk_flags(text)
    workflow_outline = _workflow_outline_fallback(text)
    missing_fields = _derive_missing_fields(text, entities)
    return IntentExtraction(
        user_goal=text or "Untitled request",
        goal_type=goal_type,
        task_kind=task_kind,
        execution_intent=execution_intent,
        workflow_outline=workflow_outline,
        clarification_hints=_derive_clarification_hints(text, entities, missing_fields, workflow_outline),
        entities=entities,
        timing_mode=timing_mode,
        timing_candidates=timing_candidates,
        can_automate=can_automate,
        confidence=0.92 if can_automate else 0.55,
        risk_flags=risk_flags,
        missing_fields=missing_fields,
    )


def _should_skip_ai_extraction(text: str, fallback: IntentExtraction) -> bool:
    cleaned = (text or "").strip()
    if not cleaned:
        return True
    if fallback.goal_type == "general_chat" and cleaned.lower() in {
        "hi",
        "hello",
        "hey",
        "hii",
        "yo",
        "good morning",
        "good afternoon",
        "good evening",
    }:
        return True
    return False


def _ai_available() -> bool:
    return (
        (bool(settings.gcp_project.strip()) and bool(settings.google_genai_use_vertexai))
        or bool(settings.google_api_key.strip())
    )


def resolve_model_selection(requested_model: str | None = None) -> tuple[str, str]:
    model = str(requested_model or "").strip()
    if not model or model == "auto":
        model = settings.gemini_model

    location = settings.gcp_location
    if model.startswith("gemini-3"):
        location = "global"
    return model, location


async def _extract_with_ai(text: str, requested_model: str | None = None) -> IntentExtraction | None:
    if not _ai_available():
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
            timeout=min(settings.request_timeout_seconds, 6),
        )
        raw = (response.text or "").strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw
            if raw.endswith("```"):
                raw = raw[: raw.rfind("```")]
            raw = raw.strip()
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            return None
        entities = parsed.get("entities", {})
        if not isinstance(entities, dict):
            entities = {}
        return IntentExtraction(
            user_goal=str(parsed.get("user_goal") or text or "Untitled request"),
            goal_type=str(parsed.get("goal_type") or _goal_type(text)),
            task_kind=str(parsed.get("task_kind") or ("browser_automation" if _goal_type(text) == "ui_automation" else _goal_type(text))),
            execution_intent=str(parsed.get("execution_intent") or "unspecified"),
            workflow_outline=[str(item).strip() for item in list(parsed.get("workflow_outline") or []) if str(item).strip()],
            clarification_hints=[str(item).strip() for item in list(parsed.get("clarification_hints") or []) if str(item).strip()],
            entities=entities,
            timing_mode=str(parsed.get("timing_mode") or "unknown"),
            timing_candidates=list(parsed.get("timing_candidates") or []),
            can_automate=bool(parsed.get("can_automate", False)),
            confidence=float(parsed.get("confidence", 0.0) or 0.0),
            risk_flags=[str(item) for item in list(parsed.get("risk_flags") or [])],
            missing_fields=[str(item) for item in list(parsed.get("missing_fields") or [])],
        )
    except Exception as exc:
        logger.debug("AI intent extraction failed, using fallback: %s", exc)
        return None


async def extract_intent(text: str, requested_model: str | None = None) -> IntentExtraction:
    cleaned = (text or "").strip()
    fallback = _fallback_extract(cleaned)
    if _should_skip_ai_extraction(cleaned, fallback):
        return fallback

    ai_result = await _extract_with_ai(cleaned, requested_model=requested_model)
    if ai_result is not None:
        # Use deterministic extraction as a light normalizer, not the primary semantic parser.
        merged_entities = dict(ai_result.entities)
        fallback_entities = _extract_entities_fallback(cleaned)
        for key, value in fallback_entities.items():
            if not str(merged_entities.get(key, "")).strip():
                merged_entities[key] = value
        ai_result.entities = merged_entities
        if not ai_result.workflow_outline:
            ai_result.workflow_outline = _workflow_outline_fallback(cleaned)
        if not ai_result.clarification_hints:
            ai_result.clarification_hints = _derive_clarification_hints(
                cleaned,
                merged_entities,
                list(ai_result.missing_fields),
                list(ai_result.workflow_outline),
            )
        if not ai_result.risk_flags:
            ai_result.risk_flags = _risk_flags(cleaned)
        if not ai_result.goal_type or ai_result.goal_type == "unknown":
            ai_result.goal_type = _goal_type(cleaned)
        if not ai_result.task_kind or ai_result.task_kind == "unknown":
            ai_result.task_kind = "browser_automation" if ai_result.goal_type == "ui_automation" else ai_result.goal_type
        if not ai_result.user_goal:
            ai_result.user_goal = cleaned or "Untitled request"
        ai_result.can_automate = ai_result.goal_type == "ui_automation"
        if not ai_result.timing_candidates:
            ai_result.timing_mode, ai_result.timing_candidates = _detect_timing_mode(cleaned)
        if ai_result.execution_intent == "unspecified":
            ai_result.execution_intent = (
                "immediate"
                if ai_result.timing_mode == "immediate"
                else "once"
                if ai_result.timing_mode == "once"
                else "recurring"
                if ai_result.timing_mode in {"interval", "multi_time"}
                else "unspecified"
            )
        if not ai_result.missing_fields and not cleaned:
            ai_result.missing_fields = ["goal"]
        return ai_result
    return fallback
