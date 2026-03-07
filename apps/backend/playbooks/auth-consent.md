---
id: auth-consent
title: Login And Consent Recovery
summary: Handle sign-in gates, cookie banners, and onboarding prompts before resuming the intended task.
hosts:
keywords: login, sign in, sign-in, consent, cookie, onboarding, continue, allow, verify, authentication
---
# Login And Consent Recovery

- Detect whether the task is blocked by authentication, cookie consent, onboarding, or a security challenge.
- Safe-close banners and tours before touching the intended target.
- Never auto-solve captchas or security verification. Escalate to the user instead.
- After the user completes login or verification, capture a fresh snapshot and re-plan from the current state.
- Do not assume the original refs are still valid after auth or consent flows.

