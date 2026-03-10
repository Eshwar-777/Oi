"""Browser Step Planner — builds safe browser automation steps.

Uses Gemini to understand user intent and produce browser steps for the
Navigator flow. DOM interactions are ref-based (`snapshot` + `act`) to avoid
fragile selector targeting.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import re
from datetime import datetime
from typing import Any

from oi_agent.automation.intent_extractor import resolve_model_selection
from oi_agent.automation.models import AgentBrowserStep, RuntimeActionPlan, RuntimeBlock
from oi_agent.config import settings
from oi_agent.services.tools.navigator.agent_browser_rag import (
    build_agent_browser_reference_context,
)
from oi_agent.services.tools.navigator.context_builder import (
    build_navigator_prompt_bundle,
    build_navigator_system_prompt,
)
from oi_agent.services.tools.navigator.planner_guardrails import apply_flow_guardrails

logger = logging.getLogger(__name__)


STEP_TYPES = ("browser", "consult")

AGENT_BROWSER_COMMANDS = (
    "open", "wait", "press", "keyboard", "screenshot", "read_dom",
    "extract_structured", "highlight", "snapshot", "media_state",
    "click", "type", "scroll", "hover", "select", "upload", "tab", "frame",
)

BROWSER_ACTIONS = AGENT_BROWSER_COMMANDS + (
    "navigate",
    # Legacy compatibility; guardrails degrade this into native agent-browser actions.
    "act",
)

STATUS_VALUES = {"OK", "COMPLETED", "NEEDS_INPUT", "NEEDS_CONFIRMATION", "BLOCKED", "FAILED"}
RISK_TYPES = {
    "AMBIGUITY", "BLOCKED_UI", "SECURITY_GATE", "PERMISSION_PROMPT",
    "DESTRUCTIVE_ACTION", "TARGET_UNCERTAIN",
}
RISK_SEVERITIES = {"LOW", "MEDIUM", "HIGH"}
PLAN_STRATEGIES = {
    "SEARCH_FIRST_THEN_SELECT", "DIRECT_ACTION", "FORM_FILL_SUBMIT",
    "NAVIGATION_THEN_ACTION", "REPAIR_SUBPLAN",
}
SKILL_TO_ACTION = {
    "SAFE_CLICK": "click",
    "SAFE_FILL": "type",
    "SAFE_SELECT": "select",
    "WAIT_FOR_STATE": "wait",
    "UPLOAD_FILE": "upload",
    "VERIFY": "wait",
}


def _planner_full_timeout_seconds() -> float:
    return float(max(10, min(settings.request_timeout_seconds, 30)))


def _planner_next_step_timeout_seconds() -> float:
    return float(max(10, min(settings.request_timeout_seconds, 30)))


def _planner_llm_timeout_seconds(*, max_browser_steps: int | None = None) -> float:
    if max_browser_steps == 1:
        return _planner_next_step_timeout_seconds()
    return _planner_full_timeout_seconds()


def _truncate_log_text(value: Any, limit: int = 4000) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return text[:limit] + "...<truncated>"


def _strip_json_fence(raw: str) -> str:
    text = (raw or "").strip()
    if not text.startswith("```"):
        return text
    text = text.split("\n", 1)[1] if "\n" in text else text
    if text.endswith("```"):
        text = text[:text.rfind("```")]
    return text.strip()


def _extract_first_json_object(raw: str) -> str:
    text = _strip_json_fence(raw)
    start = text.find("{")
    if start < 0:
        return ""
    depth = 0
    in_string = False
    escaped = False
    for idx, ch in enumerate(text[start:], start=start):
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            depth += 1
            continue
        if ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : idx + 1]
    return ""


def _is_legacy_steps_payload(payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict):
        return False
    steps = payload.get("steps")
    return isinstance(steps, list)


def _validate_contract_schema(payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["payload must be an object"]

    required_root = ("version", "status", "summary", "plan")
    for key in required_root:
        if key not in payload:
            errors.append(f"missing root field: {key}")
    if errors:
        return errors

    status = str(payload.get("status", "")).strip().upper()
    if status not in STATUS_VALUES:
        errors.append("status must be one of OK|COMPLETED|NEEDS_INPUT|NEEDS_CONFIRMATION|BLOCKED|FAILED")

    if not isinstance(payload.get("summary"), str):
        errors.append("summary must be a string")

    plan_obj = payload.get("plan")
    if not isinstance(plan_obj, dict):
        errors.append("plan must be an object")
        return errors

    strategy = str(plan_obj.get("strategy", "")).strip().upper()
    if strategy not in PLAN_STRATEGIES:
        errors.append("plan.strategy invalid")

    steps = plan_obj.get("steps")
    if not isinstance(steps, list):
        errors.append("plan.steps must be an array")
        return errors

    for idx, step in enumerate(steps):
        if not isinstance(step, dict):
            errors.append(f"plan.steps[{idx}] must be an object")
            continue
        step_type = str(step.get("type", "browser")).strip().lower()
        if step_type not in STEP_TYPES:
            errors.append(f"plan.steps[{idx}].type invalid")
            continue
        if step_type == "consult":
            if "description" not in step or not isinstance(step.get("description"), str):
                errors.append(f"plan.steps[{idx}].description must be string")
            if "reason" not in step or not isinstance(step.get("reason"), str):
                errors.append(f"plan.steps[{idx}].reason must be string")
            continue
        action = str(step.get("command", "")).strip().lower()
        skill = str(step.get("skill", "")).strip().upper()
        if not action and not skill:
            errors.append(f"plan.steps[{idx}] requires command or skill")
        if action and action not in BROWSER_ACTIONS:
            errors.append(f"plan.steps[{idx}].command invalid")
        if "description" not in step or not isinstance(step.get("description"), str):
            errors.append(f"plan.steps[{idx}].description must be string")
        if action in {"open", "navigate"}:
            target = step.get("target")
            args = step.get("args")
            if not (isinstance(target, str) and target.strip()) and not (
                isinstance(args, list) and args and isinstance(args[0], str) and args[0].strip()
            ):
                errors.append(f"plan.steps[{idx}] open command requires target or args[0]")
        interactive = action in {"click", "type", "hover", "select", "upload"} or (
            not action and skill in {"SAFE_CLICK", "SAFE_FILL", "SAFE_SELECT"}
        )
        if interactive:
            target = step.get("target")
            focused_field_type = (
                action == "type"
                and step.get("value", None) not in (None, "")
                and target in ("", None, {})
            )
            if focused_field_type:
                continue
            if isinstance(target, str):
                if not target.strip():
                    errors.append(f"plan.steps[{idx}].target must not be empty")
            elif isinstance(target, dict):
                candidates = target.get("candidates")
                has_native_target = bool(_normalize_contract_target_dict(target))
                if not has_native_target and (not isinstance(candidates, list) or not candidates):
                    errors.append(f"plan.steps[{idx}].target.candidates must be non-empty array")
                disamb = target.get("disambiguation")
                if disamb is not None and not isinstance(disamb, dict):
                    errors.append(f"plan.steps[{idx}].target.disambiguation must be object")
            else:
                errors.append(f"plan.steps[{idx}].target must be object or ref string")
    return errors


def _normalize_contract_target_dict(target: dict[str, Any]) -> dict[str, Any] | None:
    by = str(target.get("by", "")).strip().lower()
    value = str(target.get("value", "")).strip()
    name = str(target.get("name", "")).strip()

    if by == "ref":
        ref_value = value or str(target.get("ref", "")).strip()
        return {"by": "ref", "value": ref_value} if ref_value else None
    if by in {"role", "label", "placeholder", "testid", "name", "text", "css"} and value:
        normalized: dict[str, Any] = {"by": by, "value": value}
        if by == "role":
            normalized["name"] = name
        return normalized

    ref_value = str(target.get("ref", "")).strip()
    if ref_value:
        return {"by": "ref", "value": ref_value}

    role = str(target.get("role", "")).strip()
    if role:
        return {"by": "role", "value": role, "name": name}

    label = str(target.get("label", "")).strip()
    if label:
        return {"by": "label", "value": label}

    placeholder = str(target.get("placeholder", "")).strip()
    if placeholder:
        return {"by": "placeholder", "value": placeholder}

    testid = str(target.get("testid", "")).strip()
    if testid:
        return {"by": "testid", "value": testid}

    text = str(target.get("text", "")).strip()
    if text:
        return {"by": "text", "value": text}

    return None


def _limit_browser_steps(
    steps: list[dict[str, Any]],
    *,
    max_browser_steps: int | None,
    prefer_existing_snapshot: bool = False,
) -> list[dict[str, Any]]:
    if max_browser_steps is None or max_browser_steps <= 0:
        return list(steps)

    remaining_browser_steps = [
        step
        for step in steps
        if isinstance(step, dict) and str(step.get("type", "browser")).strip().lower() == "browser"
    ]
    if len(remaining_browser_steps) <= max_browser_steps:
        return list(steps)

    limited: list[dict[str, Any]] = []
    browser_count = 0
    skipped_initial_snapshot = False

    for step in steps:
        if not isinstance(step, dict):
            continue
        if str(step.get("type", "browser")).strip().lower() != "browser":
            limited.append(step)
            continue

        command = str(step.get("command", "")).strip().lower()
        if (
            prefer_existing_snapshot
            and not skipped_initial_snapshot
            and command == "snapshot"
            and browser_count == 0
            and any(
                str(candidate.get("command", "")).strip().lower() != "snapshot"
                for candidate in remaining_browser_steps
                if isinstance(candidate, dict)
            )
        ):
            skipped_initial_snapshot = True
            continue

        if browser_count >= max_browser_steps:
            continue
        limited.append(step)
        browser_count += 1

    return limited


def _parse_json_payload(raw: str) -> dict[str, Any]:
    candidates = [_strip_json_fence(raw), _extract_first_json_object(raw)]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            continue
    raise ValueError("Model output is not valid JSON")


async def _call_gemini(
    system_prompt: str,
    user_prompt: str,
    model_override: str | None = None,
    max_browser_steps: int | None = None,
    screenshot: str = "",
) -> dict[str, Any]:
    """Shared Gemini call that returns parsed plan JSON."""
    from google import genai
    from google.genai import types

    model_name, location = resolve_model_selection(model_override)
    client = genai.Client(
        vertexai=settings.google_genai_use_vertexai,
        project=settings.gcp_project or None,
        location=location,
        api_key=None if settings.google_genai_use_vertexai else (settings.google_api_key or None),
    )

    parts: list[dict[str, Any]] = []
    image_data = screenshot.split(",", 1)[1] if "," in screenshot else screenshot
    if image_data.strip():
        parts.append(
            {
                "inline_data": {
                    "mime_type": "image/jpeg",
                    "data": image_data if "," not in screenshot else base64.b64encode(base64.b64decode(image_data)).decode(),
                }
            }
        )
    parts.append({"text": f"{system_prompt}\n\n{user_prompt}"})

    timeout_seconds = _planner_llm_timeout_seconds(max_browser_steps=max_browser_steps)
    response = await asyncio.wait_for(
        client.aio.models.generate_content(
            model=model_name,
            contents=[
                {"role": "user", "parts": parts},
            ],
            config=types.GenerateContentConfig(temperature=0.2),
        ),
        timeout=timeout_seconds,
    )
    raw = (response.text or "{}").strip()
    logger.info(
        "navigator_planner_llm_raw_response",
        extra={
            "model_name": model_name,
            "timeout_seconds": timeout_seconds,
            "has_screenshot": bool(image_data.strip()),
            "raw_text": _truncate_log_text(raw, 8000),
            "prompt_excerpt": _truncate_log_text(user_prompt, 2000),
        },
    )

    try:
        parsed = _parse_json_payload(raw)
        if _is_contract_payload(parsed):
            schema_errors = _validate_contract_schema(parsed)
            if not schema_errors:
                return parsed
            raise ValueError("Contract schema validation failed: " + "; ".join(schema_errors[:8]))
        if _is_legacy_steps_payload(parsed):
            return parsed
        raise ValueError("Parsed JSON does not match contract or legacy shape")
    except Exception as first_error:
        repair_prompt = (
            "Repair the following model output into VALID JSON that strictly "
            "follows the required contract. "
            "Return JSON only, no markdown.\n\n"
            f"Original output:\n{raw}\n\n"
            f"Parse/validation error:\n{first_error}\n"
        )
        repair_response = await asyncio.wait_for(
            client.aio.models.generate_content(
                model=model_name,
                contents=[
                    {"role": "user", "parts": [{"text": f"{system_prompt}\n\n{repair_prompt}"}]},
                ],
                config=types.GenerateContentConfig(temperature=0.0),
            ),
            timeout=timeout_seconds,
            )
        repaired_raw = (repair_response.text or "{}").strip()
        logger.warning(
            "navigator_planner_llm_repair_response",
            extra={
                "model_name": model_name,
                "timeout_seconds": timeout_seconds,
                "parse_error": str(first_error),
                "raw_text": _truncate_log_text(raw, 4000),
                "repaired_text": _truncate_log_text(repaired_raw, 8000),
                "prompt_excerpt": _truncate_log_text(user_prompt, 2000),
            },
        )
        repaired = _parse_json_payload(repaired_raw)
        if _is_contract_payload(repaired):
            schema_errors = _validate_contract_schema(repaired)
            if schema_errors:
                raise ValueError(
                    "Repaired contract invalid: " + "; ".join(schema_errors[:8])
                ) from first_error
            return repaired
        if _is_legacy_steps_payload(repaired):
            return repaired
        raise ValueError(
            "Repair output invalid for contract and legacy payload"
        ) from first_error


def _validate_steps(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Filter steps to only those with valid types and actions."""
    validated = []
    for step in steps:
        step_type = step.get("type", "")
        if step_type not in STEP_TYPES:
            continue
        if step_type == "browser":
            action = str(step.get("command", "")).strip()
            if action not in BROWSER_ACTIONS:
                continue
            if action == "act":
                if not str(step.get("ref", "")).strip():
                    continue
            elif action in {"click", "type", "hover", "select", "upload", "navigate", "open"}:
                target = step.get("target")
                if action == "open":
                    args = step.get("args")
                    if target in (None, "", {}) and not (isinstance(args, list) and args):
                        continue
                elif target in (None, "", {}):
                    continue
                if action in {"navigate", "open"} and target not in (None, "", {}) and not isinstance(target, str):
                    continue
        validated.append(step)
    return validated


