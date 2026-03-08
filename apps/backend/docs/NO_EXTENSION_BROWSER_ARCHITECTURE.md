# No-Extension Browser Automation Architecture

## Implementation Status

As of March 8, 2026, the active runtime in this repo is session-based:

- automation runs require a `BrowserSessionRecord`
- execution uses Playwright over a CDP-backed browser session
- live streaming, remote control, controller locking, sensitive-action gating, and session audit logging are implemented on the session path
- the desktop runner resolves browser control through a `BrowserSessionAdapter` boundary with a built-in CDP adapter

Legacy extension-era backend modules still exist on disk for reference, but they are no longer mounted on the active browser router or used by the automation executor:

- `apps/backend/src/oi_agent/api/browser/actions_routes.py`
- `apps/backend/src/oi_agent/api/browser/agent_routes.py`
- `apps/backend/src/oi_agent/api/browser/common.py`
- `apps/backend/src/oi_agent/api/browser/tabs_routes.py`
- `apps/backend/src/oi_agent/services/tools/browser_automation.py`

## Goal

Replace the old extension-driven browser automation path with a unified browser session platform built on:

- a browser-session adapter boundary for session transport, live view, remote control, and browser attachment
- Playwright for deterministic page interactions and reliable locators
- the existing backend automation domain for orchestration, scheduling, auth, human gating, and observability

This plan removes the Chrome extension from the runtime architecture. The resulting system supports:

- local user-machine browser sessions via a trusted runner
- server-hosted browser sessions
- live streaming to web/mobile/desktop
- single-controller remote takeover
- sensitive-action gating
- immediate and scheduled runs

## Current Repo Constraints

The current repo has two overlapping execution stacks:

- the typed automation runtime under `apps/backend/src/oi_agent/automation/*`
- the navigator/browser stack under `apps/backend/src/oi_agent/api/browser/*`

Today, both depend on extension-specific transport:

- `apps/backend/src/oi_agent/services/tools/browser_automation.py`
- `apps/backend/src/oi_agent/api/browser/common.py`
- `apps/backend/src/oi_agent/api/websocket_connection_manager.py`
- `apps/backend/src/oi_agent/api/websocket_frames.py`
- `apps/extension/*`

This creates four structural problems:

1. Two run models: `AutomationRun` and `navigator_runs`
2. Two schedule systems: `automation_schedules` and `navigator_schedules`
3. Two pause/resume patterns: typed run state vs `resume_token`
4. Browser control tied to a browser extension rather than a browser session abstraction

## Revised Target Architecture

```text
Web / Mobile / Desktop
    -> Backend API
        -> Automation Orchestrator
            -> Run State Machine
            -> Sensitive Action Detector
            -> Notification Fanout
            -> Scheduler
            -> Artifact + Timeline Store
            -> Browser Session Manager
                -> Local Runner Session Provider
                    -> agent-browser attach/start via CDP
                    -> local Chrome/Chromium instance
                -> Server Runner Session Provider
                    -> agent-browser start via CDP
                    -> managed Chromium instance
            -> Playwright Action Engine
                -> locator resolution
                -> actionability checks
                -> retries + recovery
```

## Product Model Change

The system no longer controls arbitrary tabs via an extension button.

Instead it controls a `BrowserSession`, which may be:

- a browser launched by the local runner
- a browser instance the local runner can attach to over CDP
- a server-hosted browser instance

This means the old concept of "attached tab" is replaced by:

- `session_id`
- `page_id`
- `controller_lock`
- `session_owner`
- `browser_origin` (`local_runner` or `server_runner`)

## Core Principles

1. One orchestrator API for all browser automation runs
2. One run state machine across immediate, scheduled, local, and server modes
3. One browser session abstraction
4. One artifact and event model
5. Playwright is the primary action executor
6. CDP is the transport and telemetry substrate
7. the browser session substrate is isolated behind interfaces so it can be swapped later

## Browser Session Abstraction

Add a new backend interface:

