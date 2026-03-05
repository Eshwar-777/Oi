---
name: curate-intent-router
description: Classify Curate requests into task, automation, or cron and generate a normalized plan contract. Use when user intent is ambiguous, when converting natural language into trigger/action config, or when users say "now", "every X", or "when Y happens".
---

# Curate Intent Router

## Goal

Map a user request to one of:
- `task`: one-off or real-time work, typically `trigger.type = manual`
- `automation`: event/condition/change driven flow
- `cron`: time schedule flow (`trigger.type = time_based`)

## Routing Rules

1. If user says `now`, `right away`, `immediately`, `once`, `run now`:
   - choose `kind = task`
   - choose `trigger.type = manual`
2. If user gives schedule phrases (`every day`, `every monday`, `at 8am`, `every 5 hours`):
   - choose `kind = cron`
   - choose `trigger.type = time_based`
3. If user asks for `when X happens`, thresholds, change watching, or event reactions:
   - choose `kind = automation`
   - choose event/condition/change trigger
4. If no time/event signal exists:
   - default to `kind = task` and `manual`

## Output Contract

Always return/construct:
- `kind`
- `requires_browser` (boolean)
- `prerequisites` (list; usually empty for API tasks)
- `trigger`
- `action`
- `data_sources`

Never invent unrelated goals (for example, do not switch email intent into social content intent).
