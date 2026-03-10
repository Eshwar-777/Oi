from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from oi_agent.prompts.loader import load_prompt


_BACKEND_ROOT = Path(__file__).resolve().parents[5]
_REPO_ROOT = _BACKEND_ROOT.parents[1]
_SKILLS_ROOT = _BACKEND_ROOT / "skills"
_PLAYBOOKS_ROOT = _BACKEND_ROOT / "playbooks"
_DOC_FILES = (
    _BACKEND_ROOT / "UI_NAVIGATOR_PROMPT.md",
    _BACKEND_ROOT / "UI_NAVIGATOR_UI_PROMPT.md",
    _BACKEND_ROOT / "UI_NAVIGATOR_UX.md",
)

DEFAULT_RETRIEVED_DOC_BUDGET = 4_000
DEFAULT_SECTION_CHAR_LIMIT = 1_600


@dataclass(frozen=True)
class NavigatorInstructionSource:
    source_id: str
    kind: str
    title: str
    description: str
    path: Path
    body: str
    hosts: tuple[str, ...] = ()
    keywords: tuple[str, ...] = ()


@dataclass(frozen=True)
class RetrievedInstruction:
    source_id: str
    kind: str
    title: str
    path: str
    score: int
    excerpt: str
    truncated: bool


@dataclass(frozen=True)
class NavigatorPromptBundle:
    system_prompt: str
    task_prompt: str
    debug: dict[str, Any]


def _strip_frontmatter(raw: str) -> tuple[dict[str, str], str]:
    text = raw.strip()
    if not text.startswith("---\n"):
        return {}, raw.strip()
    parts = text.split("\n---\n", 1)
    if len(parts) != 2:
        return {}, raw.strip()
    metadata: dict[str, str] = {}
    for line in parts[0][4:].splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        metadata[key.strip()] = value.strip()
    return metadata, parts[1].strip()


def _tokenize(text: str) -> set[str]:
    return {token for token in re.split(r"[^a-z0-9]+", text.lower()) if len(token) > 2}


def _trim_excerpt(text: str, *, limit: int) -> tuple[str, bool]:
    normalized = (text or "").strip()
    if len(normalized) <= limit:
        return normalized, False
    head = normalized[: int(limit * 0.75)].rstrip()
    tail = normalized[-int(limit * 0.15) :].lstrip()
    excerpt = "\n".join(
        [
            head,
            f"[...truncated, read source for full content: kept {len(head)}+{len(tail)} chars of {len(normalized)}...]",
            tail,
        ]
    )
    return excerpt, True


def _score_source(
    source: NavigatorInstructionSource,
    *,
    prompt: str,
    current_url: str,
) -> int:
    score = 0
    prompt_tokens = _tokenize(prompt)
    host = urlparse(current_url).netloc.lower()
    host_candidates = {host}
    if host.startswith("www."):
        host_candidates.add(host[4:])

    if source.kind == "playbook":
        for candidate in source.hosts:
            if candidate in host_candidates:
                score += 12
            elif candidate and candidate in host:
                score += 8
    overlap = prompt_tokens & set(source.keywords)
    score += len(overlap) * 3

    if source.kind == "skill":
        if "browser" in prompt.lower() or "navigator" in prompt.lower():
            score += 2
    if source.kind == "doc":
        score += 1
    return score


def _read_summary_from_body(body: str) -> str:
    lines = [line.strip() for line in body.splitlines() if line.strip()]
    for line in lines:
        if line.startswith("#"):
            continue
        return line[:160]
    return ""


@lru_cache(maxsize=1)
def load_instruction_catalog() -> tuple[NavigatorInstructionSource, ...]:
    sources: list[NavigatorInstructionSource] = []

    if _PLAYBOOKS_ROOT.exists():
        for path in sorted(_PLAYBOOKS_ROOT.rglob("*.md")):
            raw = path.read_text(encoding="utf-8")
            metadata, body = _strip_frontmatter(raw)
            hosts = tuple(part.strip().lower() for part in metadata.get("hosts", "").split(",") if part.strip())
            keywords = tuple(
                part.strip().lower() for part in metadata.get("keywords", "").split(",") if part.strip()
            )
            source_id = metadata.get("id") or path.stem
            title = metadata.get("title") or path.stem.replace("-", " ").title()
            description = metadata.get("summary") or _read_summary_from_body(body)
            sources.append(
                NavigatorInstructionSource(
                    source_id=source_id,
                    kind="playbook",
                    title=title,
                    description=description,
                    path=path,
                    body=body,
                    hosts=hosts,
                    keywords=keywords or tuple(_tokenize(f"{title} {description}")),
                )
            )

    if _SKILLS_ROOT.exists():
        for path in sorted(_SKILLS_ROOT.glob("*/SKILL.md")):
            raw = path.read_text(encoding="utf-8")
            _, body = _strip_frontmatter(raw)
            title = path.parent.name.replace("-", " ")
            description = _read_summary_from_body(body)
            sources.append(
                NavigatorInstructionSource(
                    source_id=path.parent.name,
                    kind="skill",
                    title=title.title(),
                    description=description,
                    path=path,
                    body=body,
                    keywords=tuple(_tokenize(f"{title} {description}")),
                )
            )

    for path in _DOC_FILES:
        if not path.exists():
            continue
        raw = path.read_text(encoding="utf-8")
        _, body = _strip_frontmatter(raw)
        title = path.stem.replace("_", " ").title()
        description = _read_summary_from_body(body)
        sources.append(
            NavigatorInstructionSource(
                source_id=path.stem.lower(),
                kind="doc",
                title=title,
                description=description,
                path=path,
                body=body,
                keywords=tuple(_tokenize(f"{title} {description}")),
            )
        )

    return tuple(sources)


