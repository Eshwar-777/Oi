# Backend Automation Architecture

## Purpose

This document describes the current backend architecture for the Oi automation system after the phased refactor that introduced:

- structured automation conversation APIs
- unified `IntentDraft`, `AutomationPlan`, and `AutomationRun` models
- typed events and artifacts
- unified immediate and scheduled execution runtime
- first-class automation schedules under `/api/schedules`

It is intended to give the team one reference for runtime flow, ownership boundaries, persistence, and the remaining legacy migration path.

## High-level system

The backend is a FastAPI service rooted in `src/oi_agent/main.py`.

Main runtime surfaces:

- `api/routes.py`
  Legacy chat/device endpoints.
- `api/automation_routes.py`
  New automation-native API surface for chat turns, execution resolution, run control, and schedules.
- `api/browser/*`
  Browser automation and navigator endpoints, including temporary compatibility routes.
- `api/websocket.py`
  Device/extension WebSocket entrypoint.
- `automation/*`
  New automation domain models, services, runtime, event bus, persistence, and schedules.
- `services/tools/browser_automation.py`
  Browser execution bridge to the extension.

## Core domain model

### IntentDraft

Represents understanding of a user request before execution.

Important fields:

- `intent_id`
- `session_id`
- `user_goal`
- `goal_type`
- `missing_fields`
- `timing_mode`
- `decision`
- `requires_confirmation`
- `risk_flags`

Produced by:

- `POST /api/chat/turn`

### AutomationPlan

Represents an approved automation plan independent of whether it was triggered immediately or by schedule.

Important fields:

- `plan_id`
- `intent_id`
- `execution_mode`
- `summary`
- `targets`
- `steps`
- `requires_confirmation`

Produced by:

- `POST /api/chat/resolve-execution`
- internal scheduled-run creation flow

### AutomationRun

Represents a concrete execution instance.

Important fields:

- `run_id`
- `plan_id`
- `session_id`
- `state`
- `execution_mode`
- `current_step_index`
- `total_steps`
- `scheduled_for`
- `last_error`

Run states:

- `draft`
- `awaiting_clarification`
- `awaiting_execution_mode`
- `awaiting_confirmation`
- `scheduled`
- `queued`
- `running`
- `paused`
- `waiting_for_user_action`
- `retrying`
- `completed`
- `failed`
- `cancelled`
- `expired`

### AutomationSchedule

Represents a first-class scheduled automation owned by the new automation layer.

Important fields:

- `schedule_id`
- `user_id`
- `session_id`
- `prompt`
- `execution_mode`
- `run_at`
- `interval_seconds`
- `device_id`
- `tab_id`
- `status`
- `next_run_at`
- `claimed_at`
- `claimed_by`

Supported execution modes for schedules:

- `once`
- `interval`
- `multi_time`

## Runtime flow

### 1. Chat turn understanding

Entry:

- `POST /api/chat/turn`

Flow:

1. frontend sends normalized multimodal input parts
2. backend builds a combined semantic request
3. `automation/intent_service.py` classifies the request
4. backend returns:
   - `assistant_message`
   - `intent_draft`
   - `suggested_next_actions`
5. typed events are emitted:
   - `understanding.started`
   - `understanding.completed`
   - optionally clarification / execution-mode / confirmation events

### 2. Execution resolution

Entry:

- `POST /api/chat/resolve-execution`

Flow:

1. backend loads the stored `IntentDraft`
2. backend determines execution mode and creates `AutomationPlan`
3. backend creates `AutomationRun`
4. if immediate and non-sensitive:
   - run is queued
   - execution starts
5. if sensitive:
   - run remains in `awaiting_confirmation`

### 3. Confirmation

Entry:

- `POST /api/chat/confirm`

Flow:

1. confirmation updates run state
2. immediate confirmed runs move to `queued`
3. runtime starts execution

### 4. Execution

Runtime entrypoint:

- `automation/executor.py`

Flow:

1. resolve device/tab target
2. capture snapshot context
3. rewrite prompt
4. call browser step planner
5. update plan steps with normalized execution steps
6. execute via `BrowserAutomationTool`
7. update run progress and artifacts
8. publish typed events throughout

