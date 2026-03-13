from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

APP_MATCHERS: dict[str, tuple[str, ...]] = {
    "whatsapp": ("web.whatsapp.com", "whatsapp.com", "whatsapp"),
    "telegram": ("web.telegram.org", "telegram.org", "telegram"),
    "slack": ("app.slack.com", "slack.com", "slack"),
    "discord": ("discord.com", "discordapp.com", "discord"),
    "gmail": ("mail.google.com", "gmail"),
    "notion": ("notion.so", "notion.site", "notion"),
    "youtube": ("youtube.com", "youtu.be", "youtube"),
    "spotify": ("open.spotify.com", "spotify.com", "spotify"),
    "linkedin": ("linkedin.com", "linkedin"),
    "instagram": ("instagram.com", "instagram"),
}


@dataclass(frozen=True)
class AppAttachmentStatus:
    app_name: str
    attached: bool
    message: str


def _normalize_app_name(app_name: str | None) -> str:
    return str(app_name or "").strip().lower()


def _tab_matches_app(tab: dict[str, object], app_name: str) -> bool:
    url = str(tab.get("url", "") or "").lower()
    title = str(tab.get("title", "") or "").lower()
    host = urlparse(url).netloc.lower()
    matchers = APP_MATCHERS.get(app_name, (app_name,))
    return any(matcher and matcher in hay for matcher in matchers for hay in (url, host, title))


def evaluate_app_attachment(
    *,
    app_name: str | None,
    attached_rows: list[dict[str, object]],
) -> AppAttachmentStatus | None:
    normalized = _normalize_app_name(app_name)
    if not normalized:
        return None

    for row in attached_rows:
        tabs = row.get("tabs", [])
        if not isinstance(tabs, list):
            continue
        for tab in tabs:
            if isinstance(tab, dict) and _tab_matches_app(tab, normalized):
                return AppAttachmentStatus(
                    app_name=normalized.title(),
                    attached=True,
                    message=f"{normalized.title()} is attached and ready.",
                )

    return AppAttachmentStatus(
        app_name=normalized.title(),
        attached=False,
        message=f"{normalized.title()} is not attached to the extension. Open {normalized.title()} and attach its tab before running this task.",
    )
