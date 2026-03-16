from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Literal

from oi_agent.config import settings
from oi_agent.services.tools.base import ToolContext
from oi_agent.services.tools.navigator.command_client import send_extension_command

logger = logging.getLogger(__name__)

SUPPORTED_VISUAL_FALLBACK_ACTIONS = {"click", "type"}
SUPPORTED_VISUAL_FALLBACK_EXECUTOR_MODES = {"extension_stream"}
SENSITIVE_VISUAL_TERMS = {
    "send",
    "submit",
    "confirm",
    "delete",
    "remove",
    "purchase",
    "pay",
    "transfer",
    "approve",
    "allow",
    "grant",
}


def visual_targeting_timeout_seconds() -> float:
    return float(max(10, min(settings.request_timeout_seconds, 30)))


def visual_intervention_timeout_seconds() -> float:
    return float(max(10, min(settings.request_timeout_seconds, 30)))


@dataclass
class ScreenshotBasis:
    screenshot: str
    screenshot_id: str
    current_url: str
    page_title: str
    viewport_width: int
    viewport_height: int
    device_pixel_ratio: float
    tab_id: int | None = None


@dataclass
class VisualFallbackPlan:
    action: Literal["click", "type"]
    x: int
    y: int
    confidence: float
    rationale: str
    value: str = ""
    anchor_region: dict[str, int] | None = None
    verification_checks: list[str] = field(default_factory=list)
    basis: ScreenshotBasis | None = None


@dataclass
class VisualFallbackExecutionResult:
    status: Literal["done", "error", "manual"]
    data: str
    screenshot: str = ""
    confidence: float = 0.0
    rationale: str = ""
    verification_passed: bool = False
    verification_result: str = ""
    execution_mode_detail: str = "visual_fallback"
    fallback_reason: str = ""


@dataclass
class VisualInterventionAssessment:
    needs_user_action: bool
    confidence: float
    reason: str
    halt_kind: Literal["none", "user_action", "human_confirmation"] = "none"
    sensitive_step: bool = False