def _validate_agent_browser_steps(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Validate planner output against the typed executable agent-browser step model."""
    validated: list[dict[str, Any]] = []
    for step in steps:
        try:
            validated.append(
                AgentBrowserStep.model_validate(step).model_dump(mode="json", exclude_none=True)
            )
        except Exception as exc:
            logger.debug("Dropping invalid agent-browser step from planner output: %s", exc)
    return validated


def _snapshot_has_refs(snapshot: dict[str, Any] | None) -> bool:
    if not isinstance(snapshot, dict):
        return False
    refs = snapshot.get("refs", {})
    if isinstance(refs, dict) and refs:
        return True
    snapshot_text = str(snapshot.get("snapshot", "") or "")
    return bool(re.search(r"\[ref=e\d+\]", snapshot_text))


def _interactive_step_uses_semantic_target(step: dict[str, Any]) -> bool:
    if step.get("type") != "browser":
        return False
    command = str(step.get("command", "")).strip().lower()
    if command not in {"click", "type", "hover", "select", "upload"}:
        return False
    target = step.get("target")
    return not (isinstance(target, str) and target.startswith("@"))


def _plan_needs_refinement_to_snapshot_refs(
    steps: list[dict[str, Any]],
    page_snapshot: dict[str, Any] | None,
) -> bool:
    if not _snapshot_has_refs(page_snapshot):
        return False
    return any(_interactive_step_uses_semantic_target(step) for step in steps)


async def _refine_plan_to_snapshot_refs(
    *,
    base_prompt: str,
    validated_steps: list[dict[str, Any]],
    model_override: str | None,
    user_prompt: str,
    current_url: str,
) -> list[dict[str, Any]]:
    refinement_prompt = (
        f"{base_prompt}\n\n"
        "EXISTING DRAFTED BROWSER STEPS:\n"
        f"{json.dumps(validated_steps, ensure_ascii=False)}\n\n"
        "Rewrite the plan so interactive browser steps use direct snapshot refs like @e2 whenever the current snapshot already provides them. "
        "Keep the plan agent-browser-native. Preserve only the necessary open/wait/snapshot steps. "
        "Return the same JSON contract and do not emit raw CLI strings.\n"
    )
    refined = await _call_gemini(
        build_navigator_system_prompt(task="agent_browser_step_planner"),
        refinement_prompt,
        model_override=model_override,
        max_browser_steps=None,
    )
    raw_steps = _steps_from_contract(refined) if _is_contract_payload(refined) else refined.get("steps", [])
    validated = _validate_steps(raw_steps)
    guarded = apply_flow_guardrails(
        steps=validated,
        user_prompt=user_prompt,
        current_url=current_url,
        has_snapshot=True,
    )
    return _validate_agent_browser_steps(guarded)


def _is_contract_payload(payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict):
        return False
    plan_obj = payload.get("plan")
    if not isinstance(plan_obj, dict):
        return False
    steps = plan_obj.get("steps")
    return isinstance(steps, list) and ("status" in payload or "summary" in payload)


def _target_from_candidate(candidate: dict[str, Any], action: str) -> tuple[Any, Any]:
    ctype = str(candidate.get("type", "")).strip().lower()
    value = candidate.get("value", "")
    if ctype == "ref":
        ref = str(candidate.get("value", "")).strip() or str(candidate.get("ref", "")).strip()
        normalized = ref if ref.startswith("@") else f"@{ref}"
        input_value = candidate.get("input") if candidate.get("input", None) not in (None, "") else ""
        return normalized, input_value
    if ctype == "role":
        role = str(candidate.get("role", "")).strip() or "textbox"
        name = str(candidate.get("name", "")).strip()
        return {"by": "role", "value": role, "name": name}, value
    if ctype == "text":
        text = str(candidate.get("value", "")).strip() or str(candidate.get("text", "")).strip()
        return {"by": "text", "value": text}, value
    if ctype == "name":
        name = str(candidate.get("value", "")).strip() or str(candidate.get("name", "")).strip()
        return {"by": "name", "value": name}, value
    if ctype == "placeholder":
        name = str(candidate.get("value", "")).strip() or str(candidate.get("name", "")).strip()
        return {"by": "placeholder", "value": name}, value
    if ctype == "url":
        url = str(candidate.get("value", "")).strip()
        if action == "navigate":
            return url, value
        return "", value
    if ctype == "testid":
        return {"by": "testid", "value": str(candidate.get("value", "")).strip()}, value
    if ctype in {"aria-label", "aria_label"}:
        return {"by": "label", "value": str(candidate.get("value", "")).strip()}, value
    if ctype == "id":
        raw_id = str(candidate.get("value", "")).strip()
        if not raw_id:
            return "", value
        escaped = raw_id.replace("\\", "\\\\").replace('"', '\\"')
        return {"by": "css", "value": f"#{escaped}"}, value
    if ctype == "css":
        return {"by": "css", "value": str(candidate.get("value", "")).strip()}, value
    return "", value


def _target_from_strategy_or_target(
    row: dict[str, Any], action: str
) -> tuple[Any, Any, dict[str, Any] | None]:
    value: Any = row.get("value", "")
    strategy = row.get("target_strategy", {})
    target_obj = row.get("target", {})
    act_payload: dict[str, Any] | None = None
    target: Any = ""

    if isinstance(target_obj, dict):
        normalized_target = _normalize_contract_target_dict(target_obj)
        if normalized_target:
            mapped_target, mapped_value = _target_from_candidate(normalized_target, action)
            if mapped_value not in (None, ""):
                value = mapped_value
            if mapped_target not in ("", None):
                target = mapped_target
        candidates = target_obj.get("candidates", [])
        if target in ("", None) and isinstance(candidates, list):
            for c in candidates:
                if not isinstance(c, dict):
                    continue
                mapped_target, mapped_value = _target_from_candidate(c, action)
                if mapped_value not in (None, ""):
                    value = mapped_value
                if isinstance(mapped_target, dict) and mapped_target.get("command") == "act":
                    act_payload = mapped_target
                    break
                if mapped_target not in ("", None):
                    target = mapped_target
                    break

    if act_payload is None and target in ("", None) and isinstance(strategy, dict):
        kind = str(strategy.get("kind", "")).strip().lower()
        if kind == "ref":
            ref = str(strategy.get("ref", "")).strip()
            act_kind = action if action in {"click", "type", "hover", "select"} else "click"
            act_payload = {"command": "act", "ref": ref, "kind": act_kind, "value": value}
        elif kind == "role_name":
            role = str(strategy.get("role", "")).strip() or "textbox"
            name = str(strategy.get("name", "")).strip()
            target = {"by": "role", "value": role, "name": name}
        elif kind == "text":
            target = {"by": "text", "value": str(strategy.get("text", "")).strip()}
        elif kind == "name":
            target = {"by": "name", "value": str(strategy.get("name", "")).strip()}
        elif kind == "placeholder":
            target = {"by": "placeholder", "value": str(strategy.get("name", "")).strip()}
        elif kind == "url":
            target = str(strategy.get("value", "")).strip() or str(strategy.get("text", "")).strip()
        if strategy.get("value", "") not in (None, ""):
            value = strategy.get("value")

    if act_payload is None and target in ("", None):
        target = row.get("target", "")
    return target, value, act_payload


def _normalize_status(raw: str) -> str:
    text = (raw or "").strip().upper()
    return text if text in STATUS_VALUES else "OK"


def _next_action_for_status(status: str) -> str:
    return {
        "COMPLETED": "complete_workflow",
        "NEEDS_CONFIRMATION": "await_user_confirmation",
        "NEEDS_INPUT": "await_user_input",
        "BLOCKED": "ask_user_to_intervene",
        "FAILED": "abort",
        "OK": "execute_plan",
    }.get(status, "execute_plan")


def _normalize_assumptions(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw[:20]:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        confidence = item.get("confidence", 0.0)
        try:
            confidence = float(confidence)
        except Exception:
            confidence = 0.0
        confidence = max(0.0, min(1.0, confidence))
        out.append(
            {
                "text": text[:300],
                "confidence": confidence,
                "critical": bool(item.get("critical", False)),
            }
        )
    return out


def _normalize_risks(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw[:20]:
        if not isinstance(item, dict):
            continue
        rtype = str(item.get("type", "")).strip().upper()
        sev = str(item.get("severity", "")).strip().upper()
        msg = str(item.get("message", "")).strip()
        if rtype not in RISK_TYPES or sev not in RISK_SEVERITIES or not msg:
            continue
        out.append({"type": rtype, "severity": sev, "message": msg[:300]})
    return out


def _normalize_policies(raw: Any) -> dict[str, Any]:
    policies = raw if isinstance(raw, dict) else {}
    cookie_preference = str(policies.get("cookie_preference", "REJECT")).strip().upper()
    if cookie_preference not in {"REJECT", "ACCEPT"}:
        cookie_preference = "REJECT"
    retries = policies.get("max_retries_per_step", 2)
    try:
        retries = int(retries)
    except Exception:
        retries = 2
    retries = max(1, min(5, retries))
    return {
        "cookie_preference": cookie_preference,
        "destructive_allowed": bool(policies.get("destructive_allowed", False)),
        "max_retries_per_step": retries,
    }


def _normalize_plan_strategy(raw: Any) -> str:
    text = str(raw or "").strip().upper()
    return text if text in PLAN_STRATEGIES else "DIRECT_ACTION"


def _normalize_preferred_execution_mode(raw: Any) -> str:
    text = str(raw or "").strip().lower()
    return text if text in {"ref", "visual", "manual"} else "ref"


def _normalize_target_kind(raw: Any) -> str:
    text = str(raw or "").strip().lower()
    return text if text in {"input", "editor", "button", "link", "dialog", "unknown"} else "unknown"


def _normalize_validation_rules(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw[:20]:
        if not isinstance(item, dict):
            continue
        vtype = str(item.get("type", "")).strip()
        if not vtype:
            continue
        clean: dict[str, Any] = {"type": vtype}
        for key, value in item.items():
            if key == "type":
                continue
            if isinstance(value, (str, int, float, bool)) and str(value)[:300]:
                clean[key] = value
        out.append(clean)
    return out


def _normalize_disambiguation(raw: Any) -> dict[str, Any]:
    data = raw if isinstance(raw, dict) else {}
    max_matches = data.get("max_matches", 1)
    try:
        max_matches = int(max_matches)
    except Exception:
        max_matches = 1
    max_matches = max(1, min(5, max_matches))
    return {
        "max_matches": max_matches,
        "must_be_visible": bool(data.get("must_be_visible", True)),
        "must_be_enabled": bool(data.get("must_be_enabled", True)),
        "prefer_topmost": bool(data.get("prefer_topmost", True)),
    }


def _compute_snapshot_id(snapshot: dict[str, Any] | None) -> str:
    if not isinstance(snapshot, dict):
        return ""
    explicit = str(snapshot.get("snapshot_id", "") or snapshot.get("snapshotId", "")).strip()
    if explicit:
        return explicit
    base = "||".join(
        [
            str(snapshot.get("url", "") or ""),
            str(snapshot.get("title", "") or ""),
            str(snapshot.get("snapshot", "") or "")[:5000],
        ]
    )
    return hashlib.sha1(base.encode("utf-8")).hexdigest()[:16]


def _normalize_browser_step_args(
    *,
    action: str,
    browser_step: dict[str, Any],
    value: Any,
) -> tuple[dict[str, Any], Any]:
    args = browser_step.get("args", [])
    if not isinstance(args, list) or not args:
        return browser_step, value

    first_arg = str(args[0]).strip() if args else ""
    if action in {"type", "select", "upload"} and value in (None, "") and first_arg:
        value = first_arg
    elif action in {"press", "keyboard"} and value in (None, "") and first_arg:
        value = first_arg
    elif action in {"navigate", "open", "click", "hover"}:
        if browser_step.get("target") in ("", None, {}) and first_arg:
            browser_step["target"] = first_arg
    elif action == "wait" and first_arg:
        if browser_step.get("target") in ("", None, {}):
            if re.fullmatch(r"\d+(?:\.\d+)?", first_arg):
                value = int(float(first_arg))
            else:
                browser_step["target"] = first_arg
    elif action == "scroll" and first_arg:
        if browser_step.get("target") in ("", None, {}):
            if re.fullmatch(r"-?\d+(?:\.\d+)?", first_arg):
                value = int(float(first_arg))
            else:
                browser_step["target"] = first_arg
    elif action == "frame" and first_arg:
        if browser_step.get("target") in ("", None, {}):
            if first_arg == "main":
                value = "main"
            else:
                browser_step["target"] = first_arg
    elif action == "tab" and first_arg:
        if browser_step.get("target") in ("", None, {}) and value in (None, ""):
            if first_arg in {"list", "new", "close"}:
                value = first_arg
            else:
                browser_step["target"] = first_arg

    return browser_step, value


def _steps_from_contract(contract: dict[str, Any]) -> list[dict[str, Any]]:
    plan_obj = contract.get("plan", {})
    raw_steps = plan_obj.get("steps", []) if isinstance(plan_obj, dict) else []
    if not isinstance(raw_steps, list):
        return []
    out: list[dict[str, Any]] = []
    default_snapshot_id = str(contract.get("snapshot_id", "")).strip()
    for row in raw_steps:
        if not isinstance(row, dict):
            continue
        action = str(row.get("command", "")).strip().lower()
        if not action:
            skill = str(row.get("skill", "")).strip().upper()
            action = SKILL_TO_ACTION.get(skill, "")
        if action not in BROWSER_ACTIONS:
            continue
        description = str(row.get("description", "")).strip() or action
        explicit_ref = str(row.get("ref", "")).strip()
        explicit_kind = str(row.get("kind", "")).strip().lower()
        target, value, act_payload = _target_from_strategy_or_target(row, action)
        target_obj = row.get("target", {}) if isinstance(row.get("target", {}), dict) else {}
        snapshot_id = (
            str(row.get("snapshot_id", "")).strip()
            or str(target_obj.get("snapshot_id", "")).strip()
            or default_snapshot_id
        )

        # Degrade legacy ref actions into native agent-browser targets.
        if (
            action == "act"
            and explicit_ref
            and explicit_kind in {"click", "type", "hover", "select"}
        ):
            explicit_step: dict[str, Any] = {
                "type": "browser",
                "command": explicit_kind,
                "target": explicit_ref if explicit_ref.startswith("@") else f"@{explicit_ref}",
                "description": description,
            }
            if row.get("value", None) not in (None, ""):
                explicit_step["value"] = row.get("value")
            if snapshot_id:
                explicit_step["snapshot_id"] = snapshot_id
            out.append(explicit_step)
            continue

        # Graceful degradation: if model emits action=act without ref but with semantic target,
        # execute semantic action (kind) instead of dropping the step.
        if action == "act" and not explicit_ref:
            if explicit_kind in {"click", "type", "hover", "select"}:
                action = explicit_kind
            else:
                action = "click"

        browser_step: dict[str, Any] = {
            "type": "browser",
            "command": "open" if action == "navigate" else action,
            "target": target,
            "description": description,
        }
        args = row.get("args")
        if isinstance(args, list):
            browser_step["args"] = [str(item) for item in args if str(item).strip()]
            browser_step, value = _normalize_browser_step_args(
                action=action,
                browser_step=browser_step,
                value=value,
            )
        if action in {"keyboard", "press"}:
            key_value: Any = row.get("key", "")
            if key_value not in (None, "") and value in (None, ""):
                value = key_value
        if action in {"navigate", "open"}:
            browser_step["command"] = "open"
        if act_payload is not None:
            native_kind = str(act_payload.get("kind", "click") or "click")
            browser_step["command"] = native_kind
            browser_step["target"] = f"@{str(act_payload.get('ref', '')).lstrip('@')}"
            if act_payload.get("value", None) not in (None, "") and value in (None, ""):
                value = act_payload.get("value")
        if value not in (None, ""):
            browser_step["value"] = value
        preconditions = _normalize_validation_rules(row.get("preconditions", []))
        if preconditions:
            browser_step["preconditions"] = preconditions
        success_criteria = _normalize_validation_rules(row.get("success_criteria", []))
        if success_criteria:
            browser_step["success_criteria"] = success_criteria
        if target_obj:
            browser_step["disambiguation"] = _normalize_disambiguation(target_obj.get("disambiguation", {}))
        out.append(browser_step)
    return out

def _format_snapshot_context(snapshot: dict[str, Any]) -> str:
    """Format an aria page snapshot into context for the LLM prompt."""
    snapshot_text = snapshot.get("snapshot", "")
    if not snapshot_text:
        return ""

    ref_count = snapshot.get("refCount", 0)
    snapshot_id = _compute_snapshot_id(snapshot)
    return (
        f"\nPAGE SNAPSHOT — {ref_count} interactive elements on the current page:\n"
        f"SNAPSHOT_ID={snapshot_id}\n"
        f"(Use these refs e0, e1, e2... in act steps; do not use selectors)\n\n"
        f"{snapshot_text}"
    )


def _format_structured_context(structured: dict[str, Any]) -> str:
    elements = structured.get("elements", [])
    if not isinstance(elements, list) or not elements:
        return ""

    lines: list[str] = []
    for idx, el in enumerate(elements[:80]):
        if not isinstance(el, dict):
            continue
        tag = str(el.get("tag", "") or "")
        role = str(el.get("role", "") or "")
        text = str(el.get("text", "") or "").strip()
        aria = str(el.get("ariaLabel", "") or "").strip()
        placeholder = str(el.get("placeholder", "") or "").strip()
        name = str(el.get("name", "") or "").strip()
        ref = el.get("ref")
        label = text or aria or placeholder or name
        label = label[:90]
        lines.append(f"- i{idx} ref={ref} tag={tag} role={role} label=\"{label}\"")

    if not lines:
        return ""
    return (
        "\nSTRUCTURED INTERACTIVE ELEMENTS (fallback context when aria refs are sparse):\n"
        "(Prefer meaningful labels like Compose, New message, Send, Subject, To)\n"
        + "\n".join(lines)
    )


def _format_completed_context(completed_steps: list[str] | None) -> str:
    if not completed_steps:
        return ""
    lines: list[str] = []
    for i, step in enumerate(completed_steps[-20:], start=1):
        lines.append(f"{i}. {step[:160]}")
    return (
        "\nALREADY COMPLETED STEPS (do not repeat these):\n"
        + "\n".join(lines)
    )


def _should_include_structured_context(
    *,
    page_snapshot: dict[str, Any] | None,
    structured_context: dict[str, Any] | None,
    completed_steps: list[str] | None = None,
    failed_step: dict[str, Any] | None = None,
    error_message: str | None = None,
) -> bool:
    if not isinstance(structured_context, dict) or not structured_context:
        return False
    if failed_step or error_message:
        return True
    recent_completed = [str(step or "").strip().lower() for step in (completed_steps or [])[-3:]]
    if any("extract interactive structure" in step for step in recent_completed):
        return True
    if page_snapshot and _snapshot_has_refs(page_snapshot):
        return False
    return True


def _format_failure_context(
    failed_step: dict[str, Any] | None,
    error_message: str | None,
) -> str:
    if not failed_step and not error_message:
        return ""

    step_json = "{}"
    if isinstance(failed_step, dict):
        try:
            step_json = json.dumps(failed_step, ensure_ascii=False)
        except Exception:
            step_json = str(failed_step)
    error_text = (error_message or "").strip()[:500]
    return (
        "\nFAILURE CONTEXT:\n"
        f"failed_step={step_json}\n"
        f"error={error_text}\n"
        "Return a deterministic recovery sub-plan that starts from the CURRENT state. "
        "Do not repeat already completed steps.\n"
    )

async def plan_browser_steps(
    user_prompt: str,
    current_url: str = "",
    current_page_title: str = "",
    page_snapshot: dict[str, Any] | None = None,
    structured_context: dict[str, Any] | None = None,
    playbook_context: str = "",
    execution_brief: dict[str, Any] | None = None,
    execution_contract: dict[str, Any] | None = None,
    completed_steps: list[str] | None = None,
    failed_step: dict[str, Any] | None = None,
    error_message: str | None = None,
    model_override: str | None = None,
    max_browser_steps: int | None = None,
    screenshot: str = "",
    evidence_bundle: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Plan browser automation steps from a natural-language prompt.

    This is used by the Navigator tab where the user wants to control their
    attached browser tab. The prompt is interpreted in context of the website
    the user is currently viewing.
    """
    try:
        logger.info(
            "navigator_planner_started",
            extra={
                "current_url": current_url,
                "current_page_title": current_page_title,
                "has_snapshot": bool(page_snapshot),
                "snapshot_has_refs": bool(page_snapshot and _snapshot_has_refs(page_snapshot)),
                "has_structured_context": bool(structured_context),
                "has_screenshot": bool(str(screenshot or "").strip()),
                "has_evidence_bundle": bool(evidence_bundle),
                "completed_step_count": len(completed_steps or []),
                "has_failed_step": bool(failed_step),
                "has_error_message": bool(error_message),
                "max_browser_steps": max_browser_steps,
            },
        )
        url_context = ""
        if current_url:
            domain = (
                current_url.split("//")[-1].split("/")[0]
                if "//" in current_url
                else current_url
            )
            url_context = (
                f"User's browser tab is currently on: {current_url}\n"
                f"Page title: {current_page_title or domain}\n"
                f"Website: {domain}\n\n"
                "The user is looking at this page right now. Interpret their request "
                "in context of this website. Do NOT navigate away unless the task "
                "clearly requires a different website.\n"
            )
        else:
            url_context = (
                "No specific URL is attached. If the task requires a website, "
                "start with a navigate step to the appropriate URL.\n"
            )

        extra_sections: list[tuple[str, str]] = [
            ("Planning Date", f"Today (UTC): {datetime.utcnow().strftime('%Y-%m-%d')}"),
            ("Page Attachment Context", url_context.strip()),
        ]
        if playbook_context:
            extra_sections.append(("Playbook Context", playbook_context))
        if execution_contract:
            extra_sections.append(
                (
                    "Execution Contract",
                    json.dumps(execution_contract, ensure_ascii=True, indent=2),
                )
            )
        if execution_brief:
            extra_sections.append(
                (
                    "Execution Brief",
                    json.dumps(execution_brief, ensure_ascii=True, indent=2),
                )
            )
        if evidence_bundle:
            extra_sections.append(
                (
                    "Unified Evidence Bundle",
                    json.dumps(evidence_bundle, ensure_ascii=True, indent=2)[:6000],
                )
            )
        if page_snapshot:
            extra_sections.append(("Snapshot Context", _format_snapshot_context(page_snapshot)))
        if str(screenshot or "").strip():
            extra_sections.append(
                (
                    "Attached Screenshot Context",
                    "A current page screenshot is attached to this request. Use it to reason about overlays, modals, dialogs, drawers, shadow DOM content, or foreground UI that may not appear in the aria snapshot.",
                )
            )
        if _should_include_structured_context(
            page_snapshot=page_snapshot,
            structured_context=structured_context,
            completed_steps=completed_steps,
            failed_step=failed_step,
            error_message=error_message,
        ) and structured_context is not None:
            extra_sections.append(("Structured Context", _format_structured_context(structured_context)))
        if completed_steps:
            extra_sections.append(("Completed Steps", _format_completed_context(completed_steps)))
        if failed_step or error_message:
            extra_sections.append(("Failure Context", _format_failure_context(failed_step, error_message)))
        reference_context = ""
        if not page_snapshot or not _snapshot_has_refs(page_snapshot) or failed_step or error_message:
            reference_context = build_agent_browser_reference_context(
                user_prompt=user_prompt,
                current_url=current_url,
                failed_step=failed_step,
                error_message=error_message,
            )
        if reference_context:
            extra_sections.append(("Reference Context", reference_context))
        extra_sections.append(
                    (
                        "Execution Contract Reminder",
                        (
                            "Plan exactly one next action. "
                            "Respect the execution contract's phases, guardrails, confirmation policy, and success criteria. "
                            "Use the unified evidence bundle as the source of truth for the immediate next action. "
                            "Return advisory fields when helpful: preferred_execution_mode (ref|visual|manual), target_kind, sensitive_step, expected_state_change, verification_checks. "
                            "If a snapshot with refs is present and the evidence agrees with it, prefer one ref-based action only. "
                            "If the screenshot and structured context contradict the snapshot, you may prefer visual execution, but do not emit raw coordinates."
                        ),
                    )
                )
        bundle = build_navigator_prompt_bundle(
            task="agent_browser_step_planner",
            user_prompt=user_prompt,
            current_url=current_url,
            current_page_title=current_page_title,
            runtime_metadata={
                "task": "step_planning",
                "has_snapshot": bool(page_snapshot),
                "snapshot_has_refs": bool(page_snapshot and _snapshot_has_refs(page_snapshot)),
                "has_structured_context": bool(structured_context),
                "has_evidence_bundle": bool(evidence_bundle),
                "completed_step_count": len(completed_steps or []),
            },
            sections=extra_sections,
            include_retrieved_context=False,
            prompt_mode="minimal",
        )

        plan = await _call_gemini(
            bundle.system_prompt,
            bundle.task_prompt,
            model_override=model_override,
            max_browser_steps=max_browser_steps,
            screenshot=screenshot,
        )
        contract_payload: dict[str, Any] | None = None
        raw_steps: list[dict[str, Any]]
        if _is_contract_payload(plan):
            contract_payload = plan
            if contract_payload.get("snapshot_id") in (None, ""):
                contract_payload["snapshot_id"] = _compute_snapshot_id(page_snapshot)
            raw_steps = _steps_from_contract(plan)
        else:
            raw_steps = plan.get("steps", [])

        validated = _validate_steps(raw_steps)
        logger.info(
            "navigator_planner_validated_steps",
            extra={
                "user_prompt": _truncate_log_text(user_prompt, 1000),
                "prompt_context": bundle.debug,
                "raw_step_count": len(raw_steps),
                "validated_step_count": len(validated),
                "raw_steps": _truncate_log_text(json.dumps(raw_steps, ensure_ascii=True), 8000),
                "validated_steps": _truncate_log_text(json.dumps(validated, ensure_ascii=True), 8000),
            },
        )
        if _plan_needs_refinement_to_snapshot_refs(validated, page_snapshot):
            refined_steps = await _refine_plan_to_snapshot_refs(
                base_prompt=bundle.task_prompt,
                validated_steps=validated,
                model_override=model_override,
                user_prompt=user_prompt,
                current_url=current_url,
            )
            if refined_steps:
                logger.info(
                    "Navigator planner refined %d steps to snapshot refs for '%s'",
                    len(refined_steps),
                    user_prompt,
                )
                validated = refined_steps
        validated = apply_flow_guardrails(
            steps=validated,
            user_prompt=user_prompt,
            current_url=current_url,
            has_snapshot=bool(page_snapshot),
        )
        logger.info(
            "navigator_planner_guardrailed_steps",
            extra={
                "user_prompt": _truncate_log_text(user_prompt, 1000),
                "guardrailed_step_count": len(validated),
                "guardrailed_steps": _truncate_log_text(json.dumps(validated, ensure_ascii=True), 8000),
            },
        )
        validated = _validate_agent_browser_steps(validated)
        enforced_step_limit = 1 if max_browser_steps is None or max_browser_steps <= 0 else max_browser_steps
        validated = _limit_browser_steps(
            validated,
            max_browser_steps=enforced_step_limit,
            prefer_existing_snapshot=bool(page_snapshot),
        )
        logger.info(
            "navigator_planner_executable_steps",
            extra={
                "user_prompt": _truncate_log_text(user_prompt, 1000),
                "executable_step_count": len(validated),
                "executable_steps": _truncate_log_text(json.dumps(validated, ensure_ascii=True), 8000),
            },
        )

        if not validated:
            logger.warning(
                "Navigator planner returned no browser steps for '%s'. Raw: %s",
                user_prompt, json.dumps(plan.get("steps", []))[:500],
            )

        status = _normalize_status(str((contract_payload or {}).get("status", "OK")))
        assumptions = _normalize_assumptions((contract_payload or {}).get("assumptions", []))
        risks = _normalize_risks((contract_payload or {}).get("risks", []))
        policies = _normalize_policies((contract_payload or {}).get("policies", {}))
        plan_strategy = _normalize_plan_strategy(
            str(((contract_payload or {}).get("plan", {}) or {}).get("strategy", ""))
        )

        result = {
            "steps": validated,
            "requires_browser": True,
            # Executor-owned estimate only (never model-sourced).
            "estimated_duration_seconds": len(validated) * 5,
            # Compatibility field for existing UI; not model-controlled.
            "mode": "plan",
            "status": status,
            "summary": str((contract_payload or {}).get("summary", "")),
            "assumptions": assumptions,
            # Derived from status to avoid duplicate source of truth.
            "needs_confirmation": status == "NEEDS_CONFIRMATION",
            "risks": risks,
            "next_action": _next_action_for_status(status),
            "plan_strategy": plan_strategy,
            "policies": policies,
            "preferred_execution_mode": _normalize_preferred_execution_mode((contract_payload or {}).get("preferred_execution_mode", "") or "ref"),
            "target_kind": _normalize_target_kind((contract_payload or {}).get("target_kind", "")),
            "sensitive_step": bool((contract_payload or {}).get("sensitive_step", False)),
            "expected_state_change": str((contract_payload or {}).get("expected_state_change", "") or ""),
            "verification_checks": [
                str(item).strip()
                for item in list((contract_payload or {}).get("verification_checks", []) or [])
                if str(item).strip()
            ][:5],
        }
        logger.info(
            "navigator_planner_completed",
            extra={
                "step_count": len(validated),
                "status": status,
                "plan_strategy": plan_strategy,
                "user_prompt": _truncate_log_text(user_prompt, 1000),
            },
        )
        return result

    except TimeoutError:
        logger.error(
            "navigator_planner_timed_out",
            extra={
                "current_url": current_url,
                "current_page_title": current_page_title,
                "has_snapshot": bool(page_snapshot),
                "has_screenshot": bool(str(screenshot or "").strip()),
                "has_evidence_bundle": bool(evidence_bundle),
                "completed_step_count": len(completed_steps or []),
                "timeout_seconds": _planner_llm_timeout_seconds(max_browser_steps=max_browser_steps),
            },
        )
        return _navigator_fallback(
            user_prompt,
            current_url,
            max_browser_steps=max_browser_steps,
        )
    except Exception as exc:
        logger.error("Navigator planner failed: %s", exc)
        return _navigator_fallback(
            user_prompt,
            current_url,
            max_browser_steps=max_browser_steps,
        )


def _runtime_block_reason(planner_result: dict[str, Any]) -> str:
    status = str(planner_result.get("status", "") or "").strip().upper()
    if status == "NEEDS_CONFIRMATION":
        return "confirmation_required"
    if status == "NEEDS_INPUT":
        return "needs_input"
    if status == "BLOCKED":
        return "blocked"
    return "planner_failed"


def _runtime_block_reason_code(planner_result: dict[str, Any]) -> str:
    status = str(planner_result.get("status", "") or "").strip().upper()
    next_action = str(planner_result.get("next_action", "") or "").strip().lower()
    if status == "NEEDS_CONFIRMATION":
        return "planner_requires_confirmation"
    if status == "NEEDS_INPUT":
        return "planner_requires_user_reply"
    if status == "BLOCKED":
        return "planner_blocked"
    if next_action == "await_user_input":
        return "planner_requires_user_reply"
    return "planner_failed"


async def plan_runtime_action(
    *,
    execution_contract: dict[str, Any],
    user_prompt: str | None = None,
    current_url: str = "",
    current_page_title: str = "",
    page_snapshot: dict[str, Any] | None = None,
    structured_context: dict[str, Any] | None = None,
    playbook_context: str = "",
    completed_steps: list[str] | None = None,
    failed_step: dict[str, Any] | None = None,
    error_message: str | None = None,
    model_override: str | None = None,
    max_browser_steps: int | None = None,
    screenshot: str = "",
    evidence_bundle: dict[str, Any] | None = None,
) -> RuntimeActionPlan:
    planner_result = await plan_browser_steps(
        user_prompt=str(user_prompt or execution_contract.get("resolved_goal", "") or ""),
        current_url=current_url,
        current_page_title=current_page_title,
        page_snapshot=page_snapshot,
        structured_context=structured_context,
        playbook_context=playbook_context,
        execution_contract=execution_contract,
        execution_brief=None,
        completed_steps=completed_steps,
        failed_step=failed_step,
        error_message=error_message,
        model_override=model_override,
        max_browser_steps=max_browser_steps,
        screenshot=screenshot,
        evidence_bundle=evidence_bundle,
    )
    status = str(planner_result.get("status", "") or "").strip().upper()
    if status == "COMPLETED":
        return RuntimeActionPlan(
            status="completed",
            summary=str(planner_result.get("summary", "") or "The task completed successfully."),
            intent=str(planner_result.get("summary", "") or ""),
            preferred_execution_mode=str(planner_result.get("preferred_execution_mode", "") or "ref"),
            target_kind=str(planner_result.get("target_kind", "") or None) or None,
            sensitive_step=bool(planner_result.get("sensitive_step", False)),
            expected_state_change=str(planner_result.get("expected_state_change", "") or ""),
            verification_checks=list(planner_result.get("verification_checks", []) or []),
            evidence=evidence_bundle,
        )
    steps = [
        step
        for step in list(planner_result.get("steps", []) or [])
        if isinstance(step, dict) and str(step.get("type", "browser")).strip().lower() == "browser"
    ]
    if status in {"NEEDS_CONFIRMATION", "NEEDS_INPUT", "BLOCKED", "FAILED"} or not steps:
        reason = _runtime_block_reason(planner_result)
        return RuntimeActionPlan(
            status="blocked",
            summary=str(planner_result.get("summary", "") or "The planner could not produce a safe next action."),
            block=RuntimeBlock(
                reason=reason,
                reason_code=_runtime_block_reason_code(planner_result),
                message=str(planner_result.get("summary", "") or "The planner could not produce a safe next action."),
                requires_user_reply=status in {"NEEDS_CONFIRMATION", "NEEDS_INPUT", "BLOCKED"},
                requires_confirmation=reason == "confirmation_required",
                retriable=status != "FAILED",
                halt_kind="waiting_for_human" if reason == "confirmation_required" else "waiting_for_user_action" if status in {"NEEDS_CONFIRMATION", "NEEDS_INPUT", "BLOCKED"} else None,
                policy_source="llm_advisory" if status in {"NEEDS_CONFIRMATION", "NEEDS_INPUT", "BLOCKED"} else "deterministic",
                verification_status="not_run",
            ),
            intent=str(user_prompt or execution_contract.get("resolved_goal", "") or ""),
            preferred_execution_mode=str(planner_result.get("preferred_execution_mode", "") or "visual"), 
            target_kind=str(planner_result.get("target_kind", "") or None) or None,
            sensitive_step=bool(planner_result.get("sensitive_step", False)),
            expected_state_change=str(planner_result.get("expected_state_change", "") or ""),
            verification_checks=list(planner_result.get("verification_checks", []) or []),
            evidence=evidence_bundle,
        )
    return RuntimeActionPlan(
        status="action",
        summary=str(planner_result.get("summary", "") or ""),
        step=AgentBrowserStep.model_validate(steps[0]),
        intent=str(planner_result.get("summary", "") or user_prompt or execution_contract.get("resolved_goal", "") or ""),
        preferred_execution_mode=str(planner_result.get("preferred_execution_mode", "") or "visual"), 
        target_kind=str(planner_result.get("target_kind", "") or None) or None,
        sensitive_step=bool(planner_result.get("sensitive_step", False)),
        expected_state_change=str(planner_result.get("expected_state_change", "") or ""),
        verification_checks=list(planner_result.get("verification_checks", []) or []),
        evidence=evidence_bundle,
    )


def _navigator_fallback(
    user_prompt: str,
    current_url: str = "",
    *,
    max_browser_steps: int | None = None,
) -> dict[str, Any]:
    """Minimal non-heuristic fallback when the planner output is unavailable or invalid."""
    consult_step = {
        "type": "consult",
        "reason": "planner_output_invalid",
        "description": (
            "I could not produce a valid next action from the current state. "
            "Please retry or refine the request."
        ),
    }
    return {
        "steps": [consult_step],
        "requires_browser": True,
        "estimated_duration_seconds": 5,
        # Compatibility field for existing UI.
        "mode": "plan",
        "status": "NEEDS_INPUT",
        "summary": (
            "Planner output was unavailable or invalid, so execution could not continue."
        ),
        "assumptions": [],
        "needs_confirmation": False,
        "risks": [],
        "next_action": "await_user_input",
        "plan_strategy": "REPAIR_SUBPLAN",
    }
