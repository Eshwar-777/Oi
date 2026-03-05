---
name: curate-execution-selector
description: Decide API-first vs browser UI execution for Curate plans and enforce browser prerequisites. Use when deciding whether a task can run via tools directly or needs extension-driven navigation.
---

# Curate Execution Selector

## Goal

Choose the correct execution path:
- API path for direct tool-capable actions (`send_email`, `web_search`, `summarizer`, `weather_check`, `market_tracker`)
- Browser path when real UI interaction is required (forms, clicks, posting on websites, checkout flows)

## Decision Steps

1. Check if outcome is achievable with available API tools.
2. If yes, set:
   - `requires_browser = false`
   - `prerequisites = []`
3. If no, set:
   - `requires_browser = true`
   - include browser prerequisites

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
