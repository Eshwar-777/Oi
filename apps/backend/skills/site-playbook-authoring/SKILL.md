---
name: site-playbook-authoring
description: Add or refine local site playbooks that improve browser planning for recurring apps and flows. Use when an app has repeated interaction patterns and the planner needs grounded execution hints.
---

# Site Playbook Authoring

## Goal

Create or update files under `apps/backend/playbooks/` so browser planning gets reusable, app-aware hints before generating steps.

## Format

Each playbook is a markdown file with frontmatter:

```md
---
id: example-flow
title: Example Flow
summary: One-line planning hint.
hosts: example.com, app.example.com
keywords: login, compose, submit
---
```

Then add short guidance bullets.

## What to include

- Stable interaction phases for the app
- Safe target priorities
- Known blockers or modal patterns
- Re-planning rules after state changes

## What not to include

- Long prose
- Product marketing copy
- Site-specific secrets or credentials
- Steps that require guessing hidden UI state

