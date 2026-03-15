from __future__ import annotations

from datetime import UTC, datetime
import re
from typing import Any
from urllib.parse import parse_qsl, urlparse

from oi_agent.automation.models import UIActionableRef, UIResultItem, UISurfaceState

_PRIMARY_CTA_MARKERS = ("continue", "next", "proceed", "submit", "save", "confirm")
_AUTH_MARKERS = ("sign in", "log in", "login", "password", "otp", "verification code", "verify")
_AUTH_FIELD_MARKERS = ("password", "passcode", "otp", "verification code", "email", "phone")
_AUTH_CONTROL_MARKERS = ("sign in", "log in", "login", "continue with", "use another account", "create account")
_CONFIRMATION_MARKERS = ("thank you", "confirmed", "success", "completed", "done")
_DIALOG_MARKERS = ("dialog", "modal", "popup", "drawer", "sheet")
_BLOCKER_MARKERS = ("permission", "blocked", "captcha", "authorize", "consent")
_BLOCKED_SURFACE_MARKERS = (
    "refused to connect",
    "err_blocked_by_response",
    "is blocked",
    "request blocked",
    "access denied",
    "cannot be reached",
    "can t be reached",
    "site can t be reached",
    "refused by response",
)
_DIALOG_DECISION_MARKERS = ("allow", "deny", "cancel", "close", "dismiss", "not now", "later")
_CLICKABLE_ROLES = {"button", "link", "option", "tab", "checkbox", "radio", "switch", "menuitem"}
_EDITABLE_ROLES = {"textbox", "searchbox", "combobox", "input", "spinbutton", "listbox"}
_FOREGROUND_CONTAINER_ROLES = {"dialog", "form", "region"}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _normalize(value: Any) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _contains_phrase(text: str, phrase: str) -> bool:
    normalized_text = f" {_normalize(text)} "
    normalized_phrase = f" {_normalize(phrase)} "
    return normalized_phrase in normalized_text


def _snapshot_text(snapshot: dict[str, Any] | None) -> str:
    if not isinstance(snapshot, dict):
        return ""
    text = str(snapshot.get("snapshot", "") or "")
    return re.sub(r"^SECURITY NOTICE: Untrusted browser content follows\.\s*", "", text).strip()


