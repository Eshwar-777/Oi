---
id: commerce-checkout
title: Safe Checkout Guardrails
summary: Keep checkout and purchase flows deterministic, conservative, and confirmation-aware.
hosts:
keywords: checkout, cart, payment, buy, purchase, order, shipping, billing, review
---
# Safe Checkout Guardrails

- Prefer deterministic refs for payment, shipping, and confirm controls.
- Never click destructive or financially binding controls unless the plan explicitly requires it and user confirmation has been obtained.
- Re-check totals, item count, and destination before the final submit.
- If multiple call-to-action buttons exist, target the one whose label matches the current stage exactly.
- If modal dialogs or payment overlays appear, resolve them first and then capture a fresh state before continuing.

