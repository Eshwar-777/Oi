from __future__ import annotations

import re
from typing import Any

from oi_agent.services.tools.base import BaseTool, ToolContext, ToolResult


def _tokens(text: str) -> set[str]:
    return {token for token in re.split(r"[^a-z0-9]+", text.lower()) if len(token) > 1}


def _candidate_text(row: dict[str, Any]) -> str:
    keys = ("text", "ariaLabel", "placeholder", "name", "id", "role", "tag", "type")
    return " ".join(str(row.get(key, "") or "") for key in keys).strip()


def _stable_target(row: dict[str, Any], action: str) -> dict[str, Any] | None:
    element_id = str(row.get("id", "") or "").strip()
    if element_id:
        return {"by": "css", "value": f"#{element_id}"}
    aria = str(row.get("ariaLabel", "") or "").strip()
    if aria:
        return {"by": "label", "value": aria}
    name = str(row.get("name", "") or "").strip()
    if name and action in {"type", "select"}:
        return {"by": "name", "value": name}
    placeholder = str(row.get("placeholder", "") or "").strip()
    if placeholder:
        return {"by": "placeholder", "value": placeholder}
    role = str(row.get("role", "") or "").strip()
    label = str(row.get("text", "") or "").strip() or aria or placeholder
    if role and label:
        return {"by": "role", "value": role, "name": label}
    return None


class FormTargetResolverTool(BaseTool):
    @property
    def name(self) -> str:
        return "form_target_resolver"

    @property
    def description(self) -> str:
        return "Suggests stable form targets from structured page context for debugging and recovery."

    @property
    def category(self) -> str:
        return "processor"

    async def execute(self, context: ToolContext, input_data: list[dict[str, Any]]) -> ToolResult:
        structured = context.action_config.get("structured_context")
        if not isinstance(structured, dict):
            return ToolResult(success=False, error="Missing structured_context")

        query = str(context.action_config.get("query", "") or "")
        action = str(context.action_config.get("action", "type") or "type").strip().lower()
        if not query:
            return ToolResult(success=False, error="Missing query")

        query_tokens = _tokens(query)
        candidates: list[tuple[int, dict[str, Any], dict[str, Any]]] = []
        for row in structured.get("elements", []):
            if not isinstance(row, dict):
                continue
            target = _stable_target(row, action)
            if target is None:
                continue
            score = len(query_tokens & _tokens(_candidate_text(row)))
            if score <= 0:
                continue
            candidates.append((score, row, target))
        candidates.sort(key=lambda item: item[0], reverse=True)
        suggestions = [
            {
                "score": score,
                "target": target,
                "label": _candidate_text(row)[:140],
            }
            for score, row, target in candidates[:5]
        ]
        return ToolResult(success=True, data=[{"suggestions": suggestions}], text=f"Resolved {len(suggestions)} suggestion(s)")