def _format_available_sources(sources: tuple[NavigatorInstructionSource, ...]) -> str:
    lines = ["<available_instruction_sources>"]
    for source in sources:
        lines.extend(
            [
                "  <source>",
                f"    <id>{source.source_id}</id>",
                f"    <kind>{source.kind}</kind>",
                f"    <title>{source.title}</title>",
                f"    <description>{source.description}</description>",
                f"    <location>{source.path}</location>",
                "  </source>",
            ]
        )
    lines.append("</available_instruction_sources>")
    return "\n".join(lines)


def retrieve_instruction_context(
    *,
    user_prompt: str,
    current_url: str,
    max_chars: int = DEFAULT_RETRIEVED_DOC_BUDGET,
    per_source_char_limit: int = DEFAULT_SECTION_CHAR_LIMIT,
    max_items: int = 3,
) -> tuple[str, list[RetrievedInstruction]]:
    ranked: list[tuple[int, NavigatorInstructionSource]] = []
    for source in load_instruction_catalog():
        score = _score_source(source, prompt=user_prompt, current_url=current_url)
        if score <= 0:
            continue
        ranked.append((score, source))
    ranked.sort(key=lambda row: row[0], reverse=True)

    chosen: list[RetrievedInstruction] = []
    sections: list[str] = []
    used_chars = 0
    for score, source in ranked[:max_items]:
        excerpt, truncated = _trim_excerpt(source.body, limit=per_source_char_limit)
        candidate = "\n".join(
            [
                f"[{source.kind}:{source.source_id}] {source.title}",
                f"Source: {source.path}",
                excerpt,
            ]
        ).strip()
        if sections and used_chars + len(candidate) > max_chars:
            break
        sections.append(candidate)
        used_chars += len(candidate)
        chosen.append(
            RetrievedInstruction(
                source_id=source.source_id,
                kind=source.kind,
                title=source.title,
                path=str(source.path),
                score=score,
                excerpt=excerpt,
                truncated=truncated,
            )
        )

    if not sections:
        return "", []

    return (
        "RETRIEVED CONTEXT\n"
        "These are on-demand instruction excerpts selected for the current task. Use them as hints, not as permission to invent unsupported UI actions.\n\n"
        + "\n\n".join(sections),
        chosen,
    )


def build_navigator_system_prompt(*, task: str, prompt_mode: str = "full") -> str:
    base = load_prompt("system/navigator_core.md").strip()
    task_prompt = load_prompt(f"tasks/{task}.md").strip()
    sections = [base]
    if prompt_mode != "minimal":
        sections.append("## Instruction Sources\nRead the compact source list below as metadata only. Source bodies are retrieved on demand.")
        sections.append(_format_available_sources(load_instruction_catalog()))
    sections.append(task_prompt)
    return "\n\n".join(section for section in sections if section.strip())


def build_navigator_prompt_bundle(
    *,
    task: str,
    user_prompt: str,
    current_url: str = "",
    current_page_title: str = "",
    runtime_metadata: dict[str, Any] | None = None,
    sections: list[tuple[str, str]] | None = None,
    include_retrieved_context: bool = True,
    prompt_mode: str = "full",
) -> NavigatorPromptBundle:
    retrieved_text = ""
    retrieved_meta: list[RetrievedInstruction] = []
    if include_retrieved_context:
        retrieved_text, retrieved_meta = retrieve_instruction_context(
            user_prompt=user_prompt,
            current_url=current_url,
        )

    url_lines = [
        f"Current URL: {current_url or 'unknown'}",
        f"Current page title: {current_page_title or 'unknown'}",
    ]
    runtime = dict(runtime_metadata or {})
    runtime_lines = [f"{key}: {value}" for key, value in runtime.items() if value not in (None, "", [], {})]

    task_sections = [
        "## User Goal",
        user_prompt.strip(),
        "",
        "## Runtime Metadata",
        *url_lines,
    ]
    if runtime_lines:
        task_sections.extend(["", *runtime_lines])
    if sections:
        for title, body in sections:
            body = (body or "").strip()
            if not body:
                continue
            task_sections.extend(["", f"## {title}", body])
    if retrieved_text:
        task_sections.extend(["", retrieved_text])

    task_prompt = "\n".join(task_sections).strip()
    debug = {
        "task": task,
        "prompt_mode": prompt_mode,
        "runtime_metadata": runtime,
        "retrieved_sources": [
            {
                "id": item.source_id,
                "kind": item.kind,
                "title": item.title,
                "path": item.path,
                "score": item.score,
                "truncated": item.truncated,
            }
            for item in retrieved_meta
        ],
        "char_counts": {
            "task_prompt": len(task_prompt),
            "retrieved_context": len(retrieved_text),
        },
    }
    return NavigatorPromptBundle(
        system_prompt=build_navigator_system_prompt(task=task, prompt_mode=prompt_mode),
        task_prompt=task_prompt,
        debug=debug,
    )
