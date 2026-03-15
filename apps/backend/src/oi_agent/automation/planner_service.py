from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime
from typing import Any

from oi_agent.automation.conversation_task_shape import infer_task_shape
from oi_agent.automation.models import (
    AgentBrowserStep,
    AutomationPlan,
    AutomationStep,
    AutomationTarget,
    ExecutionStep,
    BlockingEvidence,
    CompletionEvidence,
    ConfirmationPolicy,
    ExecutionBrief,
    ExecutionContract,
    IntentDraft,
    PredictedExecutionPlan,
    PredictedPhase,
    ResolveExecutionRequest,
    TaskShapeEvidence,
    TransferEvidence,
    VerificationRule,
    VerificationEvidence,
    VisibleStateEvidence,
)
from oi_agent.automation.store import save_plan
from oi_agent.config import settings


def _step(
    step_id: str,
    command: str,
    label: str,
    description: str,
    *,
    phase_index: int | None = None,
    page_hint: str | None = None,
    page_ref: str | None = None,
    output_key: str | None = None,
    consumes_keys: list[str] | None = None,
) -> AutomationStep:
    return AutomationStep(
        step_id=step_id,
        phase_index=phase_index,
        command_payload=AgentBrowserStep(
            id=step_id,
            command=command,
            description=description,
            page_ref=page_ref,
            output_key=output_key,
            consumes_keys=list(consumes_keys or []),
        ),
        label=label,
        description=description,
        page_hint=page_hint,
        page_ref=page_ref,
        output_key=output_key,
        consumes_keys=list(consumes_keys or []),
        status="pending",
    )

def _infer_step_kind(text: str, *, index: int = 0) -> str:
    lowered = (text or "").strip().lower()
    if any(token in lowered for token in ("type", "enter", "fill", "paste", "send", "reply", "message")):
        return "type"
    if any(token in lowered for token in ("copy", "extract", "find", "read", "collect", "capture")):
        return "extract"
    if any(token in lowered for token in ("open ", "go to ", "navigate", "visit ", "launch ")):
        return "navigate"
    if any(token in lowered for token in ("click", "tap", "press", "submit", "play", "select")):
        return "click"
    if any(token in lowered for token in ("scroll", "move down", "move up")):
        return "scroll"
    if any(token in lowered for token in ("wait", "confirm", "verify", "ensure", "check")):
        return "wait"
    return "navigate" if index == 0 else "click"


