# Staging Dashboards And Alerts

This is the first dashboard and alert pack to stand up before pushing OI to production.

## Dashboard 1: API Health

- Requests per minute by route
- p50 / p95 / p99 latency by route
- 4xx and 5xx rate by route
- Auth failure count

## Dashboard 2: Chat And Automation Funnel

- Chat turn requests
- Chat turn failures
- Runs created
- Runs by state
- Waiting-for-human events by reason code
- Runtime incidents by incident code

## Dashboard 3: Realtime Health

- Event stream connections
- Event stream reconnect spikes
- Desktop runner websocket disconnects
- Managed remote browser starts vs failures
- Managed remote browser unexpected exits
- Notification fanout failures

## Dashboard 4: Notification Delivery

- Notifications sent by channel
- Notification delivery failures by channel
- Browser vs desktop vs mobile split

## Dashboard 5: Model Platform

- Gemini model discovery failures
- Chat turn volume by selected model
- Request latency and failure rate once model-call instrumentation is expanded

## Alert Rules

- API 5xx rate over 2% for 5 minutes
- p95 request latency over 2 seconds for 10 minutes
- Waiting-for-human event spike above normal baseline
- Notification fanout failure count above 0 for 10 minutes
- Event stream connections drop sharply after deploy
- Gemini model discovery fallback triggered in staging or production
- Managed remote browser `start_failed` or `start_timeout` events above 0 for 10 minutes
- Managed remote browser `process_exited` events above baseline

## Tomorrow Deployment Checklist

- Confirm `/metrics` is reachable from the scraper
- Confirm `prometheus-client` is installed in the backend image
- Verify one notification reaches web, desktop, and mobile
- Verify a notification clicked from cold start lands in the correct conversation
- Verify model listing returns Vertex-discovered models in the configured location
- Verify `oi_managed_runner_events_total{origin="server_runner",event="start_succeeded"}` increments after launching a remote browser
- Verify a failed remote-browser launch increments `start_failed` or `start_timeout`
