from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse

from oi_agent.automation.models import ExecutionStep, UISurfaceState, VerificationRule


def _result_ref_set(surface: UISurfaceState | None) -> set[str]:
    if surface is None:
        return set()
    return {item.ref for item in surface.result_items}


def _normalize_text(value: str | None) -> str:
    return " ".join(str(value or "").strip().casefold().split())


def _digit_tokens(value: str | None) -> tuple[str, ...]:
    return tuple(re.findall(r"\d+", str(value or "")))


def _matches_search_query(expected: str, actual: str) -> bool:
    normalized_expected = _normalize_text(expected)
    normalized_actual = _normalize_text(actual)
    if not normalized_expected or not normalized_actual:
        return False
    if normalized_expected == normalized_actual:
        return True
    return normalized_actual in normalized_expected or normalized_expected in normalized_actual


def _matches_filter_value(key: str, expected: str, actual: str) -> bool:
    normalized_expected = _normalize_text(expected)
    normalized_actual = _normalize_text(actual)
    if not normalized_expected or not normalized_actual:
        return False
    if normalized_expected == normalized_actual:
        return True
    if key == "price":
        expected_digits = _digit_tokens(expected)
        actual_digits = _digit_tokens(actual)
        if expected_digits and actual_digits:
            if expected_digits == actual_digits:
                return True
            if len(expected_digits) == 1 and len(actual_digits) == 2 and actual_digits[-1] == expected_digits[0]:
                return True
    return normalized_expected in normalized_actual or normalized_actual in normalized_expected


def _rule_matches(
    *,
    rule: VerificationRule,
    before: UISurfaceState | None,
    after: UISurfaceState | None,
) -> bool:
    if after is None:
        return False
    if rule.kind == "surface_kind":
        return bool(rule.expected_surface) and after.kind == rule.expected_surface
    if rule.kind == "search_query":
        return _matches_search_query(str(rule.value or ""), str(after.search_query or ""))
    if rule.kind == "selected_filter":
        key = str(rule.key or "").strip().casefold()
        expected = str(rule.value or "")
        if not key or not expected:
            return False
        return _matches_filter_value(key, expected, str((after.selected_filters or {}).get(key, "") or ""))
    if rule.kind == "result_count_changed":
        return len(_result_ref_set(after)) != len(_result_ref_set(before))
    if rule.kind == "ref_absent":
        ref = str(rule.value or "").strip().lstrip("@")
        if not ref:
            return False
        current_refs = {item.ref.lstrip("@") for item in after.actionable_refs}
        return ref not in current_refs
    if rule.kind == "ref_present":
        ref = str(rule.value or "").strip().lstrip("@")
        if not ref:
            return False
        current_refs = {item.ref.lstrip("@") for item in after.actionable_refs}
        return ref in current_refs
    if rule.kind == "url_contains":
        expected = str(rule.value or "").strip().casefold()
        return bool(expected) and expected in str(after.url or "").casefold()
    return False


def _host_matches_target(target_host: str, actual_url: str | None) -> bool:
    normalized_target = _normalize_text(target_host)
    if not normalized_target:
        return False
    host = urlparse(str(actual_url or "").strip()).hostname or ""
    normalized_host = _normalize_text(host)
    if not normalized_host:
        return False
    return normalized_host == normalized_target or normalized_host.endswith(f".{normalized_target}")


def _identity_term_matches_page(identity_terms: list[str], after: UISurfaceState | None) -> bool:
    if after is None:
        return False
    haystack = " ".join(
        part for part in (str(after.url or ""), str(after.title or "")) if str(part or "").strip()
    )
    normalized_haystack = _normalize_text(haystack)
    if not normalized_haystack:
        return False
    for term in identity_terms:
        normalized_term = _normalize_text(term)
        if normalized_term and normalized_term in normalized_haystack:
            return True
    return False