def _normalize_outline_step(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", (text or "").strip()).strip(" .")
    return cleaned or "Continue the workflow"


def _step_page_hint(text: str, entities: dict[str, Any], *, fallback: str | None = None) -> str | None:
    lowered = (text or "").lower()
    for key in ("target_app", "source_app", "app"):
        value = str(entities.get(key, "") or "").strip()
        if value and value.lower() in lowered:
            return value
    for app in ("YouTube", "WhatsApp", "Gmail", "LinkedIn", "Notion", "Slack", "Discord", "Telegram"):
        if app.lower() in lowered:
            return app
    return fallback


def _page_ref_for_hint(page_hint: str | None) -> str | None:
    value = re.sub(r"[^a-z0-9]+", "_", str(page_hint or "").strip().lower()).strip("_")
    return f"page_{value}" if value else None


def _output_key_for_step(text: str, kind: str, *, index: int) -> str | None:
    lowered = (text or "").lower()
    if kind != "extract":
        return None
    if "comment" in lowered:
        return "comment_text"
    if "message" in lowered:
        return "message_text"
    if "link" in lowered or "url" in lowered:
        return "link_url"
    return f"extracted_value_{index + 1}"


def _consumed_keys_for_step(
    text: str,
    kind: str,
    available_keys: list[str],
) -> list[str]:
    lowered = (text or "").lower()
    if kind not in {"type", "click"} or not available_keys:
        return []
    matched = [key for key in available_keys if key.replace("_", " ") in lowered or key in lowered]
    if matched:
        return matched
    if any(token in lowered for token in ("send", "paste", "type", "enter", "reply")):
        return [available_keys[-1]]
    return []


def _seed_steps_from_outline(
    outline: list[str],
    summary: str,
    entities: dict[str, Any] | None = None,
) -> list[AutomationStep]:
    normalized = [_normalize_outline_step(item) for item in outline if _normalize_outline_step(item)]
    if not normalized:
        normalized = [
            "Open the target application or page",
            "Locate the relevant UI area",
            "Perform the requested action",
            "Verify the outcome",
        ]
    entity_map = dict(entities or {})

    steps: list[AutomationStep] = []
    available_keys: list[str] = []
    last_page_hint = _step_page_hint(summary, entity_map)
    for idx, item in enumerate(normalized, start=1):
        command = _infer_step_kind(item, index=idx - 1)
        label = item[:1].upper() + item[1:]
        page_hint = _step_page_hint(item, entity_map, fallback=last_page_hint)
        page_ref = _page_ref_for_hint(page_hint)
        output_key = _output_key_for_step(item, command, index=idx - 1)
        consumes_keys = _consumed_keys_for_step(item, command, available_keys)
        steps.append(
            _step(
                f"s{idx}",
                command,
                label,
                item,
                phase_index=idx - 1,
                page_hint=page_hint,
                page_ref=page_ref,
                output_key=output_key,
                consumes_keys=consumes_keys,
            )
        )
        if page_hint:
            last_page_hint = page_hint
        if output_key:
            available_keys.append(output_key)

    if not any(step.normalized_command_payload().command == "wait" for step in steps):
        steps.append(
            _step(
                f"s{len(steps) + 1}",
                "wait",
                "Verify the outcome",
                f"Verify that the workflow goal completed successfully: {summary}",
                phase_index=max(0, len(normalized) - 1),
                page_hint=last_page_hint,
                page_ref=_page_ref_for_hint(last_page_hint),
                consumes_keys=available_keys[-1:] if available_keys else [],
            )
        )
    return steps


def _should_seed_browser_outline_steps() -> bool:
    return not bool(settings.automation_browser_single_step_planning)


_TASK_SHAPE_APP_LABELS = {
    "calendar": "Google Calendar",
    "docs": "Google Docs",
    "github": "GitHub",
    "gmail": "Gmail",
    "notion": "Notion",
    "slack": "Slack",
    "telegram": "Telegram",
    "whatsapp": "WhatsApp",
}


def _looks_like_generic_app_placeholder(value: str) -> bool:
    lowered = str(value or "").strip().lower()
    if not lowered:
        return True
    generic_terms = (
        "app",
        "application",
        "workspace",
        "site",
        "service",
        "platform",
        "target",
    )
    return any(term in lowered for term in generic_terms)


def _display_label_for_task_shape_app(app_id: str) -> str:
    normalized = str(app_id or "").strip().lower()
    if not normalized:
        return ""
    return _TASK_SHAPE_APP_LABELS.get(normalized, normalized.replace("_", " ").title())


def _resolve_app_name(intent: IntentDraft) -> str | None:
    generic_candidate: str | None = None
    for key in ("target_app", "app", "source_app"):
        value = str(intent.entities.get(key, "") or "").strip()
        if value:
            if _looks_like_generic_app_placeholder(value):
                generic_candidate = generic_candidate or value
                continue
            return value
    inferred_apps = sorted(infer_task_shape(intent.user_goal).apps)
    if inferred_apps:
        return _display_label_for_task_shape_app(inferred_apps[0])
    return generic_candidate


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _entity_signal_candidates(entities: dict[str, Any]) -> list[str]:
    ordered_keys = ("target", "body", "message_text", "recipient", "contact", "subject")
    candidates: list[str] = []
    for key in ordered_keys:
        value = str(entities.get(key, "") or "").strip()
        if value and value not in candidates:
            candidates.append(value)
    return candidates


def _label_signal_candidates(label: str) -> list[str]:
    candidates: list[str] = []
    raw_label = str(label or "")
    for match in re.finditer(r'(["\'])(.*?)\1', str(label or "")):
        value = match.group(2)
        cleaned = str(value or "").strip()
        if cleaned and cleaned not in candidates:
            candidates.append(cleaned)
    colon_match = re.search(r":\s*([^:]{1,80})$", raw_label)
    if colon_match:
        cleaned = str(colon_match.group(1) or "").strip().strip("\"'")
        if cleaned and cleaned not in candidates:
            candidates.append(cleaned)
    trailing_value_match = re.search(
        r"\b(?:to|as)\s+([^,]{1,160}(?:@[^,\s]+|\b))\s*$",
        raw_label,
        flags=re.IGNORECASE,
    )
    if trailing_value_match:
        cleaned = str(trailing_value_match.group(1) or "").strip().strip("\"'")
        if cleaned and cleaned not in candidates:
            candidates.append(cleaned)
    return candidates


def _search_signal_candidates(label: str, entities: dict[str, Any]) -> list[str]:
    candidates: list[str] = []
    label_candidates = _label_signal_candidates(label)
    target = str(entities.get("target", "") or "").strip()
    body = str(entities.get("body", "") or "").strip()
    for candidate in (*label_candidates, target, body):
        cleaned = str(candidate or "").strip()
        if cleaned and cleaned not in candidates:
            candidates.append(cleaned)
    return candidates


def _completion_signals_for_phase(label: str, entities: dict[str, Any], app_name: str | None) -> list[str]:
    lowered = label.lower()
    signals: list[str] = []
    recipient = str(entities.get("recipient", "") or entities.get("contact", "") or "").strip()
    subject_text = str(entities.get("subject", "") or "").strip()
    message_text = str(entities.get("message_text", "") or entities.get("body", "") or "").strip()
    entity_candidates = _entity_signal_candidates(entities)
    target = entity_candidates[0] if entity_candidates else ""
    body = entity_candidates[1] if len(entity_candidates) > 1 else ""
    label_candidates = _label_signal_candidates(label)
    if app_name and any(token in lowered for token in ("open", "launch", "go to", "navigate", "app", "website")):
        signals.append(app_name)
    search_intent = (
        any(token in lowered for token in ("search for", "find ", "locate ", "browse "))
        and "search results" not in lowered
    )
    if search_intent:
        search_candidates = _search_signal_candidates(label, entities)
        for candidate in (*search_candidates, app_name or ""):
            candidate = str(candidate or "").strip()
            if candidate and candidate not in signals:
                signals.append(candidate)
    if "filter" in lowered:
        filter_candidates = list(label_candidates)
        for candidate in ((body,) if label_candidates else (body, target)):
            cleaned = str(candidate or "").strip()
            if cleaned and cleaned not in filter_candidates:
                filter_candidates.append(cleaned)
        for candidate in filter_candidates:
            candidate = str(candidate or "").strip()
            if candidate and candidate not in signals:
                signals.append(candidate)
    if any(token in lowered for token in ("select", "choose", "pick")):
        select_candidates = list(label_candidates)
        if not select_candidates and not any(token in lowered for token in ("result", "results", "product", "item", "option", "listing")):
            select_candidates = [candidate for candidate in (target, body) if candidate]
        for candidate in select_candidates:
            candidate = str(candidate or "").strip()
            if candidate and candidate not in signals:
                signals.append(candidate)
    if recipient and any(token in lowered for token in ("locate", "find", "search", "select", "recipient", "candidate", "chat")):
        signals.append(recipient)
    if subject_text and "subject" in lowered:
        signals.append(subject_text)
    if message_text and any(token in lowered for token in ("compose", "draft", "type", "fill", "message", "reply", "email")):
        signals.append(message_text)
    if message_text and "body" in lowered:
        signals.append(message_text)
    if recipient and any(token in lowered for token in ("verify", "confirm", "ensure", "send")):
        signals.append(recipient)
    return signals


def _default_phase_labels(summary: str, *, entities: dict[str, Any] | None = None, app_name: str | None = None) -> list[str]:
    lowered = summary.lower()
    entity_map = dict(entities or {})
    resolved_app = str(app_name or entity_map.get("app", "") or "").strip()
    recipient = str(entity_map.get("recipient", "") or entity_map.get("contact", "") or "").strip()
    subject_text = str(entity_map.get("subject", "") or "").strip()
    message_text = str(entity_map.get("message_text", "") or entity_map.get("body", "") or "").strip()

    if any(token in lowered for token in ("email", "gmail", "mail", "reply", "compose")):
        phases: list[str] = [f"Go to {resolved_app}" if resolved_app else "Go to the target workspace"]
        phases.append("Compose a new email")
        if recipient:
            phases.append(f"Set recipient to {recipient}")
        if subject_text:
            phases.append(f"Set subject to {subject_text}")
        if message_text:
            phases.append(f"Set body to {message_text}")
        phases.append("Send the email")
        return phases

    open_phase = f"Go to {resolved_app}" if resolved_app else "Open the target workspace"
    return [
        open_phase,
        "Find the right destination",
        "Perform the requested action",
        "Verify the result",
    ]


def _canonicalize_workflow_outline(
    workflow_outline: list[str],
    *,
    summary: str,
    entities: dict[str, Any],
    app_name: str | None,
) -> list[str]:
    labels = [item.strip() for item in workflow_outline if isinstance(item, str) and item.strip()]
    if not labels:
        return []

    lowered_summary = str(summary or "").strip().lower()
    resolved_app = str(app_name or entities.get("app", "") or "").strip()
    recipient = str(entities.get("recipient", "") or entities.get("contact", "") or "").strip()
    subject_text = str(entities.get("subject", "") or "").strip()
    message_text = str(entities.get("message_text", "") or entities.get("body", "") or "").strip()

    is_email_task = any(token in lowered_summary for token in ("email", "gmail", "mail", "reply", "compose"))
    if not is_email_task:
        return labels

    normalized: list[str] = []
    for label in labels:
        lowered = label.lower()
        if any(token in lowered for token in ("email application", "mail workspace", "email workspace")) and resolved_app:
            normalized.append(f"Go to {resolved_app}")
            continue
        if "correct recipient" in lowered and recipient:
            normalized.append(f"Set recipient to {recipient}")
            continue
        if "requested email" in lowered or "draft the email" in lowered:
            if subject_text:
                normalized.append(f"Set subject to {subject_text}")
            if message_text:
                normalized.append(f"Set body to {message_text}")
            else:
                normalized.append("Compose a new email")
            continue
        if any(token in lowered for token in ("verify the send details", "verify send details", "send details")):
            normalized.append("Send the email")
            continue
        normalized.append(label)

    deduped: list[str] = []
    for label in normalized:
        if label not in deduped:
            deduped.append(label)
    return deduped


def _normalize_filter_pair(value: str) -> tuple[str, str] | None:
    parts = [part.strip() for part in re.split(r"[:=]", str(value or ""), maxsplit=1) if part.strip()]
    if len(parts) == 2:
        return parts[0].lower(), parts[1]
    return None


def _domain_like_value(value: str) -> str | None:
    match = re.search(r"([a-z0-9.-]+\.[a-z]{2,})", str(value or "").strip(), flags=re.IGNORECASE)
    if not match:
        return None
    return str(match.group(1) or "").strip().lower() or None


def _navigate_identity_terms(signals: list[str], label: str) -> list[str]:
    terms: list[str] = []
    for candidate in [*signals, label]:
        normalized = " ".join(str(candidate or "").strip().lower().split())
        if not normalized:
            continue
        domain_value = _domain_like_value(normalized)
        if domain_value:
            continue
        normalized = re.sub(r"\b(go to|open|navigate|launch|the|a|an)\b", " ", normalized, flags=re.IGNORECASE)
        normalized = " ".join(normalized.split())
        if not normalized or len(normalized) < 3:
            continue
        if normalized not in terms:
            terms.append(normalized)
    return terms[:3]


def _infer_execution_step_kind(label: str) -> str:
    lowered = str(label or "").strip().lower()
    selection_surface_terms = (
        "result",
        "results",
        "article",
        "item",
        "listing",
        "product",
        "entry",
        "record",
        "page",
    )
    selection_verbs = ("open", "click", "select", "choose", "pick")
    if any(term in lowered for term in selection_surface_terms) and any(verb in lowered for verb in selection_verbs):
        return "select_result"
    if any(token in lowered for token in ("open", "go to", "navigate", "launch")):
        return "navigate"
    if any(token in lowered for token in ("search", "find", "locate", "browse")):
        return "search"
    if any(token in lowered for token in ("compose", "draft")):
        return "advance"
    if any(token in lowered for token in ("select", "choose", "pick")):
        return "select_result"
    if "filter" in lowered:
        return "filter"
    if any(token in lowered for token in ("fill", "type", "enter", "set", "update", "provide", "input")):
        return "fill_field"
    if "add to cart" in lowered:
        return "advance"
    if any(token in lowered for token in ("checkout", "continue", "proceed", "submit", "confirm", "place order", "send", "save")):
        return "advance"
    if any(token in lowered for token in ("verify", "check", "ensure")):
        return "verify"
    return "unknown"


def _verification_rules_for_phase(label: str, signals: list[str], *, kind: str | None = None) -> list[VerificationRule]:
    lowered = str(label or "").strip().lower()
    normalized_kind = str(kind or "").strip().lower()
    rules: list[VerificationRule] = []
    if normalized_kind == "navigate" or any(token in lowered for token in ("open", "go to", "navigate", "launch")):
        navigate_candidates = [*signals, label]
        domain_signal = next(
            (_domain_like_value(signal) for signal in navigate_candidates if _domain_like_value(signal)),
            None,
        )
        if domain_signal:
            rules.append(VerificationRule(kind="url_contains", value=domain_signal))
        rules.append(VerificationRule(kind="surface_kind", expected_surface="listing"))
    if normalized_kind == "search" or (normalized_kind not in {"select_result", "navigate"} and any(token in lowered for token in ("search", "find", "locate", "browse"))):
        for signal in signals:
            normalized = str(signal or "").strip()
            if normalized:
                rules.append(VerificationRule(kind="search_query", value=normalized))
                break
        rules.append(VerificationRule(kind="result_count_changed"))
    if normalized_kind == "filter" or "filter" in lowered:
        filter_key = None
        for candidate_key in ("color", "size", "price", "brand"):
            if candidate_key in lowered:
                filter_key = candidate_key
                break
        for signal in signals:
            pair = _normalize_filter_pair(signal)
            if pair is not None:
                key, value = pair
                rules.append(VerificationRule(kind="selected_filter", key=key, value=value))
        if filter_key:
            for value in _label_signal_candidates(label):
                rules.append(VerificationRule(kind="selected_filter", key=filter_key, value=value))
        if not rules:
            rules.append(VerificationRule(kind="result_count_changed"))
    if normalized_kind == "select_result" or any(token in lowered for token in ("select", "choose", "pick")):
        rules.append(VerificationRule(kind="surface_kind", expected_surface="detail"))
    if "add to cart" in lowered:
        rules.append(VerificationRule(kind="surface_kind", expected_surface="cart"))
    if any(token in lowered for token in ("checkout", "continue", "proceed", "shipping", "payment")):
        rules.append(VerificationRule(kind="surface_kind", expected_surface="checkout"))
    if any(token in lowered for token in ("place order", "confirm order", "submit order")):
        rules.append(VerificationRule(kind="surface_kind", expected_surface="confirmation"))
    if any(token in lowered for token in ("verify", "check", "ensure")) and not rules:
        rules.append(VerificationRule(kind="surface_kind", expected_surface="confirmation"))
    return rules


def _ordinal_index_from_label(label: str) -> int | None:
    lowered = str(label or "").strip().lower()
    ordinal_map = {
        "first": 0,
        "1st": 0,
        "second": 1,
        "2nd": 1,
        "third": 2,
        "3rd": 2,
        "fourth": 3,
        "4th": 3,
        "fifth": 4,
        "5th": 4,
    }
    for token, index in ordinal_map.items():
        if token in lowered:
            return index
    return None


def _target_constraints_for_phase(
    *,
    label: str,
    kind: str,
    signals: list[str],
) -> dict[str, Any]:
    constraints: dict[str, Any] = {}
    if kind == "select_result":
        result_index = _ordinal_index_from_label(label)
        if result_index is not None:
            constraints["result_index"] = result_index
        signal_terms = [str(signal or "").strip() for signal in signals if str(signal or "").strip()]
        if signal_terms:
            constraints["match_terms"] = signal_terms[:3]
    elif kind == "filter":
        filter_pairs: dict[str, str] = {}
        for signal in signals:
            pair = _normalize_filter_pair(signal)
            if pair is None:
                continue
            key, value = pair
            filter_pairs[key] = value
        if not filter_pairs:
            filter_key = None
            for candidate_key in ("color", "size", "price", "brand"):
                if candidate_key in str(label or "").strip().lower():
                    filter_key = candidate_key
                    break
            if filter_key:
                for value in _label_signal_candidates(label):
                    normalized_value = str(value or "").strip()
                    if normalized_value:
                        filter_pairs[filter_key] = normalized_value
                        break
        if filter_pairs:
            constraints["filters"] = filter_pairs
    elif kind == "search":
        for signal in signals:
            normalized = str(signal or "").strip()
            if normalized:
                constraints["query"] = normalized
                break
    elif kind == "fill_field":
        value_candidates = _label_signal_candidates(label)
        if value_candidates:
            constraints["value"] = value_candidates[0]
        field_hint = str(label or "").strip()
        if value_candidates:
            field_hint = field_hint.split(value_candidates[0], 1)[0]
        field_hint = re.sub(r'["\':]+', " ", field_hint)
        field_hint = re.sub(
            r"\b(fill|type|enter|set|update|provide|input|the|a|an)\b",
            " ",
            field_hint,
            flags=re.IGNORECASE,
        )
        field_hint = " ".join(part for part in field_hint.strip().split() if part)
        if field_hint:
            constraints["field_hint"] = field_hint
    elif kind == "navigate":
        navigate_candidates = [*signals, label]
        domain_signal = next(
            (_domain_like_value(signal) for signal in navigate_candidates if _domain_like_value(signal)),
            None,
        )
        if domain_signal:
            constraints["target_host"] = domain_signal
        identity_terms = _navigate_identity_terms(signals, label)
        if identity_terms:
            constraints["target_identity_terms"] = identity_terms
    return constraints


def _allowed_actions_for_step_kind(kind: str) -> list[str]:
    if kind == "navigate":
        return ["navigate", "snapshot"]
    if kind == "search":
        return ["snapshot", "click", "type", "press"]
    if kind == "filter":
        return ["snapshot", "click", "select"]
    if kind == "select_result":
        return ["snapshot", "click"]
    if kind == "fill_field":
        return ["snapshot", "click", "type", "select", "press"]
    if kind == "advance":
        return ["snapshot", "click", "select", "press"]
    if kind == "verify":
        return ["snapshot", "wait"]
    return ["snapshot", "click", "type", "select", "press"]


def build_execution_steps_from_predicted_plan(predicted_plan: PredictedExecutionPlan) -> list[ExecutionStep]:
    execution_steps: list[ExecutionStep] = []
    for index, phase in enumerate(predicted_plan.phases):
        kind = _infer_execution_step_kind(phase.label)
        signals = list(phase.completion_signals)
        execution_steps.append(
            ExecutionStep(
                step_id=phase.phase_id,
                kind=kind,  # type: ignore[arg-type]
                label=phase.label,
                allowed_actions=_allowed_actions_for_step_kind(kind),
                target_constraints=_target_constraints_for_phase(
                    label=phase.label,
                    kind=kind,
                    signals=signals,
                ),
                verification_rules=_verification_rules_for_phase(
                    phase.label,
                    signals,
                    kind=kind,
                ),
                phase_index=index,
            )
        )
    return execution_steps


def build_predicted_execution_plan(
    *,
    summary: str,
    workflow_outline: list[str],
    entities: dict[str, Any],
    app_name: str | None,
) -> PredictedExecutionPlan:
    labels = _canonicalize_workflow_outline(
        workflow_outline,
        summary=summary,
        entities=entities,
        app_name=app_name,
    )
    if not labels:
        labels = _default_phase_labels(summary, entities=entities, app_name=app_name)
    phases = [
        PredictedPhase(
            phase_id=f"phase_{index + 1}",
            label=label,
            goal=label,
            completion_signals=_completion_signals_for_phase(label, entities, app_name),
            advisory=True,
        )
        for index, label in enumerate(labels)
    ]
    return PredictedExecutionPlan(
        summary=summary,
        phases=phases,
        advisory=True,
        generated_at=_now_iso(),
    )


def build_execution_contract(
    *,
    resolved_goal: str,
    app_name: str | None,
    entities: dict[str, Any],
    predicted_plan: PredictedExecutionPlan,
    requires_confirmation: bool,
) -> ExecutionContract:
    task_shape = infer_task_shape(resolved_goal)
    normalized_goal = resolved_goal.lower()
    operation_chain = {str(item).strip().lower() for item in task_shape.operation_chain}
    submission_like = bool(
        operation_chain.intersection({"send", "submit", "post", "publish", "confirm"})
        or any(token in normalized_goal for token in ("send", "submit", "post", "publish", "confirm"))
    )
    recipient = str(entities.get("recipient", "") or entities.get("contact", "") or "").strip()
    subject_text = str(entities.get("subject", "") or "").strip()
    message_text = str(entities.get("message_text", "") or entities.get("body", "") or "").strip()
    completion_criteria = [f"The requested outcome is completed for: {resolved_goal}"]
    if recipient:
        completion_criteria.append(f"The active destination matches {recipient}.")
    if message_text:
        criteria_prefix = "The submitted content matches" if submission_like else "The drafted content matches"
        completion_criteria.append(f"{criteria_prefix}: {message_text}")
    if submission_like:
        completion_criteria.append("A visible post-action state change confirms the action completed.")
        completion_criteria.append("The UI is no longer showing the unsent draft, editor, or compose surface.")
    guardrails = [
        "Treat the user's request as the primary objective and rely on the live browser state to choose the next step.",
        "Stay within the target app or site unless authentication or the task clearly requires navigation.",
        "If the user gave constraints but not an exact on-page choice, pick a suitable option that satisfies those constraints instead of asking for a preselected item.",
        "Ask for clarification only when missing information genuinely blocks the next safe browser action.",
        "Prefer deterministic ref-based interaction when a snapshot is available.",
        "Re-evaluate the next step from the live browser state after each observation.",
    ]
    if requires_confirmation:
        guardrails.append("Do not execute irreversible or sensitive actions without conversation-core approval.")
    return ExecutionContract(
        contract_id=str(uuid.uuid4()),
        resolved_goal=resolved_goal,
        target_app=app_name,
        target_entities={
            key: value
            for key, value in dict(entities).items()
            if value not in (None, "", [], {})
        },
        task_shape=TaskShapeEvidence(
            apps=sorted(task_shape.apps),
            operation_chain=list(task_shape.operation_chain),
            requires_live_ui=task_shape.requires_live_ui,
            cross_app_transfer=task_shape.cross_app_transfer,
            visible_state_dependence=task_shape.visible_state_dependence,
            execution_surface=task_shape.execution_surface,  # type: ignore[arg-type]
            timing_intent=task_shape.timing_intent,  # type: ignore[arg-type]
        ),
        completion_evidence=CompletionEvidence(
            summary=f"Complete the requested outcome for: {resolved_goal}",
            criteria=completion_criteria,
        ),
        blocking_evidence=BlockingEvidence(
            reason="Sensitive action confirmation required." if requires_confirmation else "",
            requires_confirmation=requires_confirmation,
            requires_user_reply=requires_confirmation,
        ),
        visible_state_evidence=VisibleStateEvidence(
            signals=[
                signal
                for phase in predicted_plan.phases
                for signal in phase.completion_signals
            ],
            depends_on_foreground_surface=task_shape.visible_state_dependence,
        ),
        transfer_evidence=TransferEvidence(
            source_apps=sorted(task_shape.source_apps),
            destination_apps=sorted(task_shape.destination_apps),
            cross_app_transfer=task_shape.cross_app_transfer,
        ),
        verification_evidence=VerificationEvidence(
            checks=[
                signal
                for phase in predicted_plan.phases
                for signal in phase.completion_signals
            ]
            + (
                [
                    "Visible post-action confirmation is present.",
                    "The editor or compose surface is no longer active.",
                ]
                if submission_like
                else []
            ),
            expected_state_change=(
                "A visible post-action confirmation replaces the active draft/editor state."
                if submission_like
                else resolved_goal
            ),
        ),
        completion_criteria=completion_criteria,
        guardrails=guardrails,
        confirmation_policy=ConfirmationPolicy(
            required=requires_confirmation,
            reason="Sensitive or irreversible actions are conversation-core gated." if requires_confirmation else None,
        ),
        predicted_plan=predicted_plan,
    )


def build_compat_execution_brief(contract: ExecutionContract) -> ExecutionBrief:
    phase_labels = [phase.label for phase in contract.predicted_plan.phases] if contract.predicted_plan else _default_phase_labels(contract.resolved_goal)
    phase_completion_checks = [
        list(phase.completion_signals)
        for phase in (contract.predicted_plan.phases if contract.predicted_plan else [])
    ] or [[] for _ in phase_labels]
    return ExecutionBrief(
        goal=contract.resolved_goal,
        app_name=contract.target_app,
        target_entities=dict(contract.target_entities),
        workflow_phases=phase_labels,
        phase_completion_checks=phase_completion_checks,
        success_criteria=list(contract.completion_criteria),
        guardrails=list(contract.guardrails),
        disambiguation_hints=[],
        completion_evidence=[
            signal
            for phase in (contract.predicted_plan.phases if contract.predicted_plan else [])
            for signal in phase.completion_signals
        ],
    )


async def build_plan(intent: IntentDraft, request: ResolveExecutionRequest, user_id: str = "dev-user") -> AutomationPlan:
    plan_id = str(uuid.uuid4())
    source_prompt = next(
        (
            str(item.text or "").strip()
            for item in intent.normalized_inputs
            if item.type == "text" and str(item.text or "").strip()
        ),
        intent.user_goal,
    )
    normalized_entities = dict(intent.entities)
    app_name = _resolve_app_name(intent)
    predicted_plan = build_predicted_execution_plan(
        summary=intent.user_goal,
        workflow_outline=list(intent.workflow_outline),
        entities=normalized_entities,
        app_name=app_name,
    )
    execution_contract = build_execution_contract(
        resolved_goal=intent.user_goal,
        app_name=app_name,
        entities=normalized_entities,
        predicted_plan=predicted_plan,
        requires_confirmation=intent.requires_confirmation,
    )
    target = AutomationTarget(
        target_type="browser_session",
        device_id=None,
        tab_id=None,
        app_name=app_name,
    )
    steps = (
        _seed_steps_from_outline(intent.workflow_outline, intent.user_goal, intent.entities)
        if _should_seed_browser_outline_steps()
        else []
    )
    plan = AutomationPlan(
        plan_id=plan_id,
        intent_id=intent.intent_id,
        execution_mode=request.execution_mode,
        summary=intent.user_goal,
        source_prompt=source_prompt,
        model_id=intent.model_id,
        execution_contract=execution_contract,
        predicted_plan=predicted_plan,
        execution_brief=None,
        targets=[target],
        steps=steps,
        requires_confirmation=intent.requires_confirmation,
    )
    raw_plan = plan.model_dump(mode="json")
    raw_plan["user_id"] = user_id
    await save_plan(plan_id, raw_plan)
    return plan


async def build_plan_from_prompt(
    *,
    user_id: str = "dev-user",
    prompt: str,
    execution_mode: str,
    device_id: str | None = None,
    tab_id: int | None = None,
    app_name: str | None = None,
    intent_id: str = "",
) -> AutomationPlan:
    plan_id = str(uuid.uuid4())
    predicted_plan = build_predicted_execution_plan(
        summary=prompt,
        workflow_outline=[],
        entities={"app": app_name or ""},
        app_name=app_name,
    )
    execution_contract = build_execution_contract(
        resolved_goal=prompt,
        app_name=app_name,
        entities={"app": app_name or ""} if app_name else {},
        predicted_plan=predicted_plan,
        requires_confirmation=False,
    )
    target = AutomationTarget(
        target_type="browser_session",
        device_id=device_id,
        tab_id=tab_id,
        app_name=app_name,
    )
    steps = _seed_steps_from_outline([], prompt, {"app": app_name or ""}) if _should_seed_browser_outline_steps() else []
    plan = AutomationPlan(
        plan_id=plan_id,
        intent_id=intent_id,
        execution_mode=execution_mode,  # type: ignore[arg-type]
        summary=prompt,
        source_prompt=prompt,
        model_id=None,
        execution_contract=execution_contract,
        predicted_plan=predicted_plan,
        execution_brief=None,
        targets=[target],
        steps=steps,
        requires_confirmation=False,
    )
    raw_plan = plan.model_dump(mode="json")
    raw_plan["user_id"] = user_id
    await save_plan(plan_id, raw_plan)
    return plan
