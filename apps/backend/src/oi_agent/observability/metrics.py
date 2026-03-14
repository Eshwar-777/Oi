from __future__ import annotations

try:
    from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
except Exception:  # pragma: no cover - fallback for environments without prometheus_client installed yet.
    CONTENT_TYPE_LATEST = "text/plain; version=0.0.4; charset=utf-8"

    class _NoopMetric:
        def labels(self, **_: str) -> "_NoopMetric":
            return self

        def inc(self, *_: object, **__: object) -> None:
            return None

        def observe(self, *_: object, **__: object) -> None:
            return None

    def Counter(*_: object, **__: object) -> _NoopMetric:  # type: ignore[misc]
        return _NoopMetric()

    def Histogram(*_: object, **__: object) -> _NoopMetric:  # type: ignore[misc]
        return _NoopMetric()

    def generate_latest() -> bytes:
        return b"# prometheus_client not installed\n"

http_requests_total = Counter(
    "oi_http_requests_total",
    "Total HTTP requests handled by the backend.",
    ["method", "route", "status_code"],
)

http_request_duration_ms = Histogram(
    "oi_http_request_duration_ms",
    "HTTP request latency in milliseconds.",
    ["method", "route"],
    buckets=(5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000),
)

chat_turn_requests_total = Counter(
    "oi_chat_turn_requests_total",
    "Total chat turn requests.",
    ["model", "source"],
)

chat_turn_failures_total = Counter(
    "oi_chat_turn_failures_total",
    "Total failed chat turn requests.",
    ["model", "source"],
)

automation_events_total = Counter(
    "oi_automation_events_total",
    "Total automation events published.",
    ["event_type"],
)

automation_runs_total = Counter(
    "oi_automation_runs_total",
    "Total automation runs created.",
    ["execution_mode", "executor_mode", "automation_engine", "state"],
)

notifications_sent_total = Counter(
    "oi_notifications_sent_total",
    "Total notifications sent.",
    ["channel", "event_type"],
)

notifications_delivery_failures_total = Counter(
    "oi_notifications_delivery_failures_total",
    "Total notification delivery failures.",
    ["channel"],
)

event_stream_connections_total = Counter(
    "oi_event_stream_connections_total",
    "Total event stream connections accepted.",
    ["surface"],
)

llm_model_discovery_failures_total = Counter(
    "oi_llm_model_discovery_failures_total",
    "Total model discovery failures.",
    ["provider"],
)

managed_runner_events_total = Counter(
    "oi_managed_runner_events_total",
    "Total managed runner lifecycle events.",
    ["origin", "event"],
)


def record_http_request(*, method: str, route: str, status_code: int, duration_ms: float) -> None:
    labels = {
        "method": method.upper(),
        "route": route or "unknown",
        "status_code": str(status_code),
    }
    http_requests_total.labels(**labels).inc()
    http_request_duration_ms.labels(method=labels["method"], route=labels["route"]).observe(max(duration_ms, 0.0))


def record_chat_turn_request(*, model: str, source: str) -> None:
    chat_turn_requests_total.labels(model=model or "auto", source=source or "chat_api").inc()


def record_chat_turn_failure(*, model: str, source: str) -> None:
    chat_turn_failures_total.labels(model=model or "auto", source=source or "chat_api").inc()


def record_automation_event(event_type: str) -> None:
    automation_events_total.labels(event_type=event_type or "unknown").inc()


def record_run_created(*, execution_mode: str, executor_mode: str, automation_engine: str, state: str) -> None:
    automation_runs_total.labels(
        execution_mode=execution_mode or "unknown",
        executor_mode=executor_mode or "unknown",
        automation_engine=automation_engine or "unknown",
        state=state or "unknown",
    ).inc()


def record_notification_sent(*, channel: str, event_type: str) -> None:
    notifications_sent_total.labels(channel=channel or "unknown", event_type=event_type or "unknown").inc()


def record_notification_delivery_failure(*, channel: str) -> None:
    notifications_delivery_failures_total.labels(channel=channel or "unknown").inc()


def record_event_stream_connection(*, surface: str) -> None:
    event_stream_connections_total.labels(surface=surface or "unknown").inc()


def record_model_discovery_failure(*, provider: str) -> None:
    llm_model_discovery_failures_total.labels(provider=provider or "unknown").inc()


def record_managed_runner_event(*, origin: str, event: str) -> None:
    managed_runner_events_total.labels(origin=origin or "unknown", event=event or "unknown").inc()


def render_metrics() -> tuple[bytes, str]:
    return generate_latest(), CONTENT_TYPE_LATEST
