from __future__ import annotations

from datetime import UTC, datetime

from oi_agent.automation.models import (
    NotificationPreferences,
    NotificationPreferencesUpdateRequest,
)
from oi_agent.automation.store import get_notification_preferences, save_notification_preferences


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def get_user_notification_preferences(user_id: str) -> NotificationPreferences:
    row = await get_notification_preferences(user_id)
    if row:
        return NotificationPreferences.model_validate(row)
    return NotificationPreferences(user_id=user_id, updated_at=_now_iso())


async def update_user_notification_preferences(
    user_id: str,
    payload: NotificationPreferencesUpdateRequest,
) -> NotificationPreferences:
    preferences = NotificationPreferences(
        user_id=user_id,
        desktop_enabled=payload.desktop_enabled,
        browser_enabled=payload.browser_enabled,
        mobile_push_enabled=payload.mobile_push_enabled,
        connected_device_only_for_noncritical=payload.connected_device_only_for_noncritical,
        urgency_mode=payload.urgency_mode,
        updated_at=_now_iso(),
    )
    await save_notification_preferences(user_id, preferences.model_dump(mode="json"))
    return preferences