```python
class BrowserSession(Protocol):
    session_id: str
    origin: Literal["local_runner", "server_runner"]
    user_id: str

    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def list_pages(self) -> list[PageDescriptor]: ...
    async def get_active_page(self) -> PageDescriptor: ...
    async def get_playwright_page(self, page_id: str | None = None) -> Any: ...
    async def snapshot(self, page_id: str | None = None) -> BrowserSnapshot: ...
    async def stream_start(self) -> StreamDescriptor: ...
    async def stream_stop(self) -> None: ...
    async def dispatch_input(self, event: RemoteInputEvent) -> None: ...
    async def acquire_controller(self, actor_id: str, priority: int) -> ControllerLock: ...
    async def release_controller(self, actor_id: str) -> None: ...
    async def pause_agent(self, reason: str) -> None: ...
    async def resume_agent(self) -> None: ...
```

Add a provider abstraction:

```python
class BrowserSessionProvider(Protocol):
    async def create_session(self, request: CreateSessionRequest) -> BrowserSession: ...
    async def attach_session(self, request: AttachSessionRequest) -> BrowserSession: ...
    async def get_session(self, session_id: str) -> BrowserSession | None: ...
```

## Execution Model

The orchestrator executes runs against `BrowserSession` rather than against `device_id/tab_id`.

### Run loop

1. Create or resolve `BrowserSession`
2. Move run `QUEUED -> STARTING`
3. Capture initial page snapshot
4. Build or load declarative `AutomationPlan`
5. Move run `STARTING -> RUNNING`
6. For each step:
   - resolve target
   - validate preconditions
   - detect sensitive-action risk
   - if sensitive, pause and notify
   - execute via Playwright
   - verify postcondition
   - persist diagnostics
7. Publish terminal state and artifacts

### Run state machine

Replace the current state list for browser runs with:

- `QUEUED`
- `STARTING`
- `RUNNING`
- `WAITING_FOR_HUMAN`
- `HUMAN_CONTROLLING`
- `RESUMING`
- `SUCCEEDED`
- `FAILED`
- `CANCELED`
- `TIMED_OUT`

Persist every transition with:

- `from_state`
- `to_state`
- `reason_code`
- `reason_text`
- `actor_type`
- `actor_id`
- `timestamp`

## Browser Session Adapter Role

The browser session adapter should not own orchestration or business logic. It should be used as the browser session substrate for:

- browser lifecycle
- CDP attachment
- preview/live stream plumbing
- remote input transport
- session metadata

Playwright remains responsible for:

- locator-based actions
- frame-aware execution
- popup/page events
- downloads/uploads
- traces/screenshots

### Current implementation

The current concrete adapter is the built-in CDP adapter in:

- `apps/frontend/desktop/src/main/browserSession/cdpAdapter.ts`

The runner resolves adapters through:

- `apps/frontend/desktop/src/main/browserSession/index.ts`

This is the intended seam for a future real `agent-browser` integration without changing the backend orchestration contracts.

## Target Backend Layout

Create these modules under `apps/backend/src/oi_agent/automation`:

```text
automation/
  orchestrator/
    service.py
    policies.py
    transitions.py
    notifications.py
  sessions/
    manager.py
    models.py
    store.py
    controller_lock.py
    providers/
      agent_browser_base.py
      local_runner.py
      server_runner.py
  executors/
    browser_run_executor.py
    action_engine.py
    recovery.py
  locators/
    resolver.py
    strategies.py
    frames.py
    shadow_dom.py
    postconditions.py
  sensitive_actions/
    detector.py
    classifiers.py
    policies.py
  streaming/
    service.py
    schemas.py
    coordinate_map.py
  diagnostics/
    artifacts.py
    timeline.py
    classifiers.py
```

## Modules To Retire Or Convert

### Retire

- `apps/extension/*`
- `apps/backend/src/oi_agent/services/tools/browser_automation.py`
- extension-specific parts of `apps/backend/src/oi_agent/api/websocket_frames.py`
- extension-specific parts of `apps/backend/src/oi_agent/api/websocket_connection_manager.py`
- `apps/backend/src/oi_agent/api/browser/common.py`
- `apps/backend/src/oi_agent/api/browser/actions_routes.py`
- `apps/backend/src/oi_agent/api/browser/tabs_routes.py`
- `apps/backend/src/oi_agent/api/browser/schedule_store.py`

