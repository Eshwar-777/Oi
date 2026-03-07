from __future__ import annotations

import logging
from typing import Any

from oi_agent.mesh.device_registry import DeviceRegistry

logger = logging.getLogger(__name__)

_fcm_available = False


def _get_fcm_sender() -> Any:
    """Get the Firebase messaging module for sending push notifications."""
    global _fcm_available
    try:
        from firebase_admin import messaging  # type: ignore[import-untyped]

        _fcm_available = True
        return messaging
    except Exception:
        _fcm_available = False
        return None


class EventBroadcaster:
    """Broadcasts task events to all devices in a mesh group.

    Uses two channels:
    - Firestore document updates (clients subscribe with onSnapshot)
    - FCM push notifications (wakes up backgrounded mobile apps)
    """

    def __init__(self) -> None:
        self._device_registry = DeviceRegistry()

    async def broadcast_task_update(
        self,
        mesh_group_id: str,
        task_id: str,
        status: str,
        message: str,
        extra_data: dict[str, Any] | None = None,
    ) -> None:
        """Send a task update to all devices in the mesh group.

        The Firestore document update happens elsewhere (in the graph nodes).
        This method handles FCM push notifications for mobile devices.
        """
        devices = await self._device_registry.get_mesh_group_devices(mesh_group_id)

        fcm_tokens = [
            d["fcm_token"]
            for d in devices
            if d.get("fcm_token") and d.get("device_type") in ("mobile", "desktop")
        ]

        if fcm_tokens:
            await self._send_fcm_notifications(
                tokens=fcm_tokens,
                title="OI Task Update",
                body=message,
                data={
                    "task_id": task_id,
                    "status": status,
                    **(extra_data or {}),
                },
            )

        logger.info(
            "Broadcast task update: task=%s status=%s devices=%d fcm=%d",
            task_id,
            status,
            len(devices),
            len(fcm_tokens),
        )

    async def broadcast_action_needed(
        self,
        mesh_group_id: str,
        task_id: str,
        reason: str,
        screenshot_url: str | None = None,
    ) -> None:
        """Send an urgent 'action needed' notification to all mesh devices."""
        devices = await self._device_registry.get_mesh_group_devices(mesh_group_id)

        fcm_tokens = [d["fcm_token"] for d in devices if d.get("fcm_token")]

        if fcm_tokens:
            await self._send_fcm_notifications(
                tokens=fcm_tokens,
                title="OI needs your help",
                body=reason,
                data={
                    "task_id": task_id,
                    "status": "blocked",
                    "action_required": "true",
                    "screenshot_url": screenshot_url or "",
                },
                high_priority=True,
            )

    async def _send_fcm_notifications(
        self,
        tokens: list[str],
        title: str,
        body: str,
        data: dict[str, str] | None = None,
        high_priority: bool = False,
    ) -> None:
        """Send FCM push notifications to a list of device tokens."""
        messaging = _get_fcm_sender()
        if messaging is None:
            logger.warning("FCM not available, skipping push notifications")
            return

        notification = messaging.Notification(title=title, body=body)
        android_config = messaging.AndroidConfig(
            priority="high" if high_priority else "normal"
        )

        for token in tokens:
            try:
                message = messaging.Message(
                    notification=notification,
                    data=data or {},
                    token=token,
                    android=android_config,
                )
                messaging.send(message)
            except Exception as exc:
                logger.warning("FCM send failed for token %s: %s", token[:10], exc)
