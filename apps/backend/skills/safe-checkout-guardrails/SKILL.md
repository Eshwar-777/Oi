---
name: safe-checkout-guardrails
description: Enforce conservative behavior for checkout, payment, and other high-risk browser flows. Use when the browser plan touches billing, purchase confirmation, or financially binding actions.
---

# Safe Checkout Guardrails

## Use this for

- Checkout flows
- Payment forms
- Final order confirmation
- Shipping and billing review screens

## Workflow

1. Load site playbooks relevant to the commerce flow.
2. Prefer ref-based actions for critical controls.
3. Re-check order summary, quantity, total, and destination before the final action.
4. If the next click commits money or an irreversible purchase, require explicit user confirmation.
5. If overlays or payment modals appear, take a fresh snapshot and re-plan.

## Guardrails

- Never click the final purchase action on a fuzzy text match.
- Never skip explicit confirmation on financially binding steps.
- Avoid retry loops on payment widgets; escalate with current state instead.

