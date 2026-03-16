from __future__ import annotations

import logging
from typing import Any

from oi_agent.automation.conversation_service import get_conversation_session_state
from oi_agent.automation.notification_preferences_service import get_user_notification_preferences
from oi_agent.automation.store import get_run
from oi_agent.mesh.broadcaster import EventBroadcaster
from oi_agent.observability.metrics import record_notification_delivery_failure

logger = logging.getLogger(__name__)

_broadcaster = EventBroadcaster()


def _build_notification_route(run_id: str, browser_session_id: str | None, conversation_id: str | None) -> str:
    if conversation_id:
        params = [f"conversation_id={conversation_id}", f"run_id={run_id}"]
        if browser_session_id:
            params.append(f"session_id={browser_session_id}")
        return f"/chat?{'&'.join(params)}"
    if browser_session_id:
        return f"/sessions?session_id={browser_session_id}&run_id={run_id}"
    return f"/chat?run_id={run_id}"


async def fanout_automation_notification(event: dict[str, Any]) -> None:
    event_type = str(event.get("type", "") or "")
    if event_type not in {
        "run.waiting_for_human",
        "run.runtime_incident",
        "run.reconciliation_requested",
        "run.completed",
        "run.failed",
        "schedule.created",
    }:
        return

    run_id = str(event.get("run_id", "") or "")
    if not run_id and event_type != "schedule.created":
        return

    run = await get_run(run_id) if run_id else None
    browser_session_id = str((run or {}).get("browser_session_id", "") or "") or None
    user_id = str(event.get("user_id", "") or (run or {}).get("user_id", "") or "")
    if not user_id:
        record_notification_delivery_failure(channel="fanout")
        return

    payload = dict(event.get("payload", {}) or {})
    conversation_id: str | None = None
    session_id = str(event.get("session_id", "") or (run or {}).get("session_id", "") or "")
    if session_id:
        try:
            session_state = await get_conversation_session_state(user_id, session_id)
            conversation_id = str(session_state.conversation_id or "") or None
        except Exception:
            conversation_id = None
    route = "/schedules" if event_type == "schedule.created" else _build_notification_route(run_id, browser_session_id, conversation_id)
    preferences = await get_user_notification_preferences(user_id)

    if event_type == "run.waiting_for_human":
        if preferences.urgency_mode == "none":
            return
        title = "Automation needs review"
        body = str(payload.get("reason", "") or "The browser automation is waiting for human review.")
        data = {
            "route": route,
            "run_id": run_id,
            "browser_session_id": browser_session_id,
            "conversation_id": conversation_id,
            "event_type": event_type,
            "reason_code": str(payload.get("reason_code", "") or ""),
        }
        await _broadcaster.broadcast_user_notification(
            user_id=user_id,
            title=title,
            body=body,
            data=data,
            high_priority=True,
            suppress_push_if_connected=False,
            desktop_enabled=preferences.desktop_enabled,
            browser_enabled=preferences.browser_enabled,
            mobile_push_enabled=preferences.mobile_push_enabled,
        )
        return

    if event_type == "run.runtime_incident":
        incident = dict(payload.get("incident", {}) or {})
        if bool(incident.get("requires_human")):
            return
        if preferences.urgency_mode in {"important_only", "none"}:
            return
        code = str(incident.get("code", "") or "RUNTIME_INCIDENT")
        summary = str(incident.get("summary", "") or "The browser automation hit a runtime incident.")
        await _broadcaster.broadcast_user_notification(
            user_id=user_id,
            title=code.replace("_", " "),
            body=summary,
            data={
                "route": route,
                "run_id": run_id,
                "browser_session_id": browser_session_id,
                "conversation_id": conversation_id,
                "event_type": event_type,
                "incident_code": code,
            },
            high_priority=False,
            suppress_push_if_connected=preferences.connected_device_only_for_noncritical,
            desktop_enabled=preferences.desktop_enabled,
            browser_enabled=preferences.browser_enabled,
            mobile_push_enabled=preferences.mobile_push_enabled,
        )
        return

    if event_type == "run.reconciliation_requested":
        if preferences.urgency_mode in {"important_only", "none"}:
            return
        await _broadcaster.broadcast_user_notification(
            user_id=user_id,
            title="Automation is replanning",
            body=str(payload.get("reason", "") or "The browser changed and the agent is reconciling the remaining steps."),
            data={
                "route": route,
                "run_id": run_id,
                "browser_session_id": browser_session_id,
                "conversation_id": conversation_id,
                "event_type": event_type,
                "reason_code": str(payload.get("reason_code", "") or ""),
            },
            high_priority=False,
            suppress_push_if_connected=preferences.connected_device_only_for_noncritical,
            desktop_enabled=preferences.desktop_enabled,
            browser_enabled=preferences.browser_enabled,
            mobile_push_enabled=preferences.mobile_push_enabled,
        )
        return

    if event_type == "schedule.created":
        if preferences.urgency_mode == "none":
            return
        run_times = list(payload.get("run_times", []) or [])
        when = str(run_times[0] if run_times else "" or "").strip()
        body = f"Scheduled for {when}." if when else "A computer-use task was scheduled."
        await _broadcaster.broadcast_user_notification(
            user_id=user_id,
            title="Schedule created",
            body=body,
            data={
                "route": route,
                "session_id": session_id,
                "conversation_id": conversation_id,
                "schedule_id": str(payload.get("schedule_id", "") or ""),
                "event_type": event_type,
            },
            high_priority=False,
            suppress_push_if_connected=preferences.connected_device_only_for_noncritical,
            desktop_enabled=preferences.desktop_enabled,
            browser_enabled=preferences.browser_enabled,
            mobile_push_enabled=preferences.mobile_push_enabled,
        )
        return

    if event_type == "run.completed":
        if preferences.urgency_mode == "none":
            return
        body = str(payload.get("message", "") or payload.get("summary", "") or "The automation finished successfully.")
        await _broadcaster.broadcast_user_notification(
            user_id=user_id,
            title="Automation completed",
            body=body,
            data={
                "route": route,
                "run_id": run_id,
                "browser_session_id": browser_session_id,
                "conversation_id": conversation_id,
                "event_type": event_type,
            },
            high_priority=False,
            suppress_push_if_connected=preferences.connected_device_only_for_noncritical,
            desktop_enabled=preferences.desktop_enabled,
            browser_enabled=preferences.browser_enabled,
            mobile_push_enabled=preferences.mobile_push_enabled,
        )
        return

    if event_type == "run.failed":
        if preferences.urgency_mode == "none":
            return
        body = str(payload.get("error", "") or "The automation failed.")
        await _broadcaster.broadcast_user_notification(
            user_id=user_id,
            title="Automation failed",
            body=body,
            data={
                "route": route,
                "run_id": run_id,
                "browser_session_id": browser_session_id,
                "conversation_id": conversation_id,
                "event_type": event_type,
                "reason_code": str(payload.get("code", "") or ""),
            },
            high_priority=True,
            suppress_push_if_connected=False,
            desktop_enabled=preferences.desktop_enabled,
            browser_enabled=preferences.browser_enabled,
            mobile_push_enabled=preferences.mobile_push_enabled,
        )


async def safe_fanout_automation_notification(event: dict[str, Any]) -> None:
    try:
        await fanout_automation_notification(event)
    except Exception:
        logger.warning("Automation notification fanout failed", exc_info=True)
