# Production Metrics MVP

This is the minimum metrics layer needed to push OI to production safely with the current stack.

## Goals

- Detect broken user flows within minutes.
- Measure latency and failure rate across chat, runs, notifications, and realtime streams.
- Create enough signal to debug incidents without full tracing on day one.

## Metrics To Ship First

### API and auth

- `http_requests_total`
  - labels: `route`, `method`, `status_code`
- `http_request_duration_ms`
  - labels: `route`, `method`
- `auth_session_failures_total`
  - labels: `reason`

### Chat and conversation

- `chat_turn_requests_total`
  - labels: `model`, `source`
- `chat_turn_failures_total`
  - labels: `reason`
- `chat_turn_duration_ms`
  - labels: `model`
- `conversation_hydration_failures_total`

### Automation runs

- `automation_runs_total`
  - labels: `state`, `execution_mode`, `executor_mode`
- `automation_run_transitions_total`
  - labels: `from_state`, `to_state`
- `automation_run_duration_ms`
  - labels: `terminal_state`
- `automation_waiting_for_human_total`
  - labels: `reason_code`
- `automation_runtime_incidents_total`
  - labels: `incident_code`, `requires_human`

### Scheduler

- `automation_schedules_created_total`
  - labels: `execution_mode`, `timezone`
- `automation_schedule_due_lag_ms`
  - labels: `execution_mode`
- `automation_schedule_missed_total`

### Notifications

- `notifications_sent_total`
  - labels: `channel`, `event_type`
- `notifications_delivery_failures_total`
  - labels: `channel`
- `notifications_clickthrough_total`
  - labels: `channel`, `route_type`

### Realtime and runner health

- `event_stream_connections_total`
  - labels: `surface`
- `event_stream_reconnects_total`
  - labels: `surface`
- `runner_ws_connect_total`
- `runner_ws_disconnect_total`
  - labels: `reason`
- `runner_heartbeat_failures_total`
- `managed_runner_events_total`
  - labels: `origin`, `event`
  - expected events: `start_succeeded`, `start_failed`, `start_timeout`, `start_reused`, `start_in_progress`, `stop_requested`, `process_exited`

### Model platform

- `llm_requests_total`
  - labels: `provider`, `model`
- `llm_request_duration_ms`
  - labels: `provider`, `model`
- `llm_request_failures_total`
  - labels: `provider`, `model`, `reason`
- `llm_model_discovery_failures_total`
  - labels: `provider`

## Implementation Plan

## Phase 1: Backend counters and histograms

- Add FastAPI middleware for request count and duration.
- Instrument chat turn handlers, run transitions, schedule creation, and notification fanout.
- Emit Prometheus-compatible counters and histograms.
- Expose a `/metrics` endpoint behind internal auth or private networking.

## Phase 2: Frontend operational telemetry

- Emit lightweight events for notification clicks, chat scroll-to-latest usage, and event stream reconnects.
- Send these to a backend ingestion endpoint or analytics sink already approved for production.

## Phase 3: Dashboards and alerts

- API health dashboard: p95 latency, 5xx rate, auth failures.
- Automation dashboard: runs started/completed/failed, waiting-for-human rate, incident rate.
- Realtime dashboard: active streams, reconnect spikes, runner disconnect spikes.
- Managed browser dashboard: start success/failure rate, timeout count, unexpected exit count.
- Model dashboard: latency, failure rate, fallback-to-configured-models events.

## Alert Thresholds

- API 5xx rate over 2% for 5 minutes.
- Runner disconnect spike above baseline.
- Managed remote browser start failures above 0 for 10 minutes after deploy.
- Managed remote browser unexpected exits above baseline.
- `run.waiting_for_human` spike by reason code.
- Model discovery fallback triggered in production.
- Scheduler due-lag p95 above 60 seconds.

## Recommended Stack

- Backend: Prometheus or OpenTelemetry metrics exporter in FastAPI.
- Infra: scrape from Cloud Run / container metrics target, forward to Grafana Cloud, Managed Prometheus, or GCP Cloud Monitoring.
- Frontend: send product telemetry through a small authenticated ingestion endpoint instead of direct vendor SDK sprawl on day one.
