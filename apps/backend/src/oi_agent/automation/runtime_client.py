from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from oi_agent.config import settings
from oi_agent.services.tools.base import ToolResult


def _runtime_headers() -> dict[str, str]:
    headers = {"content-type": "application/json"}
    secret = str(settings.automation_runtime_shared_secret or "").strip()
    if secret:
        headers["x-automation-runtime-secret"] = secret
    return headers


def _default_runtime_model_payload() -> dict[str, str]:
    provider = "google-vertex" if settings.google_genai_use_vertexai else "google"
    model = str(settings.gemini_model or "").strip()
    return {
        "provider": provider,
        "name": model,
    }


async def fetch_runtime_readiness() -> dict[str, Any]:
    base_url = str(settings.automation_runtime_base_url or "").rstrip("/")
    if not base_url:
        return {"ready": False, "detail": "Automation runtime base URL is not configured."}
    timeout = httpx.Timeout(5.0, read=5.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.get(
            f"{base_url}/ready",
            headers=_runtime_headers(),
        )
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, dict):
            return payload
    return {"ready": False, "detail": "Runtime readiness response was invalid."}


async def _post_runtime_control(
    *,
    run_id: str,
    action: str,
) -> dict[str, Any]:
    base_url = str(settings.automation_runtime_base_url or "").rstrip("/")
    if not base_url:
        raise RuntimeError("Automation runtime base URL is not configured.")
    timeout = httpx.Timeout(15.0, read=30.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(
            f"{base_url}/runs/{run_id}/{action}",
            headers=_runtime_headers(),
        )
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, dict):
            return payload
        return {"ok": False, "detail": "Runtime control response was invalid."}


async def pause_runtime_run(run_id: str) -> dict[str, Any]:
    return await _post_runtime_control(run_id=run_id, action="pause")


async def cancel_runtime_run(run_id: str) -> dict[str, Any]:
    return await _post_runtime_control(run_id=run_id, action="cancel")


async def execute_browser_steps_via_runtime(
    *,
    run_id: str,
    session_id: str,
    user_id: str,
    prompt: str,
    cdp_url: str,
    steps: list[dict[str, Any]],
    cwd: str | None = None,
    page_registry: dict[str, dict[str, Any]] | None = None,
    active_page_ref: str | None = None,
) -> ToolResult:
    base_url = str(settings.automation_runtime_base_url or "").rstrip("/")
    if not base_url:
        raise RuntimeError("Automation runtime base URL is not configured.")
    request_payload = {
        "runId": run_id,
        "sessionId": session_id,
        "text": prompt,
        "cwd": cwd,
        "model": _default_runtime_model_payload(),
        "browser": {
            "mode": "cdp",
            "cdpUrl": cdp_url,
        },
        "context": {
            "userId": user_id,
            "timezone": "UTC",
            "locale": "en-US",
        },
        "steps": steps,
        "pageRegistry": page_registry or {},
        "activePageRef": active_page_ref,
    }
    timeout = httpx.Timeout(60.0, read=300.0)
    runtime_events: list[dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(
            f"{base_url}/runs",
            json=request_payload,
            headers=_runtime_headers(),
        )
        response.raise_for_status()
        body = response.json()
        after = int(body.get("cursor", 0) or 0) - 1
        final_payload: dict[str, Any] | None = None
        async with client.stream(
            "GET",
            f"{base_url}/runs/{run_id}/events",
            params={"after": after},
            headers=_runtime_headers(),
        ) as event_stream:
            event_stream.raise_for_status()
            async for line in event_stream.aiter_lines():
                if not line.startswith("data: "):
                    continue
                event = json.loads(line[6:])
                if isinstance(event, dict):
                    runtime_events.append(dict(event))
                event_type = str(event.get("type", "") or "")
                payload = event.get("payload", {}) or {}
                if event_type == "run.completed":
                    final_payload = payload if isinstance(payload, dict) else {}
                    break
                if event_type == "run.failed":
                    final_payload = payload if isinstance(payload, dict) else {}
                    break
        if final_payload is None:
            raise RuntimeError("Automation runtime ended without a terminal event.")

    result = final_payload.get("result", {}) if isinstance(final_payload.get("result"), dict) else {}
    rows = list(result.get("rows", []) or []) if isinstance(result, dict) else []
    metadata = dict(result.get("metadata", {}) or {}) if isinstance(result, dict) else {}
    error = str(final_payload.get("error", "") or "")
    if str(final_payload.get("code", "") or "") == "OBSERVATION_EXHAUSTED":
        error = error or "Observation exhausted."
    return ToolResult(
        success=not error,
        data=[row for row in rows if isinstance(row, dict)],
        metadata={**metadata, "runtime_events": runtime_events},
        error=error,
        text="" if error else f"Completed {len(rows)} browser steps via automation runtime",
    )


async def execute_browser_prompt_via_runtime(
    *,
    run_id: str,
    session_id: str,
    user_id: str,
    prompt: str,
    browser_session_id: str | None,
    cdp_url: str,
    timezone: str,
    locale: str,
    cwd: str | None = None,
    goal_hints: dict[str, Any] | None = None,
    resume: dict[str, Any] | None = None,
    page_registry: dict[str, dict[str, Any]] | None = None,
    active_page_ref: str | None = None,
    on_event: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    base_url = str(settings.automation_runtime_base_url or "").rstrip("/")
    if not base_url:
        raise RuntimeError("Automation runtime base URL is not configured.")
    request_payload = {
        "runId": run_id,
        "sessionId": session_id,
        "text": prompt,
        "browserSessionId": browser_session_id,
        "cwd": cwd,
        "model": _default_runtime_model_payload(),
        "browser": {
            "mode": "cdp",
            "cdpUrl": cdp_url,
        },
        "context": {
            "userId": user_id,
            "timezone": timezone or "UTC",
            "locale": locale or "en-US",
        },
        "goalHints": goal_hints or None,
        "resume": resume or None,
        "pageRegistry": page_registry or {},
        "activePageRef": active_page_ref,
    }
    timeout = httpx.Timeout(60.0, read=600.0)
    runtime_events: list[dict[str, Any]] = []
    final_payload: dict[str, Any] | None = None
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.post(
            f"{base_url}/runs",
            json=request_payload,
            headers=_runtime_headers(),
        )
        response.raise_for_status()
        body = response.json()
        after = int(body.get("cursor", 0) or 0) - 1
        async with client.stream(
            "GET",
            f"{base_url}/runs/{run_id}/events",
            params={"after": after},
            headers=_runtime_headers(),
        ) as event_stream:
            event_stream.raise_for_status()
            async for line in event_stream.aiter_lines():
                if not line.startswith("data: "):
                    continue
                event = json.loads(line[6:])
                if not isinstance(event, dict):
                    continue
                runtime_events.append(dict(event))
                if on_event is not None:
                    await on_event(dict(event))
                event_type = str(event.get("type", "") or "")
                payload = event.get("payload", {}) or {}
                if event_type in {"run.completed", "run.failed"}:
                    final_payload = payload if isinstance(payload, dict) else {}
                    break
        if final_payload is None:
            raise RuntimeError("Automation runtime ended without a terminal event.")
    return {
        "result": final_payload.get("result", {}) if isinstance(final_payload.get("result"), dict) else {},
        "error": str(final_payload.get("error", "") or ""),
        "code": str(final_payload.get("code", "") or ""),
        "runtime_events": runtime_events,
    }
