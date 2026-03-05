---
name: ui-navigator
description: Drive an attached browser tab through the extension-backed UI navigator. Use for real-time UI tasks that require navigate, click, type, and snapshot actions, and enforce attach prerequisites before execution.
---

# UI Navigator

## Use this for

- Tasks that need real website interaction in a browser tab
- Cases where API-only tools are insufficient

## Pre-run requirements

Before execution:
- Open the relevant browser tab
- Install and connect the Oi extension
- Click the extension toolbar button to attach the tab

## Control API

Use backend browser endpoints:
- `GET /api/browser/tabs` to inspect connected + attached state
- `POST /api/browser/act` for generic actions (`navigate`, `click`, `type`, `read_dom`, `screenshot`)
- `POST /api/browser/navigate` for URL navigation
- `POST /api/browser/snapshot` for DOM snapshot

If no tab is attached, return a user-facing instruction to attach a tab and retry `Run now`.
