---
id: search-results
title: Search And Results Navigation
summary: Use search fields and result lists in a stable two-phase flow.
hosts:
keywords: search, results, query, filters, list, result, compose, new, find
---
# Search And Results Navigation

- Treat search as two phases: fill the query field, then act on the result list.
- Prefer textbox/searchbox refs for query entry.
- After search submission, wait for result list stabilization before clicking a result.
- When multiple similar results exist, match exact visible label or role+name rather than partial text only.
- For message or compose flows, do not merge recipient lookup with message-body filling into one target.
- If a named person, record, or thread appears in the result list, open that result before typing into any downstream editor.
- Before sending, replying, or editing inside a selected context, verify that the active header or page state reflects the intended target identity.
