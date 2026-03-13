from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

PLAYBOOKS_DIR = Path(__file__).resolve().parents[5] / "playbooks"


@dataclass(frozen=True)
class SitePlaybook:
    playbook_id: str
    title: str
    summary: str
    hosts: tuple[str, ...]
    keywords: tuple[str, ...]
    body: str
    path: Path


def _tokenize(text: str) -> set[str]:
    return {token for token in re.split(r"[^a-z0-9]+", text.lower()) if len(token) > 2}


def _parse_frontmatter(raw: str) -> tuple[dict[str, str], str]:
    text = raw.strip()
    if not text.startswith("---\n"):
        return {}, raw.strip()
    parts = text.split("\n---\n", 1)
    if len(parts) != 2:
        return {}, raw.strip()
    head = parts[0][4:]
    tail = parts[1]
    metadata: dict[str, str] = {}
    for line in head.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        metadata[key.strip()] = value.strip()
    return metadata, tail.strip()


def _split_csv(value: str) -> tuple[str, ...]:
    return tuple(part.strip().lower() for part in value.split(",") if part.strip())


@lru_cache(maxsize=1)
def load_playbooks() -> tuple[SitePlaybook, ...]:
    if not PLAYBOOKS_DIR.exists():
        return ()
    playbooks: list[SitePlaybook] = []
    for path in sorted(PLAYBOOKS_DIR.rglob("*.md")):
        raw = path.read_text(encoding="utf-8")
        metadata, body = _parse_frontmatter(raw)
        playbook_id = metadata.get("id") or path.stem
        title = metadata.get("title") or playbook_id.replace("-", " ").title()
        body_lines = body.splitlines()
        summary = metadata.get("summary") or (body_lines[0].strip("# ").strip() if body_lines else title)
        hosts = _split_csv(metadata.get("hosts", ""))
        keywords = _split_csv(metadata.get("keywords", ""))
        playbooks.append(
            SitePlaybook(
                playbook_id=playbook_id,
                title=title,
                summary=summary,
                hosts=hosts,
                keywords=keywords,
                body=body,
                path=path,
            )
        )
    return tuple(playbooks)


def _score_playbook(playbook: SitePlaybook, *, prompt: str, current_url: str) -> int:
    score = 0
    host = urlparse(current_url).netloc.lower()
    prompt_tokens = _tokenize(prompt)
    host_parts = {host}
    if host.startswith("www."):
        host_parts.add(host[4:])

    for candidate in playbook.hosts:
        if not candidate:
            continue
        if candidate in host_parts:
            score += 12
        elif candidate and candidate in host:
            score += 8

    overlap = prompt_tokens & set(playbook.keywords)
    score += len(overlap) * 3

    if not playbook.hosts and overlap:
        score += 1

    return score


def select_playbooks(prompt: str, current_url: str, limit: int = 3) -> list[SitePlaybook]:
    ranked: list[tuple[int, SitePlaybook]] = []
    for playbook in load_playbooks():
        score = _score_playbook(playbook, prompt=prompt, current_url=current_url)
        if score <= 0:
            continue
        ranked.append((score, playbook))
    ranked.sort(key=lambda row: row[0], reverse=True)
    return [playbook for _, playbook in ranked[:limit]]


def build_playbook_context(prompt: str, current_url: str, limit: int = 3) -> str:
    matches = select_playbooks(prompt, current_url, limit=limit)
    if not matches:
        return ""

    sections: list[str] = []
    for playbook in matches:
        excerpt = "\n".join(playbook.body.splitlines()[:18]).strip()
        sections.append(
            "\n".join(
                [
                    f"[{playbook.playbook_id}] {playbook.title}",
                    f"Summary: {playbook.summary}",
                    excerpt,
                ]
            ).strip()
        )
    return (
        "SITE PLAYBOOKS\n"
        "Use these as execution hints. Prefer them when they match the current app or flow, but do not invent steps not supported by the page.\n\n"
        + "\n\n".join(sections)
    )
