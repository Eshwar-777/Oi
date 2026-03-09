---
name: ui-navigator
description: Drive a live browser session through the session-based UI navigator. Use for real-time browser tasks that require navigation, click, type, extraction, streaming, and human takeover within a connected browser session.
---

# UI Navigator

## Use this for

- Tasks that need real website interaction in a browser session
- Cases where API-only tools are insufficient

## Pre-run requirements

Before execution:
- Ensure a local or server runner is connected
- Ensure a browser session is visible in the session registry
- Use the live session when human review or takeover is needed

## Control API

Use session-based browser endpoints:
- `GET /browser/sessions` to inspect connected browser sessions
- `POST /browser/sessions/{session_id}/control` for navigation and stream refresh
- `POST /browser/sessions/{session_id}/controller/acquire` to take control
- `POST /browser/sessions/{session_id}/input` for remote input
- `GET /browser/sessions/{session_id}/stream` for live session frames

If no browser session is available, return a user-facing instruction to start or reconnect a local/server runner before retrying.
