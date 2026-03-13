from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[6]
_DOC_PATHS = [
    _REPO_ROOT / "agent-browser-readme.md",
    _REPO_ROOT / "agent-browser-agent-readme.md",
]


@dataclass(frozen=True)
class _DocChunk:
    source: str
    heading: str
    body: str


def _load_chunks() -> list[_DocChunk]:
    chunks: list[_DocChunk] = []
    for path in _DOC_PATHS:
        if not path.exists():
            continue
        lines = path.read_text(encoding="utf-8").splitlines()
        current_heading = path.name
        current_body: list[str] = []
        for line in lines:
            if line.startswith("#"):
                if current_body:
                    chunks.append(
                        _DocChunk(
                            source=path.name,
                            heading=current_heading,
                            body="\n".join(current_body).strip(),
                        )
                    )
                    current_body = []
                current_heading = line.lstrip("#").strip() or path.name
                continue
            current_body.append(line)
        if current_body:
            chunks.append(
                _DocChunk(
                    source=path.name,
                    heading=current_heading,
                    body="\n".join(current_body).strip(),
                )
            )
    return chunks


_KEYWORDS = {
    "snapshot": ("snapshot", "refs", "@e", "accessibility tree", "annotate"),
    "keyboard": ("press", "keyboard", "enter", "tab", "escape", "keydown", "keyup"),
    "upload": ("upload", "file", "chooser", "picker"),
    "tabs": ("tab", "window", "new tab", "switch", "popup"),
    "frames": ("frame", "iframe"),
    "waits": ("wait", "networkidle", "url", "load"),
    "selectors": ("find role", "find text", "find label", "find placeholder", "semantic"),
    "security": ("allowed-domains", "confirm-actions", "action-policy", "content-boundaries"),
}


def build_agent_browser_reference_context(
    *,
    user_prompt: str,
    current_url: str = "",
    failed_step: dict[str, object] | None = None,
    error_message: str | None = None,
) -> str:
    prompt = f"{user_prompt}\n{current_url}\n{error_message or ''}".lower()
    if failed_step:
        prompt += f"\n{failed_step}"

    desired_topics = {"snapshot", "selectors", "waits"}
    for topic, hints in _KEYWORDS.items():
        if any(hint in prompt for hint in hints):
            desired_topics.add(topic)

    chunks = _load_chunks()
    scored: list[tuple[int, _DocChunk]] = []
    for chunk in chunks:
        haystack = f"{chunk.heading}\n{chunk.body}".lower()
        score = 0
        for topic in desired_topics:
            score += sum(1 for hint in _KEYWORDS.get(topic, ()) if hint in haystack)
        if score > 0:
            scored.append((score, chunk))

    scored.sort(key=lambda item: (-item[0], item[1].source, item[1].heading))
    selected = scored[:4]
    if not selected:
        return ""

    lines = ["AGENT-BROWSER REFERENCE SNIPPETS:"]
    for _, chunk in selected:
        snippet = chunk.body.strip()
        if len(snippet) > 1200:
            snippet = snippet[:1200].rsplit("\n", 1)[0].rstrip()
        lines.append(f"\n[{chunk.source} :: {chunk.heading}]")
        lines.append(snippet)
    lines.append(
        "\nUse these snippets as the execution contract. Prefer native agent-browser commands and refs over invented abstractions."
    )
    return "\n".join(lines)
