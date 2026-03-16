# Remote Browser Container Architecture

This document defines the production design for user-owned remote browser sessions using one warm container per active user.

## Goal

The user should be able to click `Create remote session` in the UI and get a ready remote browser session without managing infrastructure details manually.

## Chosen model

Use one warm container per active user.

Why:
- stronger isolation than a shared multi-user browser host
- simpler security model
- persistent sign-in state is practical
- lower latency than one cold container per task
- operationally much easier to reason about than many users inside one browser node

Do not use one giant browser container for all users.

## Product behavior

1. User clicks `Create remote session`.
2. Backend checks whether the user already has a warm remote container.
3. If one exists and is healthy, backend reuses it.
4. If not, backend provisions a dedicated browser container for that user.
5. The container starts Chromium and the headless runner.
6. The runner registers back to the backend as `origin=server_runner`.
7. The session appears in the existing sessions UI.
8. User can inspect, live-view, take control, and run tasks against that remote browser.

## Isolation guarantees

Each user gets:
- a dedicated container instance
- a dedicated Chromium user-data directory
- a dedicated workspace directory
- a dedicated session and runner identity
- no inbound public access to the container

Every request path must enforce `session.user_id == current_user.uid`.

## Production topology

### Control plane

The existing backend remains the control plane.

Responsibilities:
- auth and user identity
- session records
- runner records
- container lifecycle orchestration
- quotas and admission control
- idle timeout and cleanup
- metrics and audit

### Data plane

Each user container runs:
- Chromium with remote debugging enabled
- the existing runner CLI
- optional per-user task workspace

The runner connects back to the backend using the existing registration and websocket flow.

## Recommended GCP deployment

Use Cloud Run for the first production version.

Why:
- fastest to ship
- simple per-user service instance model
- built-in autoscaling
- no cluster ops
- easy private service-to-service auth

Use one Cloud Run service image for the remote browser worker.

Per active user:
- maintain one warm instance
- keep it alive while the user is active
- stop it after idle timeout

If you later need stronger control over warm pools or long-running browser workers, move the data plane to GKE Autopilot. Do not start there unless Cloud Run proves insufficient.

## Container image contents

The remote browser worker image should contain:
- Chromium
- fonts and browser runtime dependencies
- `@oi/desktop` built artifacts
- a small entrypoint script

Entrypoint responsibilities:
- create per-user profile/workspace directories
- launch Chromium with remote debugging
- launch `node dist/runnerCli.js`
- pass required env vars
- expose only internal health endpoints if needed

## Required env for each worker

```env
OI_RUNNER_ENABLED=1
OI_RUNNER_ORIGIN=server_runner
OI_RUNNER_API_URL=https://<backend>
OI_RUNNER_SECRET=<runner_shared_secret>
OI_RUNNER_USER_ID=<user_id>
OI_RUNNER_ID=server-runner-<user_id_hash>
OI_RUNNER_LABEL=Remote browser
OI_RUNNER_CHROME_PATH=/usr/bin/chromium
OI_RUNNER_CHROME_USER_DATA_DIR=/data/chrome-profile
OI_RUNNER_BOOTSTRAP_URL=https://example.com
```

## Browser persistence

Persistent state should be per user.

Recommended:
- `/data/chrome-profile` mounted from a user-scoped persistent volume or object-backed restore path
- `/data/workspace` mounted from a user-scoped persistent volume

If persistence is not ready by tomorrow:
- ship with ephemeral profile storage
- clearly label remote sessions as temporary
- add persistence in the next pass

## Provisioning flow

Add a container provisioner behind the current managed-runner abstraction.

### New backend responsibilities

The current `ServerRunnerManager` assumes the backend host launches the runner directly. Replace or extend it with a provisioner-backed manager:

- `ensure_user_remote_container(user_id)`
- `get_user_remote_container_status(user_id)`
- `stop_user_remote_container(user_id)`

The manager should:
- derive a stable user container name
- create the worker if missing
- wait for worker health
- return runner/session state through the existing managed-runner routes

### Proposed state machine

- `idle`
- `provisioning`
- `starting`
- `ready`
- `stopping`
- `error`

Expose these through `GET /browser/server-runner`.

## Auth and ownership model

### Session ownership

Browser session rows already carry `user_id`.

Enforce:
- only owner can list/open/control that session
- runner registers exactly one owner user id
- backend rejects runner attempts to rebind to a different user

### Worker trust

For tomorrow:
- keep `RUNNER_SHARED_SECRET`
- require the worker to reach backend over private/internal networking if possible

Immediately after launch:
- replace static runner secret with short-lived signed bootstrap tokens minted per provision request

Recommended bootstrap token contents:
- `user_id`
- `runner_id`
- `origin=server_runner`
- `exp`
- signature

## API design

Keep the existing UI contract.

Current endpoints already fit:
- `GET /browser/server-runner`
- `POST /browser/server-runner/start`
- `POST /browser/server-runner/stop`

Behind them:
- backend should provision or reuse the user’s warm worker
- backend should not spawn a local process on the backend host in production

## UI behavior

The user-facing flow should be:
- button label: `Create remote session`
- status states:
  - `Creating your remote browser...`
  - `Warming up your browser...`
  - `Remote browser ready`
  - `Could not start remote browser`

Do not show infrastructure terms like container, runner, CDP, or origin in the primary UX.

## Capacity planning

Start with conservative per-user limits:
- CPU: 1 vCPU
- Memory: 2 GiB minimum, 4 GiB preferred for Gmail/Docs/heavier sites
- Ephemeral disk: 4-8 GiB if profile is restored from durable storage

Admission control:
- max 1 warm remote browser per user
- max N active remote browsers globally based on budget
- queue or reject when capacity is exhausted

## Cleanup policy

Idle timeout:
- stop worker after 20-30 minutes of inactivity

Hard TTL:
- recycle worker after 8-12 hours

On stop:
- flush profile/workspace if persistence enabled
- mark session `stopped`
- emit metrics

## Observability

Track at minimum:
- provision requests
- provision failures
- warm reuse count
- cold starts
- time to ready
- unexpected worker exits
- remote browser idle evictions
- per-user active container count
- Chromium crash count

## What should ship tomorrow

Tomorrow’s production cut should include:

1. UI copy change
- Rename `Start remote browser` to `Create remote session`.

2. Backend manager split
- Introduce a production provisioner path behind the existing managed-runner endpoints.

3. Cloud Run worker image
- Browser + runner image with Chromium and built desktop runner artifacts.

4. User-scoped worker identity
- Stable user container naming and runner identity.

5. Basic quotas and cleanup
- One warm worker per user
- Idle timeout

6. Metrics and logs
- Container create/reuse/fail/stop

## Suggested implementation plan

### Phase 1: Tomorrow

- keep existing frontend flow
- keep existing managed-runner routes
- swap backend process-spawn logic for a provisioner call
- provision one user-scoped warm worker
- worker starts Chromium + runner and registers session

### Phase 2: Next

- signed bootstrap tokens instead of static runner secret
- persistent profile/workspace
- explicit resume behavior for returning users
- better cleanup and budget enforcement

### Phase 3: Later

- warm pool optimization
- GKE if Cloud Run limits become a problem
- multi-region placement

## Concrete recommendation

For production tomorrow:
- one warm Cloud Run worker per active user
- one Chromium profile per user worker
- one runner per user worker
- backend-managed reuse and idle shutdown
- no multi-user browser containers

That is the fastest design that is still defensible on security, isolation, and operability.