def _hash_screenshot(data: str) -> str:
    text = str(data or "").strip()
    if not text:
        return ""
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _safe_float(value: Any, default: float = 1.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _step_action_for_visual_fallback(step: dict[str, Any] | None) -> str:
    if not isinstance(step, dict):
        return "click"
    action = str(step.get("action", "") or step.get("command", "")).strip().lower()
    if action == "act":
        action = str(step.get("kind", "")).strip().lower()
    return action or "click"


def _step_text_blob(step: dict[str, Any] | None) -> str:
    if not isinstance(step, dict):
        return ""
    parts = [
        str(step.get("description", "") or ""),
        str(step.get("reason", "") or ""),
        str(step.get("ref", "") or ""),
        str(step.get("value", "") or ""),
        json.dumps(step.get("target", ""), sort_keys=True, default=str),
    ]
    return " ".join(part for part in parts if part).strip()


def _agent_browser_step_is_visual_benign(blob: str) -> bool:
    lowered = blob.lower()
    if not lowered:
        return False
    safe_terms = {
        "field",
        "input",
        "textbox",
        "text box",
        "compose field",
        "to field",
        "visible",
        "focus",
    }
    return any(term in lowered for term in safe_terms)


def is_visual_fallback_blocked(
    *,
    executor_mode: str,
    step: dict[str, Any] | None,
    prompt_text: str = "",
) -> tuple[bool, str]:
    blob = _step_text_blob(step).lower()

    if executor_mode == "agent_browser":
        if not _agent_browser_step_is_visual_benign(blob):
            return True, "unsupported_executor_mode"
    elif executor_mode not in SUPPORTED_VISUAL_FALLBACK_EXECUTOR_MODES:
        return True, "unsupported_executor_mode"

    action = _step_action_for_visual_fallback(step)
    if action not in SUPPORTED_VISUAL_FALLBACK_ACTIONS:
        return True, "unsupported_action"

    if any(term in blob for term in SENSITIVE_VISUAL_TERMS):
        return True, "sensitive_action"

    return False, ""


def build_screenshot_basis(payload: dict[str, Any] | None, *, tab_id: int | None = None) -> ScreenshotBasis | None:
    if not isinstance(payload, dict):
        return None
    screenshot = str(payload.get("screenshot", "") or "").strip()
    if not screenshot:
        return None
    viewport = payload.get("viewport", {})
    viewport_width = _safe_int((viewport or {}).get("width"), 0)
    viewport_height = _safe_int((viewport or {}).get("height"), 0)
    return ScreenshotBasis(
        screenshot=screenshot,
        screenshot_id=_hash_screenshot(screenshot),
        current_url=str(payload.get("current_url", "") or ""),
        page_title=str(payload.get("page_title", "") or ""),
        viewport_width=viewport_width,
        viewport_height=viewport_height,
        device_pixel_ratio=_safe_float(payload.get("device_pixel_ratio"), 1.0),
        tab_id=tab_id,
    )


def visual_plan_invalidated(
    plan: VisualFallbackPlan,
    current_basis: ScreenshotBasis | None,
) -> bool:
    basis = plan.basis
    if basis is None or current_basis is None:
        return True
    if basis.tab_id is not None and current_basis.tab_id is not None and basis.tab_id != current_basis.tab_id:
        return True
    if basis.viewport_width != current_basis.viewport_width:
        return True
    if basis.viewport_height != current_basis.viewport_height:
        return True
    if abs(basis.device_pixel_ratio - current_basis.device_pixel_ratio) > 0.01:
        return True
    if basis.current_url and current_basis.current_url and basis.current_url != current_basis.current_url:
        return True
    if basis.page_title and current_basis.page_title and basis.page_title != current_basis.page_title:
        return True
    anchor = plan.anchor_region or {}
    if anchor:
        x = _safe_int(anchor.get("x"), -1)
        y = _safe_int(anchor.get("y"), -1)
        width = _safe_int(anchor.get("width"), 0)
        height = _safe_int(anchor.get("height"), 0)
        if x < 0 or y < 0:
            return True
        if x >= current_basis.viewport_width or y >= current_basis.viewport_height:
            return True
        if width > 0 and x + width > current_basis.viewport_width + 8:
            return True
        if height > 0 and y + height > current_basis.viewport_height + 8:
            return True
    elif basis.screenshot_id != current_basis.screenshot_id:
        return True
    return False


async def _call_visual_model(*, screenshot: str, prompt: str) -> dict[str, Any] | None:
    from google import genai
    from google.genai import types

    image_data = screenshot.split(",", 1)[1] if "," in screenshot else screenshot
    raw_bytes = base64.b64decode(image_data)
    client = genai.Client(
        vertexai=settings.google_genai_use_vertexai,
        project=settings.gcp_project,
        location=settings.gcp_location,
    )
    timeout_seconds = visual_targeting_timeout_seconds()
    response = await asyncio.wait_for(
        client.aio.models.generate_content(
            model=settings.gemini_model,
            contents=[
                {
                    "role": "user",
                    "parts": [
                        {
                            "inline_data": {
                                "mime_type": "image/jpeg",
                                "data": base64.b64encode(raw_bytes).decode(),
                            }
                        },
                        {"text": prompt},
                    ],
                }
            ],
            config=types.GenerateContentConfig(temperature=0.1),
        ),
        timeout=timeout_seconds,
    )
    raw = str(response.text or "").strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else raw
        if raw.endswith("```"):
            raw = raw[: raw.rfind("```")]
    parsed = json.loads(raw or "{}")
    return parsed if isinstance(parsed, dict) else None


def _intervention_prompt(
    *,
    basis: ScreenshotBasis,
    step_intent: str,
    completed_steps: list[str],
) -> str:
    recent = json.dumps(completed_steps[-5:], ensure_ascii=True, default=str)
    return (
        "Return JSON only. Decide whether the user must manually intervene based on this screenshot.\n"
        "Say needs_user_action=true only for clearly blocked, risky, or ambiguous states where safe automation should stop.\n"
        "Return halt_kind=user_action when the user needs to take over or answer.\n"
        "Return halt_kind=human_confirmation when this is a sensitive or confirm-style step that should be explicitly approved.\n"
        "Return halt_kind=none when a safe benign next action is still possible.\n"
        "Examples: security prompts, consent, final send/submit, payment, captcha, account verification, or unclear target.\n"
        "If a benign next click/focus is clearly possible, needs_user_action should be false.\n"
        'Respond with {"needs_user_action":true,"halt_kind":"user_action|human_confirmation|none","sensitive_step":false,"confidence":0.0,"reason":"short"}.\n'
        f"URL: {basis.current_url}\n"
        f"Title: {basis.page_title}\n"
        f"Intent: {step_intent}\n"
        f"Recent completed steps: {recent}\n"
    )


async def assess_visual_user_intervention(
    *,
    basis: ScreenshotBasis,
    step_intent: str,
    completed_steps: list[str],
) -> VisualInterventionAssessment:
    try:
        parsed = await asyncio.wait_for(
            _call_visual_model(
                screenshot=basis.screenshot,
                prompt=_intervention_prompt(
                    basis=basis,
                    step_intent=step_intent,
                    completed_steps=completed_steps,
                ),
            ),
            timeout=visual_intervention_timeout_seconds(),
        )
    except Exception as exc:
        logger.warning("Visual fallback intervention assessment failed: %r", exc)
        return VisualInterventionAssessment(
            needs_user_action=False,
            confidence=0.0,
            reason="intervention assessment unavailable",
        )

    if not isinstance(parsed, dict):
        return VisualInterventionAssessment(
            needs_user_action=False,
            confidence=0.0,
            reason="intervention assessment unavailable",
        )
    halt_kind = str(parsed.get("halt_kind", "") or "none").strip().lower()
    if halt_kind not in {"none", "user_action", "human_confirmation"}:
        halt_kind = "none"
    return VisualInterventionAssessment(
        needs_user_action=bool(parsed.get("needs_user_action")),
        confidence=_safe_float(parsed.get("confidence"), 0.0),
        reason=str(parsed.get("reason", "") or "intervention assessment unavailable"),
        halt_kind=halt_kind,  # type: ignore[arg-type]
        sensitive_step=bool(parsed.get("sensitive_step")),
    )


def _targeting_prompt(
    *,
    basis: ScreenshotBasis,
    step_intent: str,
    completed_steps: list[str],
    dom_hints: dict[str, Any] | None,
) -> str:
    hints = json.dumps(dom_hints or {}, ensure_ascii=True, default=str)[:2000]
    recent = json.dumps(completed_steps[-5:], ensure_ascii=True, default=str)
    return (
        "Return JSON only. Choose one immediate benign UI action from the screenshot.\n"
        "Allowed actions: click, type.\n"
        "Do not choose send/submit/confirm/delete/purchase/transfer/approval actions.\n"
        "Use viewport-relative coordinates based on the screenshot only.\n"
        "If action=type, include the exact text to type in value. If the text is unknown, choose click instead.\n"
        "Respond with:\n"
        '{'
        '"action":"click|type",'
        '"x":123,'
        '"y":456,'
        '"value":"",'
        '"confidence":0.0,'
        '"rationale":"short",'
        '"anchor_region":{"x":0,"y":0,"width":0,"height":0},'
        '"verification_checks":["short check"]'
        '}\n'
        f"URL: {basis.current_url}\n"
        f"Title: {basis.page_title}\n"
        f"Viewport: {basis.viewport_width}x{basis.viewport_height} @ DPR {basis.device_pixel_ratio}\n"
        f"Intent: {step_intent}\n"
        f"Recent completed steps: {recent}\n"
        f"DOM/snapshot hints: {hints}\n"
    )


async def generate_visual_fallback_plan(
    *,
    basis: ScreenshotBasis,
    step_intent: str,
    completed_steps: list[str],
    dom_hints: dict[str, Any] | None = None,
) -> VisualFallbackPlan | None:
    try:
        parsed = await _call_visual_model(
            screenshot=basis.screenshot,
            prompt=_targeting_prompt(
                basis=basis,
                step_intent=step_intent,
                completed_steps=completed_steps,
                dom_hints=dom_hints,
            ),
        )
    except Exception as exc:
        logger.warning("Visual fallback targeting failed: %r", exc)
        return None

    if not isinstance(parsed, dict):
        return None
    action = str(parsed.get("action", "")).strip().lower()
    if action not in SUPPORTED_VISUAL_FALLBACK_ACTIONS:
        return None
    confidence = _safe_float(parsed.get("confidence"), 0.0)
    if confidence < 0.7:
        return None
    x = _safe_int(parsed.get("x"), -1)
    y = _safe_int(parsed.get("y"), -1)
    if x < 0 or y < 0:
        return None
    anchor_region_raw = parsed.get("anchor_region")
    anchor_region = anchor_region_raw if isinstance(anchor_region_raw, dict) else None
    checks = parsed.get("verification_checks")
    verification_checks = [str(item).strip() for item in checks] if isinstance(checks, list) else []
    value = str(parsed.get("value", "") or "")
    if action == "type" and not value.strip():
        return None
    return VisualFallbackPlan(
        action=action,  # type: ignore[arg-type]
        x=x,
        y=y,
        value=value,
        confidence=confidence,
        rationale=str(parsed.get("rationale", "") or ""),
        anchor_region={
            "x": _safe_int(anchor_region.get("x"), 0),
            "y": _safe_int(anchor_region.get("y"), 0),
            "width": _safe_int(anchor_region.get("width"), 0),
            "height": _safe_int(anchor_region.get("height"), 0),
        }
        if isinstance(anchor_region, dict)
        else None,
        verification_checks=[check for check in verification_checks if check],
        basis=basis,
    )


async def verify_visual_fallback(
    *,
    before_basis: ScreenshotBasis,
    after_basis: ScreenshotBasis,
    step_intent: str,
    verification_checks: list[str],
    structured_context: dict[str, Any] | None = None,
) -> tuple[bool, str]:
    active_element = (structured_context or {}).get("activeElement", {})
    if isinstance(active_element, dict):
        role = str(active_element.get("role", "")).strip().lower()
        tag = str(active_element.get("tag", "")).strip().lower()
        editable = bool(active_element.get("editable"))
        if editable or role in {"textbox", "combobox"} or tag in {"input", "textarea"}:
            return True, "focused editable element verified"

    if before_basis.screenshot_id != after_basis.screenshot_id:
        return True, "visible UI changed after coordinate action"

    if verification_checks:
        check_text = "; ".join(verification_checks[:3])
    else:
        check_text = "expected next UI state should now be visible"
    return False, f"verification ambiguous: {check_text}"


async def attempt_visual_fallback(
    *,
    connection_manager: Any,
    device_id: str,
    context: ToolContext,
    run_id: str,
    step_intent: str,
    failed_step: dict[str, Any] | None,
    step_index: int,
    total_steps: int,
    fetch_screenshot_basis: Any,
    fetch_structured_context: Any,
    completed_steps: list[str] | None = None,
    fallback_reason: str,
) -> VisualFallbackExecutionResult | None:
    blocked, reason = is_visual_fallback_blocked(
        executor_mode="extension_stream",
        step=failed_step,
        prompt_text=step_intent,
    )
    if blocked:
        return VisualFallbackExecutionResult(
            status="error",
            data=f"Visual fallback blocked: {reason}",
            fallback_reason=fallback_reason,
        )

    tab_id = context.action_config.get("tab_id")
    basis_payload = await fetch_screenshot_basis(device_id, tab_id, f"{run_id}-visual-basis-{step_index}")
    basis = build_screenshot_basis(basis_payload, tab_id=tab_id)
    if basis is None:
        return None

    structured_before = await fetch_structured_context(device_id, tab_id, f"{run_id}-visual-struct-{step_index}")
    plan = await generate_visual_fallback_plan(
        basis=basis,
        step_intent=step_intent,
        completed_steps=completed_steps or [],
        dom_hints=structured_before,
    )
    if plan is None:
        return None

    refreshed_payload = await fetch_screenshot_basis(device_id, tab_id, f"{run_id}-visual-refresh-{step_index}")
    refreshed_basis = build_screenshot_basis(refreshed_payload, tab_id=tab_id)
    if visual_plan_invalidated(plan, refreshed_basis):
        return VisualFallbackExecutionResult(
            status="error",
            data="Visual fallback invalidated before execution; page changed.",
            confidence=plan.confidence,
            rationale=plan.rationale,
            fallback_reason=fallback_reason,
        )

    action = plan.action
    value = plan.value if action == "type" else ""
    command_result = await send_extension_command(
        connection_manager=connection_manager,
        device_id=device_id,
        run_id=run_id,
        action=action,
        target={"by": "coords", "x": plan.x, "y": plan.y},
        value=value,
        step_index=step_index,
        step_label=f"visual-fallback-{action}",
        total_steps=total_steps,
        timeout=30.0,
        tab_id=tab_id,
    )
    if str(command_result.get("status", "")).strip().lower() == "error":
        return VisualFallbackExecutionResult(
            status="error",
            data=str(command_result.get("data", "") or "Visual coordinate action failed."),
            screenshot=str(command_result.get("screenshot", "") or ""),
            confidence=plan.confidence,
            rationale=plan.rationale,
            fallback_reason=fallback_reason,
        )

    await asyncio.sleep(0.4)
    after_payload = await fetch_screenshot_basis(device_id, tab_id, f"{run_id}-visual-after-{step_index}")
    after_basis = build_screenshot_basis(after_payload, tab_id=tab_id)
    if after_basis is None:
        return VisualFallbackExecutionResult(
            status="error",
            data="Visual fallback could not capture a post-action screenshot.",
            confidence=plan.confidence,
            rationale=plan.rationale,
            fallback_reason=fallback_reason,
        )
    structured_after = await fetch_structured_context(device_id, tab_id, f"{run_id}-visual-after-struct-{step_index}")
    verified, verification_reason = await verify_visual_fallback(
        before_basis=basis,
        after_basis=after_basis,
        step_intent=step_intent,
        verification_checks=plan.verification_checks,
        structured_context=structured_after,
    )
    if not verified:
        return VisualFallbackExecutionResult(
            status="manual",
            data="Visual fallback verification remained ambiguous.",
            screenshot=after_basis.screenshot,
            confidence=plan.confidence,
            rationale=plan.rationale,
            verification_passed=False,
            verification_result=verification_reason,
            fallback_reason=fallback_reason,
        )

    return VisualFallbackExecutionResult(
        status="done",
        data="Visual fallback executed and verified.",
        screenshot=after_basis.screenshot,
        confidence=plan.confidence,
        rationale=plan.rationale,
        verification_passed=True,
        verification_result=verification_reason,
        fallback_reason=fallback_reason,
    )
