"""Browser Step Planner — builds safe browser automation steps.

Uses Gemini to understand user intent and produce browser steps for the
Navigator flow. DOM interactions are ref-based (`snapshot` + `act`) to avoid
fragile selector targeting.
"""
from __future__ import annotations

import json
import logging
import hashlib
from datetime import datetime
from pathlib import Path
from typing import Any

from oi_agent.config import settings
from oi_agent.services.tools.navigator.planner_guardrails import apply_flow_guardrails

logger = logging.getLogger(__name__)


STEP_TYPES = ("browser", "consult")

BROWSER_ACTIONS = (
    "navigate", "wait", "keyboard", "screenshot", "read_dom",
    "extract_structured", "highlight", "snapshot", "act", "media_state",
    # Interactive semantic actions are allowed and preferred; guardrails sanitize brittle selectors.
    "click", "type", "scroll", "hover", "select",
)

STATUS_VALUES = {"OK", "NEEDS_INPUT", "NEEDS_CONFIRMATION", "BLOCKED", "FAILED"}
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
    "UPLOAD_FILE": "type",
    "VERIFY": "wait",
}

NAVIGATOR_SYSTEM_PROMPT = """You are a browser automation planner. The user has a browser tab open and wants you to interact with it. You MUST produce browser steps — NEVER use API steps.

You control the browser via Chrome DevTools Protocol (CDP). Interactions work on ANY website.

STEP FORMATS:
- Browser step:
  {"type":"browser","action":"<action>", ...}

  Ref-based format (recommended when snapshot refs are available):
  {"type":"browser","action":"act","kind":"click|type|hover|select","ref":"e5","value":"<optional>","description":"<human description>"}

- Consult step:
   {"type": "consult", "reason": "<why>", "description": "<explanation>"}
  ONLY for: payment, CAPTCHA, 2FA, login requiring credentials

IMPORTANT:
- Use ONLY executable actions from this set:
  navigate, wait, keyboard, screenshot, read_dom, extract_structured, highlight, snapshot, act, click, type, hover, select, scroll.
- Locator strategy (in order):
  1) Use semantic targets for click/type/hover/select (role/text/name/aria/placeholder based).
  2) Use `act` + `ref` when snapshot refs are clearly available.
  3) Never use brittle CSS class chains or XPath.
  4) Never return coordinate-based targets as a primary strategy.
- Accept ref forms (`e5`, `@e5`, `ref=e5`) but normalize to `ref: "e5"` in output.
- Keep descriptions short and concrete.
- Complete the full intent in one plan:
  if user says "play/watch/listen X", do not stop at search; include opening the result and a confirmation wait/screenshot.
- For messaging intents ("send message to <name>"), keep recipient locator clean:
  recipient target must be only the entity name (example: "tortoise"), never include extra clauses like "message content", "send any message", or platform suffix text.
- Do not output passive-only plans (snapshot/wait/screenshot) for interactive user requests.
- If user's tab is already on relevant site, do not navigate away unnecessarily.

Return ONLY a JSON object following this contract:
{
  "version":"1.1",
  "status":"OK",
  "summary":"short summary",
  "assumptions":[{"text":"...", "confidence":0.0, "critical":false}],
  "risks":[{"type":"AMBIGUITY","severity":"LOW","message":"..."}],
  "policies":{
    "cookie_preference":"REJECT",
    "destructive_allowed": false,
    "max_retries_per_step": 2
  },
  "plan":{
    "strategy":"SEARCH_FIRST_THEN_SELECT",
    "steps":[
      {
        "id":"s1",
        "action":"click",
        "description":"...",
        "skill":"SAFE_CLICK",
        "target":{
          "candidates":[
            {"type":"testid","value":"compose-btn","weight":1.0},
            {"type":"role","role":"button","name":"Compose","weight":0.8}
          ],
          "disambiguation":{
            "max_matches":1,
            "must_be_visible":true,
            "must_be_enabled":true,
            "prefer_topmost":true
          }
        },
        "preconditions":[
          {"type":"state_marker","title_contains":"Inbox"},
          {"type":"no_security_gate"},
          {"type":"no_blocker_or_resolved"},
          {"type":"target","must_exist":true,"must_be_visible":true,"must_be_enabled":true,"must_be_clickable":true}
        ],
        "success_criteria":[{"type":"selector_visible","selector":"[role='dialog']"}]
      }
    ]
  },
  "requires_browser": true
}

Critical requirements:
- For messaging/chat intents, default to search-first flow:
  focus search -> type recipient -> open result -> type message -> send -> verify.
- Do not output coordinate targets.
- Keep target candidates machine-readable and deterministic.
- Use single enum values only; do not output pipe-delimited choices.
"""


