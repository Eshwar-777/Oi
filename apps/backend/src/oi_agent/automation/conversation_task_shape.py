from __future__ import annotations

from dataclasses import dataclass, field

_APP_SIGNAL_MAP: dict[str, tuple[str, ...]] = {
    "gmail": ("gmail", "email", "inbox", "draft", "drafts", "sent mail"),
    "whatsapp": ("whatsapp", "chat", "thread"),
    "telegram": ("telegram",),
    "slack": ("slack",),
    "github": ("github", "repo", "repository", "pull request", "issue"),
    "calendar": ("calendar", "event"),
    "docs": ("docs", "document", "doc"),
    "notion": ("notion", "page", "workspace"),
}

TRANSFER_SOURCE_MARKERS = (
    "copy",
    "extract",
    "forward",
    "quote",
    "take the text",
    "take the body",
)

VISIBLE_STATE_MARKERS = (
    "first ",
    "latest ",
    "top ",
    "currently open",
    "open tab",
    "visible ",
    "selected ",
    "active ",
    "inbox",
    "thread",
    "chat",
    "draft",
    "body of",
)

BROWSER_SURFACE_MARKERS = (
    "using the browser",
    "using only the browser",
    "using the live browser",
    "live browser",
    "in the browser",
    "through the browser",
)


def normalize_text(value: str) -> str:
    return " ".join((value or "").strip().lower().split())


@dataclass(frozen=True)
class TaskShape:
    apps: set[str] = field(default_factory=set)
    source_apps: set[str] = field(default_factory=set)
    destination_apps: set[str] = field(default_factory=set)
    operation_chain: tuple[str, ...] = ()
    requires_live_ui: bool = False
    cross_app_transfer: bool = False
    visible_state_dependence: bool = False
    execution_surface: str = "unknown"
    timing_intent: str = "unspecified"


def detect_apps(normalized: str) -> set[str]:
    return {
        app
        for app, signals in _APP_SIGNAL_MAP.items()
        if any(signal in normalized for signal in signals)
    }


def infer_task_shape(goal: str) -> TaskShape:
    normalized = normalize_text(goal)
    apps = detect_apps(normalized)
    operations: list[str] = []
    if any(token in normalized for token in ("open ", "navigate ", "go to ", "switch to ")):
        operations.append("navigate")
    if any(marker in normalized for marker in TRANSFER_SOURCE_MARKERS):
        operations.append("extract")
    if "send" in normalized or "reply" in normalized:
        operations.append("send")
    if "schedule" in normalized or "every " in normalized or "tomorrow" in normalized:
        timing_intent = "recurring" if "every " in normalized else "once" if "tomorrow" in normalized else "unspecified"
    elif "now" in normalized or "right now" in normalized:
        timing_intent = "immediate"
    else:
        timing_intent = "unspecified"
    visible_state_dependence = any(marker in normalized for marker in VISIBLE_STATE_MARKERS)
    requires_live_ui = visible_state_dependence or any(marker in normalized for marker in BROWSER_SURFACE_MARKERS)
    destination_apps = {app for app in apps if app in {"whatsapp", "telegram", "slack", "gmail"}}
    source_apps = apps - destination_apps
    if "gmail" in apps and "extract" in operations:
        source_apps.add("gmail")
    cross_app_transfer = (
        "send" in operations and "extract" in operations and bool(destination_apps) and bool(source_apps or len(apps) > 1)
    )
    execution_surface = "browser" if requires_live_ui or cross_app_transfer else "schedule" if timing_intent in {"once", "recurring"} else "unknown"
    return TaskShape(
        apps=apps,
        source_apps=source_apps,
        destination_apps=destination_apps,
        operation_chain=tuple(dict.fromkeys(operations)),
        requires_live_ui=requires_live_ui,
        cross_app_transfer=cross_app_transfer,
        visible_state_dependence=visible_state_dependence,
        execution_surface=execution_surface,
        timing_intent=timing_intent,
    )
