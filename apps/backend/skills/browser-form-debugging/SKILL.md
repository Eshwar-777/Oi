---
name: browser-form-debugging
description: Diagnose and recover failed browser form interactions using aria snapshots, structured extracts, target resolution, and recovery planning. Use when type/select/click steps fail on forms or inputs.
---

# Browser Form Debugging

## Use this for

- Type/select actions that fail even though the field looks visible
- Cases where the wrong wrapper gets clicked instead of the actual input/select
- Ambiguous field targeting in complex forms

## Workflow

1. Inspect the latest page snapshot with `snapshot_debugger`.
2. If the field is still unclear, inspect `structured_context` and run `form_target_resolver` with:
   - `query`: the field label the agent is trying to use
   - `action`: `type` or `select`
3. Prefer targets in this order:
   - snapshot `ref`
   - `id`
   - `aria-label`
   - `name`
   - associated `<label>`
   - `placeholder`
4. If a step already failed, run `recovery_planner` from the current state instead of retrying the stale plan.

## Guardrails

- Do not fall back to raw coordinates for form fields.
- Do not treat decorative wrappers as valid form targets.
- Verify value/selected state before marking the field step as complete.

