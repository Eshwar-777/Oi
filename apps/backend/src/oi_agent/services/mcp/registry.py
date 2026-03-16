from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class McpServerProfile:
    server_id: str
    title: str
    capabilities: tuple[str, ...]
    keywords: tuple[str, ...]


SERVER_PROFILES: tuple[McpServerProfile, ...] = (
    McpServerProfile(
        server_id="google-workspace",
        title="Google Workspace MCP",
        capabilities=("gmail", "calendar", "drive", "docs", "sheets"),
        keywords=("gmail", "calendar", "meeting", "docs", "sheets", "drive", "workspace"),
    ),
    McpServerProfile(
        server_id="slack-collab",
        title="Slack MCP",
        capabilities=("slack", "channels", "messages"),
        keywords=("slack", "channel", "thread", "workspace", "message"),
    ),
    McpServerProfile(
        server_id="notion-knowledge",
        title="Notion MCP",
        capabilities=("notion", "pages", "databases"),
        keywords=("notion", "page", "database", "wiki", "knowledge"),
    ),
    McpServerProfile(
        server_id="crm-operations",
        title="CRM MCP",
        capabilities=("crm", "contacts", "deals", "tickets"),
        keywords=("salesforce", "hubspot", "crm", "contact", "deal", "ticket"),
    ),
)


def recommend_mcp_servers(prompt: str, current_url: str = "", limit: int = 3) -> list[McpServerProfile]:
    text = f"{prompt} {current_url}".lower()
    tokens = {token for token in re.split(r"[^a-z0-9]+", text) if len(token) > 2}
    ranked: list[tuple[int, McpServerProfile]] = []
    for profile in SERVER_PROFILES:
        overlap = tokens & set(profile.keywords)
        if not overlap:
            continue
        ranked.append((len(overlap), profile))
    ranked.sort(key=lambda row: row[0], reverse=True)
    return [profile for _, profile in ranked[:limit]]