def _load_ui_navigator_prompt() -> str:
    """Load project UI navigator requirements from markdown prompt file."""
    prompt_path = Path(__file__).resolve().parents[4] / "UI_NAVIGATOR_PROMPT.md"
    try:
        if prompt_path.exists():
            return prompt_path.read_text(encoding="utf-8")
    except Exception as exc:
        logger.debug("Failed to load UI navigator prompt: %s", exc)
    return ""


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
        errors.append("status must be one of OK|NEEDS_INPUT|NEEDS_CONFIRMATION|BLOCKED|FAILED")

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
        action = str(step.get("action", "")).strip().lower()
        skill = str(step.get("skill", "")).strip().upper()
        if not action and not skill:
            errors.append(f"plan.steps[{idx}] requires action or skill")
        if action and action not in BROWSER_ACTIONS:
            errors.append(f"plan.steps[{idx}].action invalid")
        if "description" not in step or not isinstance(step.get("description"), str):
            errors.append(f"plan.steps[{idx}].description must be string")
        interactive = action in {"click", "type", "hover", "select"} or (not action and skill in {"SAFE_CLICK", "SAFE_FILL", "SAFE_SELECT"})
        if interactive:
            target = step.get("target")
            if not isinstance(target, dict):
                errors.append(f"plan.steps[{idx}].target must be object")
                continue
            candidates = target.get("candidates")
            if not isinstance(candidates, list) or not candidates:
                errors.append(f"plan.steps[{idx}].target.candidates must be non-empty array")
            disamb = target.get("disambiguation")
            if not isinstance(disamb, dict):
                errors.append(f"plan.steps[{idx}].target.disambiguation must be object")
            else:
                if "max_matches" not in disamb:
                    errors.append(f"plan.steps[{idx}].target.disambiguation.max_matches missing")
    return errors


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


async def _call_gemini(system_prompt: str, user_prompt: str) -> dict[str, Any]:
    """Shared Gemini call that returns parsed plan JSON."""
    from google import genai
    from google.genai import types

    client = genai.Client(
        vertexai=settings.google_genai_use_vertexai,
        project=settings.gcp_project,
        location=settings.gcp_location,
    )

    response = await client.aio.models.generate_content(
        model=settings.gemini_model,
        contents=[
            {"role": "user", "parts": [{"text": f"{system_prompt}\n\n{user_prompt}"}]},
        ],
        config=types.GenerateContentConfig(temperature=0.2),
    )
    raw = (response.text or "{}").strip()

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
            "Repair the following model output into VALID JSON that strictly follows the required contract. "
            "Return JSON only, no markdown.\n\n"
            f"Original output:\n{raw}\n\n"
            f"Parse/validation error:\n{first_error}\n"
        )
        repair_response = await client.aio.models.generate_content(
            model=settings.gemini_model,
            contents=[
                {"role": "user", "parts": [{"text": f"{system_prompt}\n\n{repair_prompt}"}]},
            ],
            config=types.GenerateContentConfig(temperature=0.0),
        )
        repaired_raw = (repair_response.text or "{}").strip()
        repaired = _parse_json_payload(repaired_raw)
        if _is_contract_payload(repaired):
            schema_errors = _validate_contract_schema(repaired)
            if schema_errors:
                raise ValueError("Repaired contract invalid: " + "; ".join(schema_errors[:8]))
            return repaired
        if _is_legacy_steps_payload(repaired):
            return repaired
        raise ValueError("Repair output invalid for contract and legacy payload")