def _snapshot_refs(snapshot: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    if not isinstance(snapshot, dict):
        return {}
    refs = snapshot.get("refs")
    if not isinstance(refs, dict):
        refs = {}
        snapshot_text = _snapshot_text(snapshot)
        for match in re.finditer(r"\[e(?P<ref>\d+)\]\s+(?P<role>[a-zA-Z]+)\s+\"(?P<name>[^\"]+)\"", snapshot_text):
            ref_id = f"e{match.group('ref')}"
            refs[ref_id] = {
                "role": match.group("role").strip(),
                "name": match.group("name").strip(),
            }
        for match in re.finditer(r"(?P<role>[a-zA-Z]+)\s+\"(?P<name>[^\"]+)\"\s+\[ref=(?P<ref>e\d+)\]", snapshot_text):
            ref_id = match.group("ref")
            refs[ref_id] = {
                "role": match.group("role").strip(),
                "name": match.group("name").strip(),
            }
        return refs
    return {str(ref): dict(value) for ref, value in refs.items() if isinstance(value, dict)}


def _selected_filters_from_url(url: str) -> dict[str, str]:
    parsed = urlparse(url or "")
    filters: dict[str, str] = {}
    for key, value in parse_qsl(parsed.query, keep_blank_values=False):
        cleaned_key = _normalize(key).replace("_", " ")
        cleaned_value = str(value or "").strip()
        if cleaned_key and cleaned_value:
            filters[cleaned_key] = cleaned_value
    return filters


def _search_query_from_url(url: str) -> str | None:
    parsed = urlparse(url or "")
    for key, value in parse_qsl(parsed.query, keep_blank_values=False):
        cleaned_key = _normalize(key)
        if cleaned_key in {"q", "query", "search", "keyword", "rawquery"}:
            cleaned_value = str(value or "").strip()
            if cleaned_value:
                return cleaned_value
    slug = parsed.path.rsplit("/", 1)[-1].strip()
    return slug or None


def _ref_intent(role: str, name: str) -> str:
    normalized_name = _normalize(name)
    normalized_role = _normalize(role)
    if normalized_role in _EDITABLE_ROLES:
        return "input"
    if normalized_role in {"button", "link"} and any(marker in normalized_name for marker in _PRIMARY_CTA_MARKERS):
        return "primary_cta"
    if normalized_role in {"checkbox", "radio", "option", "switch", "menuitem"}:
        return "filter_control"
    if normalized_role in {"button", "link"}:
        return "navigation"
    return "unknown"


def _is_result_like_link(name: str) -> bool:
    normalized_name = _normalize(name)
    if not normalized_name:
        return False
    if any(marker in normalized_name for marker in ("learn more", "view details", "read more", "open", "back")):
        return False
    token_count = len(normalized_name.split())
    return "rs." in normalized_name or "₹" in normalized_name or token_count >= 3


def _count_refs_by_role(actionable_refs: list[UIActionableRef]) -> tuple[int, int]:
    clickable_count = 0
    editable_count = 0
    for item in actionable_refs:
        role = _normalize(item.role)
        if role in _CLICKABLE_ROLES:
            clickable_count += 1
        if role in _EDITABLE_ROLES:
            editable_count += 1
    return clickable_count, editable_count


def _has_foreground_container(actionable_refs: list[UIActionableRef]) -> bool:
    return any(_normalize(item.role) in _FOREGROUND_CONTAINER_ROLES for item in actionable_refs)


def _looks_like_form_surface(
    *,
    actionable_refs: list[UIActionableRef],
    result_items: list[UIResultItem],
    search_query: str | None,
) -> bool:
    clickable_count, editable_count = _count_refs_by_role(actionable_refs)
    if editable_count < 1:
        return False
    if editable_count >= 3:
        return True
    if result_items and len(result_items) >= 3 and editable_count < 3:
        return False
    if search_query and len(result_items) >= 2:
        return False
    if editable_count == 1 and not result_items and clickable_count <= 3:
        return True
    return _has_foreground_container(actionable_refs)


def _looks_like_detail_surface(
    *,
    actionable_refs: list[UIActionableRef],
    result_items: list[UIResultItem],
    primary_action_refs: list[str],
    normalized_text: str,
    normalized_title: str,
    normalized_url: str,
) -> bool:
    if len(result_items) > 1:
        return False
    if primary_action_refs:
        return True
    clickable_count, editable_count = _count_refs_by_role(actionable_refs)
    if editable_count > 0:
        return False
    long_title = len(normalized_title.split()) >= 2
    rich_text = len(normalized_text.split()) >= 12
    article_like_path = not any(marker in normalized_url for marker in ("search", "results", "query", "checkout", "cart"))
    return article_like_path and clickable_count >= 1 and long_title and rich_text


def _looks_like_auth_surface(
    *,
    normalized_text: str,
    normalized_title: str,
    actionable_refs: list[UIActionableRef],
    result_items: list[UIResultItem],
) -> bool:
    _, editable_count = _count_refs_by_role(actionable_refs)
    if len(result_items) >= 2:
        return False
    auth_named_fields = 0
    auth_controls = 0
    for item in actionable_refs:
        name = _normalize(item.name)
        if any(_contains_phrase(name, marker) for marker in _AUTH_FIELD_MARKERS):
            auth_named_fields += 1
        if any(_contains_phrase(name, marker) for marker in _AUTH_CONTROL_MARKERS):
            auth_controls += 1
    strong_text = any(
        _contains_phrase(normalized_text, marker) or _contains_phrase(normalized_title, marker)
        for marker in ("password", "otp", "verification code")
    )
    title_is_auth = any(_contains_phrase(normalized_title, marker) for marker in ("sign in", "log in", "login"))
    if auth_named_fields >= 1 and editable_count >= 1:
        return True
    if strong_text and editable_count >= 1:
        return True
    if auth_controls >= 2 and editable_count >= 1 and not result_items:
        return True
    if title_is_auth and editable_count >= 1 and not result_items:
        return True
    return False


def _looks_like_confirmation_surface(
    *,
    normalized_text: str,
    normalized_title: str,
    result_items: list[UIResultItem],
    active_form_fields: list[str],
    actionable_refs: list[UIActionableRef],
) -> bool:
    _, editable_count = _count_refs_by_role(actionable_refs)
    if result_items or active_form_fields or editable_count > 0:
        return False
    return any(marker in normalized_text or marker in normalized_title for marker in _CONFIRMATION_MARKERS)


def _looks_like_dialog_surface(
    *,
    normalized_text: str,
    normalized_title: str,
    actionable_refs: list[UIActionableRef],
    result_items: list[UIResultItem],
) -> bool:
    clickable_count, editable_count = _count_refs_by_role(actionable_refs)
    if result_items:
        return False
    decision_controls = 0
    for item in actionable_refs:
        name = _normalize(item.name)
        if any(marker in name for marker in _DIALOG_DECISION_MARKERS):
            decision_controls += 1
    if len(actionable_refs) <= 8 and clickable_count >= 2 and editable_count <= 2:
        blocker_hint = any(marker in normalized_text or marker in normalized_title for marker in _BLOCKER_MARKERS)
        title_requires_action = any(
            marker in normalized_title for marker in ("required", "permission", "confirm", "verification")
        )
        return decision_controls >= 2 or blocker_hint or title_requires_action
    return any(marker in normalized_text for marker in _DIALOG_MARKERS)


def _looks_like_blocker_surface(
    *,
    normalized_text: str,
    normalized_title: str,
    normalized_url: str,
    actionable_refs: list[UIActionableRef],
    result_items: list[UIResultItem],
    primary_action_refs: list[str],
) -> bool:
    combined = "\n".join((normalized_text, normalized_title, normalized_url))
    if any(marker in combined for marker in _BLOCKED_SURFACE_MARKERS):
        return True
    if result_items or primary_action_refs:
        return False
    if actionable_refs:
        return False
    return any(marker in combined for marker in _BLOCKER_MARKERS)


def _looks_like_checkout_surface(
    *,
    normalized_url: str,
    normalized_title: str,
    actionable_refs: list[UIActionableRef],
    result_items: list[UIResultItem],
    primary_action_refs: list[str],
) -> bool:
    clickable_count, editable_count = _count_refs_by_role(actionable_refs)
    if any(marker in normalized_url or marker in normalized_title for marker in ("checkout", "payment", "shipping", "review")):
        return True
    return editable_count >= 2 and clickable_count >= 1 and bool(primary_action_refs) and not result_items


def _looks_like_cart_surface(
    *,
    normalized_url: str,
    normalized_title: str,
    result_items: list[UIResultItem],
    primary_action_refs: list[str],
    active_form_fields: list[str],
) -> bool:
    if any(marker in normalized_url or marker in normalized_title for marker in ("cart", "bag")):
        return True
    return bool(result_items) and bool(primary_action_refs) and not active_form_fields


def _structural_surface_kind(
    *,
    normalized_text: str,
    normalized_title: str,
    normalized_url: str,
    search_query: str | None,
    selected_filters: dict[str, str],
    actionable_refs: list[UIActionableRef],
    result_items: list[UIResultItem],
    primary_action_refs: list[str],
) -> str:
    input_count = sum(1 for item in actionable_refs if item.intent == "input")
    filter_count = sum(1 for item in actionable_refs if item.intent == "filter_control")
    if _looks_like_blocker_surface(
        normalized_text=normalized_text,
        normalized_title=normalized_title,
        normalized_url=normalized_url,
        actionable_refs=actionable_refs,
        result_items=result_items,
        primary_action_refs=primary_action_refs,
    ):
        return "blocker"
    if _looks_like_auth_surface(
        normalized_text=normalized_text,
        normalized_title=normalized_title,
        actionable_refs=actionable_refs,
        result_items=result_items,
    ):
        return "auth"
    if _looks_like_confirmation_surface(
        normalized_text=normalized_text,
        normalized_title=normalized_title,
        result_items=result_items,
        active_form_fields=[item.name or "" for item in actionable_refs if item.intent == "input"],
        actionable_refs=actionable_refs,
    ):
        return "confirmation"
    if _looks_like_checkout_surface(
        normalized_url=normalized_url,
        normalized_title=normalized_title,
        actionable_refs=actionable_refs,
        result_items=result_items,
        primary_action_refs=primary_action_refs,
    ):
        return "checkout"
    if _looks_like_cart_surface(
        normalized_url=normalized_url,
        normalized_title=normalized_title,
        result_items=result_items,
        primary_action_refs=primary_action_refs,
        active_form_fields=[item.name or "" for item in actionable_refs if item.intent == "input"],
    ):
        return "cart"
    if _looks_like_dialog_surface(
        normalized_text=normalized_text,
        normalized_title=normalized_title,
        actionable_refs=actionable_refs,
        result_items=result_items,
    ):
        return "dialog"
    if _looks_like_form_surface(
        actionable_refs=actionable_refs,
        result_items=result_items,
        search_query=search_query,
    ):
        return "form"
    if _looks_like_detail_surface(
        actionable_refs=actionable_refs,
        result_items=result_items,
        primary_action_refs=primary_action_refs,
        normalized_text=normalized_text,
        normalized_title=normalized_title,
        normalized_url=normalized_url,
    ):
        return "detail"
    if len(result_items) >= 2 and (
        bool(str(search_query or "").strip())
        or any(key in selected_filters for key in ("q", "query", "search", "keyword", "rawquery"))
        or input_count >= 1
    ):
        return "listing"
    if input_count >= 2 and not result_items:
        return "form"
    if len(result_items) >= 3 and (filter_count > 0 or selected_filters):
        return "listing"
    if len(result_items) >= 5:
        return "listing"
    return "unknown"


def interpret_ui_surface(
    *,
    snapshot: dict[str, Any] | None,
    current_url: str = "",
    current_title: str = "",
    captured_at: str | None = None,
    page_id: str | None = None,
) -> UISurfaceState:
    refs = _snapshot_refs(snapshot)
    snapshot_text = _snapshot_text(snapshot)
    normalized_text = _normalize(snapshot_text)
    normalized_title = _normalize(current_title)
    normalized_url = _normalize(current_url)
    selected_filters = _selected_filters_from_url(current_url)
    search_query = _search_query_from_url(current_url)
    actionable_refs: list[UIActionableRef] = []
    result_items: list[UIResultItem] = []
    primary_action_refs: list[str] = []
    signals: list[str] = []
    blockers: list[str] = []
    active_form_fields: list[str] = []

    for ref, record in refs.items():
        role = str(record.get("role", "") or "").strip()
        name = str(record.get("name", "") or "").strip()
        intent = _ref_intent(role, name)
        if _normalize(role) == "link" and _is_result_like_link(name):
            intent = "result_item"
        actionable_refs.append(
            UIActionableRef(ref=ref, role=role or None, name=name or None, intent=intent)
        )
        if intent == "primary_cta":
            primary_action_refs.append(ref)
        if intent == "input" and name:
            active_form_fields.append(name)
        if intent == "result_item":
            result_items.append(
                UIResultItem(
                    ref=ref,
                    name=name,
                    price_text=name if "rs." in name.lower() or "₹" in name else None,
                    raw_label=name,
                )
            )

    kind = _structural_surface_kind(
        normalized_text=normalized_text,
        normalized_title=normalized_title,
        normalized_url=normalized_url,
        search_query=search_query,
        selected_filters=selected_filters,
        actionable_refs=actionable_refs,
        result_items=result_items,
        primary_action_refs=primary_action_refs,
    )

    blocker_sources = [normalized_text, normalized_title]
    blocker_sources.extend(_normalize(item.name) for item in actionable_refs if item.name)
    for marker in _BLOCKER_MARKERS:
        if any(marker in source for source in blocker_sources) and marker not in blockers:
            blockers.append(marker)
    if kind == "dialog":
        decision_labels = {_normalize(item.name) for item in actionable_refs if item.name}
        if "allow" in decision_labels and "deny" in decision_labels and "permission" not in blockers:
            blockers.append("permission")

    signals.append(f"surface:{kind}")
    for key, value in selected_filters.items():
        signals.append(f"filter:{key}={value}")
    if search_query:
        signals.append(f"query:{search_query}")
    if result_items:
        signals.append(f"results:{len(result_items)}")
    if primary_action_refs:
        signals.append(f"cta:{len(primary_action_refs)}")
    if active_form_fields:
        signals.append(f"form_fields:{len(active_form_fields)}")
    if blockers:
        signals.extend([f"blocker:{item}" for item in blockers])

    confidence = 0.0
    if kind != "unknown":
        confidence += 0.4
    if actionable_refs:
        confidence += 0.2
    if result_items:
        confidence += 0.2
    if primary_action_refs or active_form_fields:
        confidence += 0.2

    return UISurfaceState(
        captured_at=captured_at or _now_iso(),
        kind=kind,
        url=current_url or None,
        title=current_title or None,
        page_id=page_id,
        search_query=search_query,
        selected_filters=selected_filters,
        actionable_refs=actionable_refs,
        result_items=result_items,
        primary_action_refs=primary_action_refs,
        blockers=blockers,
        active_form_fields=active_form_fields,
        confidence=min(1.0, confidence),
        source_snapshot_id=str((snapshot or {}).get("snapshot_id", "") or None) or None,
        source_ref_count=len(refs),
        signals=signals,
    )
