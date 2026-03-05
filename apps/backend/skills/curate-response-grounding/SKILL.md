---
name: curate-response-grounding
description: Keep Curate responses aligned to user intent and avoid irrelevant plan substitutions. Use when generating plan summaries, fallback plans, or clarifying ambiguous requests.
---

# Curate Response Grounding

## Goal

Prevent irrelevant outputs by grounding every proposal in explicit user intent.

## Rules

1. Mirror intent verbs and objects:
   - `write/send email` -> email action
   - `post on LinkedIn` -> social content action
2. Do not substitute domains:
   - never propose LinkedIn when the user asked for email
   - never add schedules unless user asked for recurring behavior
3. Keep explanations short and concrete:
   - what will happen
   - when it will run
   - what user must do before run (if browser task)

## Clarification Policy

Ask questions only when core execution is impossible to infer.
If the user asks for immediate execution, produce a runnable task plan first.