def verify_execution_step(
    *,
    step: ExecutionStep,
    before: UISurfaceState | None,
    after: UISurfaceState | None,
) -> tuple[bool, str | None]:
    rules = list(step.verification_rules or [])
    target_host = str((step.target_constraints or {}).get("target_host", "") or "").strip()
    identity_terms = [
        str(item or "").strip()
        for item in list((step.target_constraints or {}).get("target_identity_terms", []) or [])
        if str(item or "").strip()
    ]
    if step.kind == "search" and after is not None:
        expected_query = ""
        for rule in rules:
            if rule.kind == "search_query":
                expected_query = str(rule.value or "").strip()
                break
        if expected_query and _matches_search_query(expected_query, str(after.search_query or "")):
            if after.result_items or after.kind == "listing":
                return True, f"search query is {expected_query}; results changed"
    if step.kind == "navigate" and after is not None:
        if after.kind == "blocker":
            return False, None
        if target_host and not _host_matches_target(target_host, after.url):
            return False, None
        if identity_terms and not _identity_term_matches_page(identity_terms, after):
            return False, None
        if (
            (target_host or identity_terms)
            and (
                after.kind != "unknown"
                or bool(after.search_query)
                or bool(after.result_items)
                or bool(after.actionable_refs)
            )
        ):
            destination = target_host or identity_terms[0]
            return True, f"navigated to {destination}"
    if step.kind == "select_result" and after is not None:
        if after.kind not in {"listing", "unknown"}:
            return True, f"surface changed to {after.kind}"
        if before is not None:
            before_url = str(before.url or "").strip()
            after_url = str(after.url or "").strip()
            if before_url and after_url and before_url != after_url:
                return True, f"url changed to {after_url}"
    if not rules:
        if step.kind == "navigate" and after is not None:
            if target_host and _host_matches_target(target_host, after.url):
                return True, f"navigated to {target_host}"
            if identity_terms and _identity_term_matches_page(identity_terms, after):
                return True, f"navigated to {identity_terms[0]}"
        return False, None
    matched: list[str] = []
    for rule in rules:
        if _rule_matches(rule=rule, before=before, after=after):
            if rule.kind == "surface_kind" and rule.expected_surface:
                matched.append(f"surface changed to {rule.expected_surface}")
            elif rule.kind == "selected_filter":
                matched.append(f"filter {rule.key}={rule.value} is selected")
            elif rule.kind == "search_query":
                matched.append(f"search query is {rule.value}")
            elif rule.kind == "result_count_changed":
                matched.append("results changed")
            elif rule.kind == "url_contains":
                matched.append(f"url contains {rule.value}")
            elif rule.kind == "ref_absent":
                matched.append(f"ref {rule.value} is no longer visible")
            elif rule.kind == "ref_present":
                matched.append(f"ref {rule.value} is visible")
    required_match_count = len(rules)
    if step.kind == "navigate" and after is not None and (target_host or identity_terms):
        if target_host and not _host_matches_target(target_host, after.url):
            return False, None
        if identity_terms and not _identity_term_matches_page(identity_terms, after):
            return False, None
        matched.append(f"navigated to {target_host or identity_terms[0]}")
        required_match_count += 1
    if len(matched) != required_match_count:
        return False, None
    return True, "; ".join(matched) if matched else None


def reconcile_execution_steps(
    *,
    steps: list[ExecutionStep],
    ui_surface: UISurfaceState | None,
    previous_surface: UISurfaceState | None = None,
) -> tuple[int | None, list[ExecutionStep]]:
    if not steps:
        return None, []
    reconciled: list[ExecutionStep] = []
    active_index: int | None = None
    for index, step in enumerate(steps):
        next_step = step.model_copy()
        verified, change = verify_execution_step(step=step, before=previous_surface, after=ui_surface)
        if verified:
            next_step.status = "completed"
            next_step.last_verified_change = change
        elif active_index is None:
            next_step.status = "active"
            active_index = index
        else:
            next_step.status = "pending"
        reconciled.append(next_step)
    if active_index is None and any(step.status != "completed" for step in reconciled):
        for index, step in enumerate(reconciled):
            if step.status != "completed":
                reconciled[index] = step.model_copy(update={"status": "active"})
                active_index = index
                break
    return active_index, reconciled


def derive_phase_rows_from_execution_steps(steps: list[ExecutionStep]) -> tuple[int | None, dict[str, list[str]], list[dict[str, Any]]]:
    phase_fact_evidence: dict[str, list[str]] = {}
    rows: list[dict[str, Any]] = []
    active_phase_index: int | None = None
    for index, step in enumerate(steps):
        rows.append(
            {
                "phase_index": index,
                "label": step.label,
                "status": step.status,
                "last_updated_at": None,
            }
        )
        if step.last_verified_change:
            phase_fact_evidence[str(index)] = [step.last_verified_change]
        if step.status == "active" and active_phase_index is None:
            active_phase_index = index
    return active_phase_index, phase_fact_evidence, rows