### Convert

- `apps/backend/src/oi_agent/api/browser/agent_routes.py`
  - becomes browser session and live-control API
- `apps/backend/src/oi_agent/automation/executor.py`
  - becomes orchestrator entrypoint
- `apps/backend/src/oi_agent/automation/run_service.py`
  - persists executor mode, session binding, and transition log
- `apps/backend/src/oi_agent/automation/schedule_service.py`
  - single source of scheduling truth
- `apps/backend/src/oi_agent/api/websocket.py`
  - remains, but for client stream/control channels and runner connections, not extension relay

## Local Runner Architecture

The replacement for the extension is a trusted local runner process.

Responsibilities:

- authenticate as a device for a user
- launch Chrome/Chromium with remote debugging enabled, or attach to an allowed CDP target
- register live local sessions with backend
- proxy `agent-browser` stream/control primitives to backend
- enforce local consent for remote control

Suggested repo location:

```text
apps/frontend/desktop/src/runner/*
```

If Electron is not the right long-term host, split later into:

```text
apps/local-runner/*
```

### Local runner session modes

- `launch_managed`
  - runner launches Chrome with a dedicated profile for Oi
  - safest and most deterministic
- `attach_existing`
  - runner attaches to an already-running Chrome exposing CDP
  - lower UX friction but less reliable

Recommendation: ship `launch_managed` first, `attach_existing` second.

## Revised APIs

### Session lifecycle

- `POST /api/browser/sessions`
- `GET /api/browser/sessions`
- `GET /api/browser/sessions/{session_id}`
- `POST /api/browser/sessions/{session_id}/attach`
- `POST /api/browser/sessions/{session_id}/stop`

### Run lifecycle

- `POST /api/runs`
- `GET /api/runs/{run_id}`
- `POST /api/runs/{run_id}/pause`
- `POST /api/runs/{run_id}/resume`
- `POST /api/runs/{run_id}/cancel`
- `POST /api/runs/{run_id}/takeover`
- `POST /api/runs/{run_id}/approve-sensitive-action`

### Streaming + control

- `WS /ws/sessions/{session_id}`
- `WS /ws/runs/{run_id}`

Supported frames:

- `stream.subscribe`
- `stream.frame`
- `stream.ack`
- `controller.acquire`
- `controller.release`
- `input.mouse`
- `input.keyboard`
- `input.wheel`
- `run.pause`
- `run.resume`
- `run.approve`

### Scheduling

Reuse `automation_schedules`, but add:

- `executor_mode`
- `session_preference`
- `runner_affinity`
- `max_concurrency`

## Shared Schemas

Add TypeScript-first contracts to `packages/shared-types`.

### Session

```ts
type BrowserSessionRecord = {
  session_id: string;
  user_id: string;
  origin: "local_runner" | "server_runner";
  provider: "agent_browser";
  status: "idle" | "starting" | "ready" | "busy" | "stopped" | "error";
  page_id?: string;
  browser_version?: string;
  viewport?: { width: number; height: number; dpr: number };
  controller_lock?: {
    actor_id: string;
    actor_type: "web" | "mobile" | "desktop" | "system";
    acquired_at: string;
    expires_at: string;
  } | null;
};
```

### Run request

```ts
type CreateRunRequest = {
  session_id?: string;
  executor_mode: "local_runner" | "server_runner";
  prompt: string;
  plan?: AutomationPlan;
  schedule_id?: string;
};
```

### Sensitive action event

```ts
type SensitiveActionEvent = {
  run_id: string;
  session_id: string;
  reason_code:
    | "LOGIN_FORM"
    | "CAPTCHA"
    | "MFA"
    | "PAYMENT"
    | "DELETE"
    | "PERMISSION_GRANT"
    | "OAUTH_CONSENT";
  url: string;
  page_id: string;
  screenshot_url?: string;
  candidate_targets: Array<{
    text?: string;
    role?: string;
    selector_hint?: string;
  }>;
};
```

### Stream handshake

