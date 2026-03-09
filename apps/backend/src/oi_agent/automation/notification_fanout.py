from __future__ import annotations

import logging
from typing import Any

from oi_agent.automation.notification_preferences_service import get_user_notification_preferences
from oi_agent.automation.store import get_browser_session, get_run
from oi_agent.mesh.broadcaster import EventBroadcaster

logger = logging.getLogger(__name__)

_broadcaster = EventBroadcaster()


def _build_notification_route(run_id: str, browser_session_id: str | None) -> str:
    if browser_session_id:
        return f"/sessions?session_id={browser_session_id}&run_id={run_id}"
    return f"/chat?run_id={run_id}"


async def fanout_automation_notification(event: dict[str, Any]) -> None:
    event_type = str(event.get("type", "") or "")
    if event_type not in {"run.waiting_for_human", "run.runtime_incident", "run.reconciliation_requested"}:
        return

    run_id = str(event.get("run_id", "") or "")
    if not run_id:
        return
    run = await get_run(run_id)
    if not run:
        return

    browser_session_id = str(run.get("browser_session_id", "") or "") or None
    if not browser_session_id:
        return
    browser_session = await get_browser_session(browser_session_id)
    user_id = str((browser_session or {}).get("user_id", "") or "")
    if not user_id:
        return

    payload = dict(event.get("payload", {}) or {})
    route = _build_notification_route(run_id, browser_session_id)
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
                "event_type": event_type,
                "reason_code": str(payload.get("reason_code", "") or ""),
            },
            high_priority=False,
            suppress_push_if_connected=preferences.connected_device_only_for_noncritical,
            desktop_enabled=preferences.desktop_enabled,
            browser_enabled=preferences.browser_enabled,
            mobile_push_enabled=preferences.mobile_push_enabled,
        )


async def safe_fanout_automation_notification(event: dict[str, Any]) -> None:
    try:
        await fanout_automation_notification(event)
    except Exception:
        logger.warning("Automation notification fanout failed", exc_info=True)
