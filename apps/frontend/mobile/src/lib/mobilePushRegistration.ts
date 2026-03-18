import * as FileSystem from "expo-file-system/legacy";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { fetchWithTimeout, getApiBaseUrl } from "@/lib/api";
import { getAuthHeaders } from "@/lib/authHeaders";
import { isExpoGo } from "@/lib/devFlags";

const REGISTRATION_FILE = `${FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? ""}oi-mobile-device-registration.json`;

export interface StoredMobileDeviceRegistration {
  deviceId: string;
  fcmToken: string;
  deviceName: string;
  updatedAt: string;
}

function defaultDeviceName() {
  if (Platform.OS === "ios") return "My iPhone";
  if (Platform.OS === "android") return "My Android";
  return "My Phone";
}

async function loadStoredRegistration(): Promise<StoredMobileDeviceRegistration | null> {
  if (!REGISTRATION_FILE) return null;
  try {
    const info = await FileSystem.getInfoAsync(REGISTRATION_FILE);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(REGISTRATION_FILE);
    return raw ? JSON.parse(raw) as StoredMobileDeviceRegistration : null;
  } catch {
    return null;
  }
}

async function saveStoredRegistration(value: StoredMobileDeviceRegistration): Promise<void> {
  if (!REGISTRATION_FILE) return;
  try {
    await FileSystem.writeAsStringAsync(REGISTRATION_FILE, JSON.stringify(value));
  } catch {
    // Ignore persistence failures to avoid blocking notification setup.
  }
}

export async function getNativePushToken(): Promise<string | null> {
  const permission = await Notifications.getPermissionsAsync();
  let finalStatus = permission.status;
  if (finalStatus !== "granted") {
    const request = await Notifications.requestPermissionsAsync();
    finalStatus = request.status;
  }
  if (finalStatus !== "granted") {
    throw new Error("Notification permission is required to receive automation alerts.");
  }

  try {
    const messagingModule = await import("@react-native-firebase/messaging");
    const messagingFactory = messagingModule.default;
    if (typeof messagingFactory === "function") {
      const messaging = messagingFactory();
      await messaging.registerDeviceForRemoteMessages();
      const token = await messaging.getToken();
      if (token) return token;
    }
  } catch {
    // Fall through to expo-notifications native device token.
  }

  const deviceToken = await Notifications.getDevicePushTokenAsync();
  const token = typeof deviceToken.data === "string" ? deviceToken.data : String(deviceToken.data || "");
  return token || null;
}

async function registerDevice(payload: {
  device_name: string;
  device_id?: string;
  fcm_token?: string;
}): Promise<{ device_id: string }> {
  const api = getApiBaseUrl();
  const res = await fetchWithTimeout(`${api}/devices/register`, {
    method: "POST",
    headers: await getAuthHeaders(),
    body: JSON.stringify({
      device_type: "mobile",
      device_name: payload.device_name,
      device_id: payload.device_id,
      fcm_token: payload.fcm_token,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof body?.detail === "string" ? body.detail : "Failed to register mobile device");
  }
  return body as { device_id: string };
}

async function patchDevice(deviceId: string, payload: {
  device_name?: string;
  fcm_token?: string;
  is_online?: boolean;
}): Promise<boolean> {
  const api = getApiBaseUrl();
  const res = await fetchWithTimeout(`${api}/devices/${encodeURIComponent(deviceId)}`, {
    method: "PATCH",
    headers: await getAuthHeaders(),
    body: JSON.stringify(payload),
  });
  if (res.ok) return true;
  if (res.status === 404) return false;
  const body = await res.json().catch(() => ({}));
  throw new Error(typeof body?.detail === "string" ? body.detail : "Failed to update mobile device");
}

export async function loadStoredMobileDeviceRegistration() {
  return await loadStoredRegistration();
}

export async function ensureMobilePushDeviceRegistration(options?: {
  deviceName?: string;
}): Promise<StoredMobileDeviceRegistration | null> {
  if (isExpoGo()) return null;
  const fcmToken = await getNativePushToken();
  if (!fcmToken) {
    throw new Error("Could not resolve a device push token on this device.");
  }

  const deviceName = options?.deviceName?.trim() || defaultDeviceName();
  const stored = await loadStoredRegistration();
  if (stored?.deviceId) {
    const updated = await patchDevice(stored.deviceId, {
      device_name: deviceName,
      fcm_token: fcmToken,
      is_online: true,
    });
    if (updated) {
      const next = {
        deviceId: stored.deviceId,
        fcmToken,
        deviceName,
        updatedAt: new Date().toISOString(),
      };
      await saveStoredRegistration(next);
      return next;
    }
  }

  const registered = await registerDevice({
    device_name: deviceName,
    device_id: stored?.deviceId,
    fcm_token: fcmToken,
  });
  const next = {
    deviceId: registered.device_id,
    fcmToken,
    deviceName,
    updatedAt: new Date().toISOString(),
  };
  await saveStoredRegistration(next);
  return next;
}
