---
id: entity-selection-and-activation
title: Entity Selection And Activation
summary: Open the intended person, record, result, row, or thread before editing or submitting inside it.
hosts:
keywords: find, search, select, choose, open, activate, result, record, contact, person, recipient, chat, thread, row, ticket, lead, issue
---
# Entity Selection And Activation

- When the user names a person, record, issue, contact, thread, or result, treat that identity as a required context switch.
- Do not assume that a matching search result means the target is already active.
- If the target is still visible as a selectable result, row, or list item, open it before any downstream edit, reply, send, submit, or save action.
- Prefer exact visible label matches over partial matches when multiple similar entities are present.
- After selection, verify that the active header, page title, detail panel, or result-list state reflects the intended entity.
- If the target remains visible in the source result list after the click and the active context did not change, stop and re-snapshot instead of continuing.
