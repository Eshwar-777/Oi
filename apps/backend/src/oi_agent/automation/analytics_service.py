from __future__ import annotations

from datetime import UTC, datetime

from oi_agent.automation.models import (
    AutomationEngineAnalyticsItem,
    AutomationEngineAnalyticsResponse,
    RuntimeIncidentAnalyticsItem,
    RuntimeIncidentAnalyticsResponse,
)
from oi_agent.automation.store import list_run_transitions, list_runs


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt.astimezone(UTC)
    except Exception:
        return None


def _round_ratio(value: float) -> float:
    return round(value, 4)


def _as_int(value: object) -> int:
    return value if isinstance(value, int) else 0


def _site_from_incident(row: dict[str, object]) -> str:
    runtime_incident = row.get("runtime_incident", {})
    if not isinstance(runtime_incident, dict):
        return "unknown"
    browser_snapshot = runtime_incident.get("browser_snapshot", {})
    url = ""
    if isinstance(browser_snapshot, dict):
        url = str(browser_snapshot.get("url", "") or "")
    if not url:
        return "unknown"
    try:
        from urllib.parse import urlparse

        hostname = urlparse(url).hostname or ""
        return hostname or "unknown"
    except Exception:
        return "unknown"


async def get_automation_engine_analytics(limit: int = 500) -> AutomationEngineAnalyticsResponse:
    rows = await list_runs(limit=limit)
    buckets: dict[str, dict[str, object]] = {}

    for row in rows:
        engine = str(row.get("automation_engine", "agent_browser") or "agent_browser")
        bucket = buckets.setdefault(
            engine,
            {
                "automation_engine": engine,
                "total_runs": 0,
                "completed_runs": 0,
                "failed_runs": 0,
                "human_paused_runs": 0,
                "local_runner_runs": 0,
                "server_runner_runs": 0,
                "duration_values": [],
                "last_run_at": None,
            },
        )
        bucket["total_runs"] = _as_int(bucket["total_runs"]) + 1

        state = str(row.get("state", "") or "")
        if state in {"completed", "succeeded"}:
            bucket["completed_runs"] = _as_int(bucket["completed_runs"]) + 1
        elif state in {"failed", "cancelled", "canceled", "timed_out"}:
            bucket["failed_runs"] = _as_int(bucket["failed_runs"]) + 1

        executor_mode = str(row.get("executor_mode", "") or "")
        if executor_mode == "local_runner":
            bucket["local_runner_runs"] = _as_int(bucket["local_runner_runs"]) + 1
        elif executor_mode == "server_runner":
            bucket["server_runner_runs"] = _as_int(bucket["server_runner_runs"]) + 1

        created_at = _parse_iso(str(row.get("created_at", "") or ""))
        updated_at = _parse_iso(str(row.get("updated_at", "") or ""))
        if created_at and updated_at and updated_at >= created_at:
            durations = bucket["duration_values"]
            assert isinstance(durations, list)
            durations.append((updated_at - created_at).total_seconds())

        last_run_at = _parse_iso(str(row.get("updated_at", "") or ""))
        previous_last = _parse_iso(bucket["last_run_at"]) if isinstance(bucket["last_run_at"], str) else None
        if last_run_at and (previous_last is None or last_run_at > previous_last):
            bucket["last_run_at"] = last_run_at.isoformat()

        run_id = str(row.get("run_id", "") or "")
        if run_id:
            transitions = await list_run_transitions(run_id)
            if any(str(item.get("to_state", "") or "") == "waiting_for_human" for item in transitions):
                bucket["human_paused_runs"] = _as_int(bucket["human_paused_runs"]) + 1

    items: list[AutomationEngineAnalyticsItem] = []
    for engine, bucket in buckets.items():
        total_runs = _as_int(bucket["total_runs"])
        completed_runs = _as_int(bucket["completed_runs"])
        failed_runs = _as_int(bucket["failed_runs"])
        human_paused_runs = _as_int(bucket["human_paused_runs"])
        durations = bucket["duration_values"]
        assert isinstance(durations, list)
        avg_duration = round(sum(durations) / len(durations), 2) if durations else None
        items.append(
            AutomationEngineAnalyticsItem(
                automation_engine=engine,  # type: ignore[arg-type]
                total_runs=total_runs,
                completed_runs=completed_runs,
                failed_runs=failed_runs,
                human_paused_runs=human_paused_runs,
                local_runner_runs=_as_int(bucket["local_runner_runs"]),
                server_runner_runs=_as_int(bucket["server_runner_runs"]),
                success_rate=_round_ratio(completed_runs / total_runs) if total_runs else 0.0,
                failure_rate=_round_ratio(failed_runs / total_runs) if total_runs else 0.0,
                human_pause_rate=_round_ratio(human_paused_runs / total_runs) if total_runs else 0.0,
                avg_duration_seconds=avg_duration,
                last_run_at=bucket["last_run_at"] if isinstance(bucket["last_run_at"], str) else None,
            )
        )

    order = {"agent_browser": 0}
    items.sort(key=lambda item: (order.get(item.automation_engine, 1), -(item.total_runs or 0), item.automation_engine))
    return AutomationEngineAnalyticsResponse(items=items)