```ts
type StreamHello = {
  type: "stream.hello";
  session_id: string;
  run_id?: string;
  viewport: { css_width: number; css_height: number; dpr: number };
  bitmap: { width: number; height: number };
  controller_lock: BrowserSessionRecord["controller_lock"];
};
```

## Locator Strategy

Playwright locators are primary. CDP is not the primary action layer.

Resolution order:

1. `getByRole` + accessible name
2. `getByLabel` / `getByPlaceholder`
3. stable attrs: `data-testid`, `aria-label`, `name`, `id`
4. text-based disambiguated locators
5. frame-aware DOM heuristic query
6. coordinate fallback with verification

For every action:

- wait for target readiness
- verify visibility, enabled state, and bounding-box stability
- perform hit-test when clicking
- execute action
- verify postcondition
- classify failure if postcondition fails

## Frame, Popup, and Shadow Handling

The action engine must track:

- `session_id`
- `page_id`
- `frame_id`
- `target_origin`
- `selector_strategy`

Rules:

- popups and OAuth windows become first-class page contexts
- cross-origin iframes are handled via Playwright frame APIs when possible
- open shadow roots are traversed
- closed shadow roots require AX or coordinate fallback
- captcha or blocked cross-origin auth flows immediately trigger human gating

## Remote Control Design

### Controller lock

Only one controller at a time.

Lock priority:

1. desktop
2. web
3. mobile

Rules:

- agent pauses when human control is granted
- lock expires after idle timeout
- lock release triggers `HUMAN_CONTROLLING -> RESUMING`
- all human actions are audited

### Coordinate mapping

Use a single mapping contract:

- bitmap frame size: `W x H`
- viewport css size: `vw x vh`
- DPR: `dpr`
- client render box: `rw x rh`

Map client coordinates to CSS coordinates first, then to CDP input coordinates. Never inject raw UI pixel coordinates without viewport metadata.

## Sensitive Action Gating

The current repo uses string heuristics in:

- `apps/backend/src/oi_agent/api/browser/agent_utils.py`
- `apps/backend/src/oi_agent/automation/executor.py`

Replace that with a detector pipeline:

1. pre-action semantic risk from plan step
2. DOM/AX risk scan on current page
3. URL/domain risk scan
4. post-click escalation if page transitions into a risky flow

When triggered:

- capture screenshot
- capture URL, title, DOM/AX summary
- transition to `WAITING_FOR_HUMAN`
- notify all active clients
- present `Take over`, `Approve once`, `Cancel`

Resume requires:

- fresh snapshot
- page hash comparison
- target re-resolution
- renewed actionability checks

## Observability

Persist:

- run transitions
- per-step target resolution metadata
- locator strategy used
- retry counts
- step timings
- console log tail
- network event tail
- screenshot and DOM snapshot artifacts
- human control events

Add a replay model:

- transition timeline
- screenshots
- page changes
- action metadata
- failure classification

## Security

### Auth

- session-scoped bearer tokens for viewers and controllers
- runner identity separate from end-user viewer identity
- per-session authorization checks for stream/control

### Data protection

- redact password, OTP, payment fields from logs and snapshots
- do not persist cookies or storage values in artifacts
- isolate managed browser profiles by user/session

### Runner trust

- local runner must be explicitly paired
- remote control must require user opt-in per session
- attaching to existing Chrome must require local consent

## Migration Plan

### Phase 0: Compatibility Preparation

Goals:

- stop adding features to `apps/extension`
- introduce session concepts without removing current routes
- add new shared state machine and transition log

Tasks:

- add `executor_mode` and `browser_session_id` to `AutomationRun`
- add transition persistence
- add `BrowserSessionRecord` store
- add compatibility enum values to frontend types

### Phase 1: Session Manager

Goals:

- introduce `BrowserSessionManager`
- support stub `local_runner` and `server_runner` session records

Tasks:

- add `automation/sessions/*`
- add runner-facing websocket or HTTP registration API
- add `/api/browser/sessions*`
- keep old browser routes alive, but mark them legacy

### Phase 2: Replace BrowserAutomationTool

Goals:

- stop sending step commands through extension transport
- move execution to Playwright over `BrowserSession`

Tasks:

