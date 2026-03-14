# Managed Server Runner

This backend can launch a browser runner on the server host and register it as a `server_runner` session.

## Required environment

Add these values in `apps/backend/.env` or your deployment environment:

```env
RUNNER_SHARED_SECRET=replace-me
SERVER_RUNNER_ENABLED=true
SERVER_RUNNER_COMMAND=pnpm --dir apps/frontend/desktop runner:headless
```

Then set one of:

```env
SERVER_RUNNER_CHROME_PATH=/absolute/path/to/chrome
```

or:

```env
SERVER_RUNNER_CDP_URL=http://127.0.0.1:9222
```

Optional overrides:

```env
SERVER_RUNNER_CWD=/absolute/path/to/repo
SERVER_RUNNER_API_BASE_URL=http://127.0.0.1:8080
SERVER_RUNNER_BOOTSTRAP_URL=https://example.com
SERVER_RUNNER_START_TIMEOUT_SECONDS=30
```

## What the UI does

- `Start remote browser` calls `POST /browser/server-runner/start`
- `Stop` calls `POST /browser/server-runner/stop`
- the session page polls `GET /browser/server-runner`

The backend manages one remote runner per user.

## Failure modes

- `Managed remote browser is not enabled on this backend.`
  - Set `SERVER_RUNNER_ENABLED=true`
- `Timed out while starting the managed remote browser.`
  - Check `SERVER_RUNNER_CHROME_PATH` or `SERVER_RUNNER_CDP_URL`
  - Confirm the command in `SERVER_RUNNER_COMMAND` works on the host
- `Managed remote browser exited during startup.`
  - Check backend logs for runner stdout/stderr
  - Verify `RUNNER_SHARED_SECRET` matches the backend setting
- Session stays `idle`
  - Confirm the runner can reach `SERVER_RUNNER_API_BASE_URL`
  - Confirm the backend is reachable from the spawned process

## Verification

- Focused route test:
  - `cd apps/backend && make test-managed-runner`
- Full backend suite:
  - `cd apps/backend && make test`
- UI smoke test:
  - Open the sessions page
  - Confirm the remote browser card is visible
  - Start the remote browser
  - Confirm `oi_managed_runner_events_total{origin="server_runner",event="start_succeeded"}` increments

## Operational notes

- The spawned runner uses a dedicated user data dir under `/tmp/oi-server-runner-<runner_id>`
- The backend terminates managed runners on app shutdown
- This path assumes the backend host is trusted to run a browser process