Important event types:

- `run.created`
- `run.queued`
- `run.started`
- `step.started`
- `step.completed`
- `step.failed`
- `run.paused`
- `run.resumed`
- `run.waiting_for_user_action`
- `run.interrupted_by_user`
- `run.completed`
- `run.failed`
- `schedule.created`

### 5. Scheduled execution

Primary schedule API:

- `GET /api/schedules`
- `POST /api/schedules`
- `DELETE /api/schedules/{schedule_id}`

Scheduler loop:

- `api/browser/schedule_runner.py`

Flow:

1. scheduler lists due automation schedules
2. schedule is claimed with `claimed_by`
3. scheduler creates `AutomationPlan` and `AutomationRun`
4. scheduler executes the run through the same runtime as immediate execution
5. schedule advances `next_run_at` or completes/fails

## Persistence model

Primary persistence is Firestore-first with in-memory fallback for local development and tests.

### Automation domain collections

Implemented in `automation/store.py`:

- `automation_intents`
- `automation_plans`
- `automation_runs`
- `automation_artifacts`
- `automation_events`

### Automation schedules collection

Implemented in `automation/schedule_service.py`:

- `automation_schedules`

### Remaining browser collections

- `users/{uid}/navigator_runs`
- device/user collections used by auth and extension linkage

## API contracts

### Chat / understanding

- `POST /api/chat/turn`

Returns:

- `assistant_message`
- `intent_draft`
- `suggested_next_actions`

### Execution resolution

- `POST /api/chat/resolve-execution`

Returns:

- `assistant_message`
- `plan`
- `run`
- `status`

### Confirmation

- `POST /api/chat/confirm`

Returns:

- `assistant_message`
- `plan`
- `run`

### Run inspection and control

- `GET /api/runs/{run_id}`
- `POST /api/runs/{run_id}/pause`
- `POST /api/runs/{run_id}/resume`
- `POST /api/runs/{run_id}/stop`
- `POST /api/runs/{run_id}/retry`
- `POST /api/runs/{run_id}/interrupt`

### Events

- `GET /api/events`
- `GET /api/events/stream`

### Schedules

- `GET /api/schedules`
- `POST /api/schedules`
- `DELETE /api/schedules/{schedule_id}`

## Control semantics

Run-state validation is enforced in `automation/state_machine.py`.

Important rules:

- `pause` only from `queued`, `running`, `retrying`
- `resume` only from `paused`, `waiting_for_user_action`
- `stop` only from active or scheduled states
- `retry` only from terminal error-like states
- `interrupt` only from active states

Extension control mapping:

- pause / interrupt -> `yield_control`
- resume -> `resume_automation`

## Error and waiting-state semantics

The runtime distinguishes:

- `failed`
  Unrecoverable or non-manual execution failure.
- `paused`
  User/system explicitly paused the run.
- `waiting_for_user_action`
  Manual resolution required, such as:
  - CAPTCHA
  - security gate
  - OTP / MFA
  - login required
  - payment confirmation
  - permission gate

This distinction matters for frontend UX and retry/resume semantics.

## Scheduling direction

Scheduling is now unified on the automation runtime.

- scheduler loop only processes `automation_schedules`
- `/api/schedules` is the primary schedule API
- `/browser/agent/schedules` now proxies only to the automation schedule service for compatibility with older browser clients

There is no longer a legacy `navigator_schedules` execution path.

## Operational caveats

The system is materially improved, but these constraints still apply:

- scheduler and execution still live in the FastAPI process
- Firestore writes are not fully transactionally strict for claiming
- SSE subscriber delivery is process-local even though event history is persisted
- multi-instance dispatch would need stronger claim/lease semantics

## Recommended next steps

1. Move scheduler/dispatcher into a dedicated worker process.
2. Add Firestore transaction or lease-based claim semantics for schedules.
3. Retire `/browser/agent/schedules` after frontend migration if the compatibility route is no longer needed.
4. Consider durable pub/sub for event fan-out if multiple backend instances are expected.
