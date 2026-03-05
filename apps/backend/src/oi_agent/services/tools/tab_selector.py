from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

_STOPWORDS = {
    "the", "a", "an", "and", "or", "to", "for", "on", "in", "of", "with",
    "my", "me", "please", "open", "go", "run", "do", "play", "search", "find",
}

_APP_HINTS: dict[str, tuple[str, ...]] = {
    "netflix": ("netflix", "series", "movie", "episode", "watch"),
    "youtube": ("youtube", "video", "channel", "shorts"),
    "gmail": ("gmail", "inbox", "mail", "email", "compose"),
    "amazon": ("amazon", "cart", "checkout", "product", "buy"),
    "linkedin": ("linkedin", "job", "profile", "post", "message"),
    "twitter": ("twitter", "tweet", "x.com", "post"),
}


@dataclass
class CandidateTab:
    device_id: str
    tab_id: int
    title: str
    url: str


def _tokenize(text: str) -> set[str]:
    tokens = {t for t in re.findall(r"[a-z0-9][a-z0-9._-]*", text.lower()) if len(t) >= 2}
    return {t for t in tokens if t not in _STOPWORDS}


def _host_tokens(url: str) -> set[str]:
    try:
        parsed = urlparse(url if "://" in url else f"https://{url}")
        host = (parsed.netloc or "").lower().replace("www.", "")
        return _tokenize(host)
    except Exception:
        return set()


def _tab_tokens(tab: CandidateTab) -> set[str]:
    return _tokenize(f"{tab.title} {tab.url}") | _host_tokens(tab.url)


def _extract_candidates(rows: list[dict[str, Any]]) -> list[CandidateTab]:
    out: list[CandidateTab] = []
    for row in rows:
        device_id = str(row.get("device_id", ""))
        tabs = row.get("tabs", [])
        if isinstance(tabs, list) and tabs:
            for t in tabs:
                if not isinstance(t, dict):
                    continue
                out.append(
                    CandidateTab(
                        device_id=device_id,
                        tab_id=int(t.get("tab_id", 0) or 0),
                        title=str(t.get("title", "") or ""),
                        url=str(t.get("url", "") or ""),
                    )
                )
            continue

        target = row.get("target")
        if isinstance(target, dict):
            out.append(
                CandidateTab(
                    device_id=device_id,
                    tab_id=int(target.get("tab_id", 0) or 0),
                    title=str(target.get("title", "") or ""),
                    url=str(target.get("url", "") or ""),
                )
            )
    return [c for c in out if c.device_id and c.tab_id]


def select_best_attached_tab(
    prompt: str,
    attached_rows: list[dict[str, Any]],
    preferred_device_id: str | None = None,
) -> tuple[str, int] | None:
    """Return (device_id, tab_id) that best matches the prompt."""
    candidates = _extract_candidates(attached_rows)
    if preferred_device_id:
        filtered = [c for c in candidates if c.device_id == preferred_device_id]
        if filtered:
            candidates = filtered
    if not candidates:
        return None

    prompt_lower = (prompt or "").lower()
    prompt_tokens = _tokenize(prompt_lower)

    if not prompt_tokens:
        first = candidates[0]
        return first.device_id, first.tab_id

    scores: list[tuple[int, int, str, int]] = []
    for idx, c in enumerate(candidates):
        score = 0
        tab_toks = _tab_tokens(c)

        overlap = prompt_tokens & tab_toks
        score += len(overlap) * 6

        host_toks = _host_tokens(c.url)
        score += len(prompt_tokens & host_toks) * 10

        for app, hints in _APP_HINTS.items():
            if app in host_toks:
                matches = sum(1 for h in hints if h in prompt_lower)
                if matches:
                    score += 20 + (matches * 4)

        if preferred_device_id and c.device_id == preferred_device_id:
            score += 3

        # Prefer deterministic ordering on ties.
        scores.append((score, -idx, c.device_id, c.tab_id))

    scores.sort(reverse=True)
    best = scores[0]
    return best[2], best[3]
