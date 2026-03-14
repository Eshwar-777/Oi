# Managed Server Runner

This backend can create a `server_runner` session in two ways:

- `local_process`: spawn the runner on the backend host
- `cloud_run`: provision or reuse one Cloud Run worker per active user

## Required environment

Add these values in `apps/backend/.env` or your deployment environment:

```env
RUNNER_SHARED_SECRET=replace-me
SERVER_RUNNER_ENABLED=true
SERVER_RUNNER_BACKEND=local_process
SERVER_RUNNER_API_BASE_URL=https://backend.example.com
SERVER_RUNNER_BOOTSTRAP_URL=https://example.com
SERVER_RUNNER_START_TIMEOUT_SECONDS=30
```

### Local-process backend

```env
SERVER_RUNNER_COMMAND=pnpm --dir apps/frontend/desktop runner:headless
SERVER_RUNNER_CWD=/absolute/path/to/repo
```

Set one of:

```env
SERVER_RUNNER_CHROME_PATH=/absolute/path/to/chrome
```

or:

```env
SERVER_RUNNER_CDP_URL=http://127.0.0.1:9222
```

### Cloud Run backend

```env
SERVER_RUNNER_BACKEND=cloud_run
SERVER_RUNNER_CLOUD_RUN_SERVICE_PREFIX=oi-remote-session
SERVER_RUNNER_CLOUD_RUN_WORKER_IMAGE=us-central1-docker.pkg.dev/<project>/<repo>/remote-browser-worker:latest
SERVER_RUNNER_CLOUD_RUN_SERVICE_ACCOUNT=remote-browser-worker@<project>.iam.gserviceaccount.com
SERVER_RUNNER_CLOUD_RUN_CPU=1
SERVER_RUNNER_CLOUD_RUN_MEMORY=2Gi
SERVER_RUNNER_CLOUD_RUN_TIMEOUT_SECONDS=3600
SERVER_RUNNER_CLOUD_RUN_MIN_INSTANCES=1
SERVER_RUNNER_CLOUD_RUN_MAX_INSTANCES=1
SERVER_RUNNER_CLOUD_RUN_INGRESS=internal
```

Worker image contract:

- listen on `PORT`
- keep the container alive
- launch Chromium
- launch the headless runner with the `OI_RUNNER_*` env passed by the backend
- use `/data/chrome-profile` as the browser profile path

Repo artifact for that image:

- Dockerfile: [apps/frontend/desktop/Dockerfile.remote-worker](/Users/yandrapue/.codex/worktrees/9194/Oi/apps/frontend/desktop/Dockerfile.remote-worker)
- Worker entrypoint: [remoteWorker.ts](/Users/yandrapue/.codex/worktrees/9194/Oi/apps/frontend/desktop/src/remoteWorker.ts)

Example build:

```bash
docker build -f apps/frontend/desktop/Dockerfile.remote-worker -t us-central1-docker.pkg.dev/<project>/<repo>/remote-browser-worker:latest .
```

Repo helper:

```bash
GCP_PROJECT_ID=<project> \
GCP_REGION=us-central1 \
ARTIFACT_REGISTRY_REPO=oi-prod \
IMAGE_TAG=$(date +%Y%m%d-%H%M%S) \
bash ./scripts/build-and-push-remote-images.sh all
```

What `all` builds:

- backend image
- remote browser worker image
- automation runtime image

These are separate production services. The backend image does not embed the automation runtime service.

One-command stack deploy helper:

```bash
GCP_PROJECT_ID=<project> \
GCP_REGION=us-central1 \
ARTIFACT_REGISTRY_REPO=oi-prod \
FRONTEND_ORIGIN=https://<your-frontend-origin> \
RUNNER_SHARED_SECRET=<runner-secret> \
AUTOMATION_RUNTIME_SHARED_SECRET=<runtime-secret> \
bash ./scripts/deploy-cloud-run-stack.sh prod
```

That script:

- ensures required GCP APIs, Artifact Registry, and service accounts exist
- builds and pushes backend, remote worker, and automation-runtime images
- deploys automation-runtime first
- deploys backend with the runtime URL and remote worker image wired in
- smoke-checks backend and runtime health

## What the UI does

- `Create remote session` calls `POST /browser/server-runner/start`
- `Stop` calls `POST /browser/server-runner/stop`
- the session page polls `GET /browser/server-runner`

The backend manages one remote session worker per user.

## Failure modes

- `Remote sessions are not enabled on this backend.`
  - Set `SERVER_RUNNER_ENABLED=true`
  - Confirm the selected backend has its required settings
- `Timed out while creating the remote session.`
  - For `local_process`, check `SERVER_RUNNER_CHROME_PATH` or `SERVER_RUNNER_CDP_URL`
  - For `cloud_run`, check the worker image startup and Cloud Run service logs
- `Remote session worker exited during startup.`
  - For `local_process`, check backend logs for runner stdout/stderr
  - Verify `RUNNER_SHARED_SECRET` matches the backend setting
- `Remote session worker request failed: ...`
  - Confirm backend ADC/service account can administer Cloud Run
  - Confirm `SERVER_RUNNER_CLOUD_RUN_WORKER_IMAGE` and service account are valid
- Session stays `idle`
  - Confirm the runner can reach `SERVER_RUNNER_API_BASE_URL`
  - Confirm the backend is reachable from the spawned worker

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
- The local-process backend terminates managed runners on app shutdown
- The Cloud Run backend provisions one service per active user and deletes it on stop
- The Cloud Run worker path assumes the worker image handles HTTP health and keeps the container alive
