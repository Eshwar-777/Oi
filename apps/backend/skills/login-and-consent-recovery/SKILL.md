---
name: login-and-consent-recovery
description: Recover browser automations blocked by login, cookie consent, onboarding modals, or security gates. Use when a run stops before the intended task because the app is not yet in an actionable state.
---

# Login And Consent Recovery

## Use this for

- Sign-in pages
- Cookie banners
- Onboarding tours and welcome modals
- Flows that change page structure after the user authenticates

## Workflow

1. Load matching playbooks with `site_playbook_loader`.
2. Resolve any blocker before touching the intended target.
3. If the blocker is a captcha or security verification, stop and ask the user to complete it manually.
4. After the user finishes login or verification:
   - capture a fresh snapshot
   - discard stale refs
   - run `recovery_planner` from the current state

## Guardrails

- Never auto-solve captcha or security challenges.
- Never assume a pre-login ref is valid post-login.
- Keep user messaging brief and actionable when manual intervention is required.

