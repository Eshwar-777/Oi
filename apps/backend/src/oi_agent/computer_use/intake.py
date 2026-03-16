from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from oi_agent.config import settings

ComputerUseExecutionMode = Literal["immediate", "once", "interval", "multi_time"]


class ComputerUseIntakeResult(BaseModel):
    execution_mode: ComputerUseExecutionMode = "immediate"
    needs_clarification: bool = False
    clarification_question: str = ""
    assistant_reply: str = ""
    run_at: list[str] = Field(default_factory=list)
    interval_seconds: int | None = None


def _extract_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?", "", cleaned).strip()
        cleaned = re.sub(r"```$", "", cleaned).strip()
    try:
        parsed = json.loads(cleaned)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        match = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if not match:
            return {}
        try:
            parsed = json.loads(match.group(0))
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}


def _candidate_models() -> list[str]:
    values = [
        settings.gemini_computer_use_model,
        *str(settings.gemini_computer_use_model_fallbacks or "").split(","),
        settings.gemini_model,
    ]
    seen: set[str] = set()
    candidates: list[str] = []
    for value in values:
        candidate = str(value or "").strip()
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        candidates.append(candidate)
    return candidates


def _normalize_intake_result(data: dict[str, Any]) -> ComputerUseIntakeResult:
    mode = str(data.get("execution_mode", "") or data.get("mode", "") or "immediate").strip().lower()
    if mode not in {"immediate", "once", "interval", "multi_time"}:
        mode = "immediate"
    run_at = [
        str(value).strip()
        for value in list(data.get("run_at", []) or [])
        if str(value).strip()
    ]
    interval_seconds = data.get("interval_seconds")
    try:
        normalized_interval = int(interval_seconds) if interval_seconds is not None else None
    except Exception:
        normalized_interval = None
    return ComputerUseIntakeResult(
        execution_mode=mode,  # type: ignore[arg-type]
        needs_clarification=bool(data.get("needs_clarification", False)),
        clarification_question=str(data.get("clarification_question", "") or "").strip(),
        assistant_reply=str(data.get("assistant_reply", "") or "").strip(),
        run_at=run_at,
        interval_seconds=normalized_interval if normalized_interval and normalized_interval > 0 else None,
    )


def _prompt(*, user_prompt: str, timezone: str) -> str:
    now = datetime.now(UTC).isoformat()
    return "\n".join(
        [
            "You are OI computer-use intake.",
            "Decide whether this request should run immediately or be scheduled for later.",
            "Do not plan browser actions yet. Only classify timing and extract schedule data.",
            "Return JSON only.",
            "Allowed execution_mode values: immediate, once, interval, multi_time.",
            "Use needs_clarification=true only when timing is genuinely ambiguous.",
            "If execution_mode is once or multi_time, return ISO 8601 timestamps in run_at.",
            "If execution_mode is interval, return interval_seconds.",
            "Prefer immediate unless the user explicitly asks for later, tomorrow, a date/time, or repetition.",
            "Keep assistant_reply short and natural.",
            "",
            f"Current time (UTC): {now}",
            f"User timezone: {timezone}",
            f"User request: {user_prompt}",
            "",
            'JSON schema: {"execution_mode":"immediate|once|interval|multi_time","needs_clarification":false,"clarification_question":"","assistant_reply":"","run_at":[],"interval_seconds":null}',
        ]
    )


async def resolve_computer_use_intake(*, prompt: str, timezone: str) -> ComputerUseIntakeResult:
    from google import genai
    from google.genai import types

    client = genai.Client(
        vertexai=settings.google_genai_use_vertexai,
        project=settings.gcp_project,
        location=settings.gcp_location,
        api_key=None if settings.google_genai_use_vertexai else (settings.google_api_key or None),
    )
    last_error: Exception | None = None
    for model_name in _candidate_models():
        try:
            response = await client.aio.models.generate_content(
                model=model_name,
                contents=[types.Part.from_text(text=_prompt(user_prompt=prompt, timezone=timezone or "UTC"))],
                config=types.GenerateContentConfig(
                    temperature=0.1,
                    response_mime_type="application/json",
                ),
            )
            data = _extract_json_object(str(getattr(response, "text", "") or ""))
            result = _normalize_intake_result(data)
            if result.execution_mode != "immediate" and not result.run_at and result.interval_seconds is None:
                result.needs_clarification = True
                if not result.clarification_question:
                    result.clarification_question = "Tell me exactly when you want this to run."
            if not result.assistant_reply:
                if result.needs_clarification:
                    result.assistant_reply = result.clarification_question or "Tell me exactly when you want this to run."
                elif result.execution_mode == "immediate":
                    result.assistant_reply = "I’ll take over the browser now."
                else:
                    result.assistant_reply = "I’ll schedule that for you."
            return result
        except Exception as exc:
            last_error = exc
    if last_error is not None:
        raise RuntimeError(f"Computer use intake failed: {last_error}")
    return ComputerUseIntakeResult(
        execution_mode="immediate",
        assistant_reply="I’ll take over the browser now.",
    )