async def get_runtime_incident_analytics(limit: int = 500) -> RuntimeIncidentAnalyticsResponse:
    rows = await list_runs(limit=limit)
    buckets: dict[tuple[str, str, str], dict[str, object]] = {}

    for row in rows:
        runtime_incident = row.get("runtime_incident", {})
        if not isinstance(runtime_incident, dict):
            continue
        incident_code = str(runtime_incident.get("code", "") or "")
        category = str(runtime_incident.get("category", "") or "")
        if not incident_code or not category:
            continue
        site = _site_from_incident(row)
        key = (incident_code, category, site)
        bucket = buckets.setdefault(
            key,
            {
                "incident_code": incident_code,
                "category": category,
                "site": site,
                "total_runs": 0,
                "waiting_for_human_runs": 0,
                "reconciliation_runs": 0,
                "engines": {},
                "last_seen_at": None,
            },
        )
        bucket["total_runs"] = _as_int(bucket["total_runs"]) + 1

        state = str(row.get("state", "") or "")
        if state == "waiting_for_human":
            bucket["waiting_for_human_runs"] = _as_int(bucket["waiting_for_human_runs"]) + 1
        if state == "reconciling":
            bucket["reconciliation_runs"] = _as_int(bucket["reconciliation_runs"]) + 1

        engine = str(row.get("automation_engine", "agent_browser") or "agent_browser")
        engines = bucket["engines"]
        assert isinstance(engines, dict)
        current_engine_runs = engines.get(engine, 0)
        engines[engine] = _as_int(current_engine_runs) + 1

        updated_at = _parse_iso(str(row.get("updated_at", "") or ""))
        previous_last = _parse_iso(bucket["last_seen_at"]) if isinstance(bucket["last_seen_at"], str) else None
        if updated_at and (previous_last is None or updated_at > previous_last):
            bucket["last_seen_at"] = updated_at.isoformat()

    items = [
        RuntimeIncidentAnalyticsItem(
            incident_code=str(bucket["incident_code"]),
            category=str(bucket["category"]),  # type: ignore[arg-type]
            site=str(bucket["site"]),
            total_runs=_as_int(bucket["total_runs"]),
            waiting_for_human_runs=_as_int(bucket["waiting_for_human_runs"]),
            reconciliation_runs=_as_int(bucket["reconciliation_runs"]),
            engines=dict(bucket["engines"]) if isinstance(bucket["engines"], dict) else {},
            last_seen_at=bucket["last_seen_at"] if isinstance(bucket["last_seen_at"], str) else None,
        )
        for bucket in buckets.values()
    ]
    items.sort(key=lambda item: (-item.total_runs, item.site, item.incident_code))
    return RuntimeIncidentAnalyticsResponse(items=items)
