import { toApiUrl } from "./api";
import { emitApiError, getErrorMessage } from "./apiErrors";

interface DesktopRegistration {
  deviceId: string;
  deviceName: string;
}

async function getDesktopRegistration(): Promise<DesktopRegistration | null> {
  if (typeof window === "undefined" || !window.electronAPI?.getDesktopDeviceRegistration) {
    return null;
  }

  const registration = await window.electronAPI.getDesktopDeviceRegistration();
  if (!registration?.deviceId || !registration?.deviceName) {
    return null;
  }
  return registration;
}

async function patchDesktopDevice(
  registration: DesktopRegistration,
  payload: { device_name?: string; is_online?: boolean },
  keepalive = false,
): Promise<void> {
  const response = await fetch(toApiUrl(`/devices/${encodeURIComponent(registration.deviceId)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive,
  });
  if (!response.ok) {
    throw new Error(`Desktop device update failed with status ${response.status}`);
  }
}

async function markDesktopOnline(registration: DesktopRegistration): Promise<void> {
  await patchDesktopDevice(registration, {
    device_name: registration.deviceName,
    is_online: true,
  });
}

async function markDesktopOffline(registration: DesktopRegistration, keepalive = false): Promise<void> {
  await patchDesktopDevice(
    registration,
    {
      device_name: registration.deviceName,
      is_online: false,
    },
    keepalive,
  );
}

export async function ensureDesktopDeviceRegistered(): Promise<DesktopRegistration | null> {
  const registration = await getDesktopRegistration();
  if (!registration) {
    return null;
  }
  const response = await fetch(toApiUrl("/devices/register"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_id: registration.deviceId,
      device_type: "desktop",
      device_name: registration.deviceName,
    }),
  });
  if (!response.ok) {
    throw new Error(`Desktop device registration failed with status ${response.status}`);
  }
  await markDesktopOnline(registration);
  return registration;
}

export function setupDesktopPresenceLifecycle(registration: DesktopRegistration | null): () => void {
  if (typeof window === "undefined" || !registration) {
    return () => {};
  }

  const markOffline = () => {
    void markDesktopOffline(registration, true).catch(() => {});
  };
  const heartbeat = window.setInterval(() => {
    void markDesktopOnline(registration).catch((error) => {
      window.clearInterval(heartbeat);
      emitApiError(getErrorMessage(error, "Desktop device presence sync failed."));
    });
  }, 60_000);
  const removeQuitListener =
    typeof window.electronAPI?.onAppWillQuit === "function"
      ? window.electronAPI.onAppWillQuit(() => {
          markOffline();
        })
      : () => {};

  window.addEventListener("beforeunload", markOffline);
  window.addEventListener("pagehide", markOffline);

  return () => {
    window.clearInterval(heartbeat);
    removeQuitListener();
    window.removeEventListener("beforeunload", markOffline);
    window.removeEventListener("pagehide", markOffline);
    markOffline();
  };
}
