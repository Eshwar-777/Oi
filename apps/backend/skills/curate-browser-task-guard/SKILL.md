---
name: curate-browser-task-guard
description: Guard real-time browser tasks with prerequisite checks and human-readable fallback prompts. Use when running UI tasks that depend on open tabs, extension connection, login state, or manual intervention points.
---

# Curate Browser Task Guard

## Goal

Protect UI task runs from brittle failure by validating runtime readiness before browser execution.

## Pre-Run Checklist

Validate in order:
1. A browser session/tab is available for the target app
2. Oi extension is connected
3. User session state is valid (signed in if required)

If any check fails:
- stop browser execution early
- produce a clear next-step instruction
- keep run resumable via `Run now`

## Failure Message Template

Use compact format:
- `This task runs in your browser.`
- `Missing: <tab|extension|login>.`
- `Do this: <exact next steps>.`
- `Then click Run now again.`

## Human-in-the-Loop Triggers

Escalate to consult/handoff for:
- CAPTCHA
- 2FA / MFA
- payments
- identity confirmation