- add `executors/browser_run_executor.py`
- add `locators/*`
- change `automation/executor.py` to call action engine
- convert `agent_routes.py` stream execution to orchestrator execution
- preserve existing SSE shape where possible during transition

### Phase 3: Streaming and Remote Control

Goals:

- move from screenshot push semantics to session stream semantics
- add controller lock and audited input injection

Tasks:

- add `streaming/service.py`
- add frame ack handling
- add `controller.acquire` and `controller.release`
- add multi-viewer support
- add reconnect semantics

### Phase 4: Sensitive Action Gating

Goals:

- replace string-match manual intervention handling with a detector pipeline

Tasks:

- add `sensitive_actions/*`
- update orchestrator transitions
- add approval/takeover endpoints
- update web/mobile/desktop to show live gating UI

### Phase 5: Remove Legacy Navigator Stores

Goals:

- fold `navigator_runs` and `navigator_schedules` into typed automation storage

Tasks:

- migrate `history_store.py` data model into automation artifacts/timeline
- delete `schedule_store.py`
- delete resume-token-only flow in favor of run state + approval/takeover controls

### Phase 6: Remove Extension

Goals:

- delete the extension package and extension-specific backend relay logic

Tasks:

- remove `apps/extension`
- remove `extension_command`, `extension_result`, `target_attached`, `target_detached` frame types
- remove extension device type from settings UI
- update docs, tests, and onboarding

## Repo-Specific File Change Plan

### Backend

- Change `apps/backend/src/oi_agent/automation/models.py`
- Change `apps/backend/src/oi_agent/automation/run_service.py`
- Change `apps/backend/src/oi_agent/automation/executor.py`
- Change `apps/backend/src/oi_agent/automation/schedule_service.py`
- Change `apps/backend/src/oi_agent/api/browser/agent_routes.py`
- Change `apps/backend/src/oi_agent/api/websocket.py`
- Change `apps/backend/src/oi_agent/api/websocket_connection_manager.py`
- Change `apps/backend/src/oi_agent/api/websocket_frames.py`
- Delete `apps/backend/src/oi_agent/services/tools/browser_automation.py`
- Delete `apps/backend/src/oi_agent/api/browser/common.py`
- Delete `apps/backend/src/oi_agent/api/browser/actions_routes.py`
- Delete `apps/backend/src/oi_agent/api/browser/tabs_routes.py`
- Delete `apps/backend/src/oi_agent/api/browser/schedule_store.py`

### Web

- Change `apps/frontend/web/src/domain/automation.ts`
- Change `apps/frontend/web/src/features/chat/ChatPage.tsx`
- Replace legacy navigator dependencies in `apps/frontend/web/legacy/*` with session-based APIs
- Add live session viewer and control lock UI

### Mobile

- Change `apps/frontend/mobile/app/(tabs)/navigator.tsx`
- Add session viewer, notifications, and takeover actions

### Desktop

- Change `apps/frontend/desktop/src/main/index.ts`
- Add runner host process and session consent UX

### Shared Types

- Change `packages/shared-types/src/websocket.ts`
- Add `packages/shared-types/src/browser-session.ts`
- Add `packages/shared-types/src/automation-plan.ts`

## What To Build First

The first shippable slice should be:

1. local runner launches managed Chrome
2. backend creates browser session record
3. orchestrator runs a simple plan against the session using Playwright
4. web shows stream preview and run timeline
5. sensitive actions pause the run and allow approve/cancel

Do not start with:

- attach-to-arbitrary-existing-Chrome as the only mode
- full multi-client takeover
- deleting all legacy routes before the new path is proven

## Immediate Next Implementation Tasks

1. Add `BrowserSessionRecord` and transition log models
2. Add `automation/sessions/manager.py`
3. Add runner registration endpoints
4. Add `BrowserSession` adapter backed by `agent-browser`
5. Replace `BrowserAutomationTool` calls in `automation/executor.py`
6. Add a minimal local-runner host in desktop
7. Add one live session page in web
8. Add one sensitive-action detector for login/password/payment/delete

## Explicit Non-Goals

- no browser extension fallback
- no captcha solving or bypass
- no raw coordinate-only automation strategy
- no new duplicate navigator storage layer