def _validate_steps(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Filter steps to only those with valid types and actions."""
    validated = []
    for step in steps:
        step_type = step.get("type", "")
        if step_type not in STEP_TYPES:
            continue
        if step_type == "browser":
            action = str(step.get("action", "")).strip()
            if action not in BROWSER_ACTIONS:
                continue
            if action == "act":
                if not str(step.get("ref", "")).strip():
                    continue
            elif action in {"click", "type", "hover", "select", "navigate"}:
                target = step.get("target")
                if target in (None, "", {}):
                    continue
                if action == "navigate" and not isinstance(target, str):
                    continue
        validated.append(step)
    return validated


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
        act_kind = action if action in {"click", "type", "hover", "select"} else "click"
        return {"action": "act", "ref": ref, "kind": act_kind, "value": value}, value
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


def _target_from_strategy_or_target(row: dict[str, Any], action: str) -> tuple[Any, Any, dict[str, Any] | None]:
    value: Any = row.get("value", "")
    strategy = row.get("target_strategy", {})
    target_obj = row.get("target", {})
    act_payload: dict[str, Any] | None = None
    target: Any = ""

    if isinstance(target_obj, dict):
        candidates = target_obj.get("candidates", [])
        if isinstance(candidates, list):
            for c in candidates:
                if not isinstance(c, dict):
                    continue
                mapped_target, mapped_value = _target_from_candidate(c, action)
                if mapped_value not in (None, ""):
                    value = mapped_value
                if isinstance(mapped_target, dict) and mapped_target.get("action") == "act":
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
            act_payload = {"action": "act", "ref": ref, "kind": act_kind, "value": value}
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
        action = str(row.get("action", "")).strip().lower()
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

        # Contract-native explicit act form: {"action":"act","kind":"click","ref":"e1",...}
        if action == "act" and explicit_ref and explicit_kind in {"click", "type", "hover", "select"}:
            step = {
                "type": "browser",
                "action": "act",
                "kind": explicit_kind,
                "ref": explicit_ref,
                "description": description,
            }
            if row.get("value", None) not in (None, ""):
                step["value"] = row.get("value")
            if snapshot_id:
                step["snapshot_id"] = snapshot_id
            out.append(step)
            continue

        # Graceful degradation: if model emits action=act without ref but with semantic target,
        # execute semantic action (kind) instead of dropping the step.
        if action == "act" and not explicit_ref:
            if explicit_kind in {"click", "type", "hover", "select"}:
                action = explicit_kind
            else:
                action = "click"

        if act_payload is not None:
            step = {
                "type": "browser",
                "action": "act",
                "kind": act_payload.get("kind", "click"),
                "ref": act_payload.get("ref", ""),
                "value": act_payload.get("value", value),
                "description": description,
            }
            if snapshot_id:
                step["snapshot_id"] = snapshot_id
            out.append(step)
            continue

        step: dict[str, Any] = {
            "type": "browser",
            "action": action,
            "target": target,
            "description": description,
        }
        if action == "keyboard":
            key = row.get("key", "")
            if key not in (None, "") and value in (None, ""):
                value = key
        if value not in (None, ""):
            step["value"] = value
        preconditions = _normalize_validation_rules(row.get("preconditions", []))
        if preconditions:
            step["preconditions"] = preconditions
        success_criteria = _normalize_validation_rules(row.get("success_criteria", []))
        if success_criteria:
            step["success_criteria"] = success_criteria
        if target_obj:
            step["disambiguation"] = _normalize_disambiguation(target_obj.get("disambiguation", {}))
        out.append(step)
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
    completed_steps: list[str] | None = None,
    failed_step: dict[str, Any] | None = None,
    error_message: str | None = None,
) -> dict[str, Any]:
    """Plan browser automation steps from a natural-language prompt.

    This is used by the Navigator tab where the user wants to control their
    attached browser tab. The prompt is interpreted in context of the website
    the user is currently viewing.
    """
    try:
        url_context = ""
        if current_url:
            domain = current_url.split("//")[-1].split("/")[0] if "//" in current_url else current_url
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

        prompt = (
            f"Today: {datetime.utcnow().strftime('%Y-%m-%d')}\n"
            f"{url_context}\n"
        )

        if page_snapshot:
            prompt += _format_snapshot_context(page_snapshot) + "\n\n"
        if structured_context:
            prompt += _format_structured_context(structured_context) + "\n\n"
        if completed_steps:
            prompt += _format_completed_context(completed_steps) + "\n\n"
        if failed_step or error_message:
            prompt += _format_failure_context(failed_step, error_message) + "\n\n"

        prompt += f"User's request: {user_prompt}\n"
        prompt += (
            "For any ref-based action, include snapshot_id matching SNAPSHOT_ID from context. "
            "Do not reuse stale refs across snapshot changes.\n"
        )

        plan = await _call_gemini(NAVIGATOR_SYSTEM_PROMPT, prompt)
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
        validated = apply_flow_guardrails(
            steps=validated,
            user_prompt=user_prompt,
            current_url=current_url,
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
        plan_strategy = _normalize_plan_strategy(str(((contract_payload or {}).get("plan", {}) or {}).get("strategy", "")))

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
        }
        logger.info(
            "Navigator planner produced %d browser steps for '%s'",
            len(validated), user_prompt,
        )
        return result

    except Exception as exc:
        logger.error("Navigator planner failed: %s", exc)
        return _navigator_fallback(user_prompt, current_url)


def _navigator_fallback(user_prompt: str, current_url: str = "") -> dict[str, Any]:
    """Safe-only fallback. Avoid ambiguous clicks/types when contract parsing fails."""
    steps: list[dict[str, Any]] = []
    consult_step = {
        "type": "consult",
        "reason": "planner_output_invalid",
        "description": "Could not produce a deterministic plan. Please refine the prompt or use Snapshot and retry.",
    }
    return {
        "steps": [consult_step],
        "requires_browser": True,
        "estimated_duration_seconds": 5,
        # Compatibility field for existing UI.
        "mode": "plan",
        "status": "NEEDS_INPUT",
        "summary": "Planner fallback requested user clarification to avoid nondeterministic actions.",
        "assumptions": [],
        "needs_confirmation": False,
        "risks": [],
        "next_action": "await_user_input",
        "plan_strategy": "REPAIR_SUBPLAN",
    }
