---
name: curate-execution-selector
description: Decide API-first vs MCP vs browser UI execution for Curate plans and enforce browser prerequisites. Use when deciding whether a task can run via direct tools, MCP integrations, or extension-driven navigation.
---

# Curate Execution Selector

## Goal

Choose the correct execution path:
- API path for direct tool-capable actions
- MCP path when a connected app integration can replace brittle UI work
- Browser path when real UI interaction is required (forms, clicks, posting on websites, checkout flows)

## Decision Steps

1. Check if outcome is achievable with available API tools.
2. If not, check if an MCP integration matches the app/workflow:
   - use `mcp_capability_advisor` to see whether the task maps to a supported server
3. If yes, set:
   - `requires_browser = false`
   - `execution_path = "mcp"`
4. If API is enough, set:
   - `requires_browser = false`
   - `execution_path = "api"`
5. If neither API nor MCP fits, set:
   - `requires_browser = true`
   - `execution_path = "browser"`
   - `prerequisites = []`

## Browser Prerequisites

For browser plans, include at minimum:
- `Open the relevant browser tab`
- `Install and connect the Oi extension`

Optionally add:
- `Sign in to the target app`
- `Keep the tab in foreground during Run now`

## User Messaging

When browser prerequisites are missing, return actionable instructions in one short message:
- what is missing
- what to open/install
- how to retry (`Run now` after prerequisites)
