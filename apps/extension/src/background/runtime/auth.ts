import {
  DEFAULT_RELAY_WS_URL,
  STORAGE_KEY_AUTH_REFRESH_URL,
  STORAGE_KEY_AUTH_RENEWAL,
  STORAGE_KEY_AUTH_TOKEN,
  STORAGE_KEY_FIREBASE_CONFIG,
} from "./constants";

export async function getOrCreateDeviceId(): Promise<string> {
  const result = await chrome.storage.local.get("oi_device_id");
  if (result.oi_device_id) return result.oi_device_id;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ oi_device_id: id });
  return id;
}

export async function getRelayUrl(): Promise<string> {
  const stored = await chrome.storage.local.get("oi_relay_ws_url");
  const url = stored.oi_relay_ws_url as string | undefined;
  return url && url.startsWith("ws") ? url : DEFAULT_RELAY_WS_URL;
}

export async function getAuthToken(): Promise<string> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_AUTH_TOKEN);
  return String(stored[STORAGE_KEY_AUTH_TOKEN] ?? "");
}

function relayBaseHttpUrl(relayWsUrl: string): string {
  if (relayWsUrl.startsWith("wss://")) return relayWsUrl.replace("wss://", "https://").replace(/\/ws$/, "");
  if (relayWsUrl.startsWith("ws://")) return relayWsUrl.replace("ws://", "http://").replace(/\/ws$/, "");
  return relayWsUrl.replace(/\/ws$/, "");
}

async function refreshTokenViaFirebase(refreshToken: string, apiKey: string): Promise<string | null> {
  try {
    const form = new URLSearchParams();
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", refreshToken);
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    const idToken = String(body.id_token ?? "");
    const newRefresh = String(body.refresh_token ?? refreshToken);
    if (!idToken) return null;
    await chrome.storage.local.set({
      [STORAGE_KEY_AUTH_TOKEN]: idToken,
      [STORAGE_KEY_AUTH_RENEWAL]: newRefresh,
    });
    return idToken;
  } catch {
    return null;
  }
}

async function refreshTokenViaEndpoint(
  refreshUrl: string,
  currentToken: string,
  deviceId: string,
): Promise<string | null> {
  try {
    const res = await fetch(refreshUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: currentToken, device_id: deviceId }),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    const token = String(body.token ?? body.id_token ?? "");
    if (!token) return null;
    await chrome.storage.local.set({ [STORAGE_KEY_AUTH_TOKEN]: token });
    if (body.refresh_token) {
      await chrome.storage.local.set({ [STORAGE_KEY_AUTH_RENEWAL]: String(body.refresh_token) });
    }
    return token;
  } catch {
    return null;
  }
}

export async function attemptAuthRefresh(deviceId: string): Promise<boolean> {
  const stored = await chrome.storage.local.get([
    STORAGE_KEY_AUTH_TOKEN,
    STORAGE_KEY_AUTH_RENEWAL,
    STORAGE_KEY_FIREBASE_CONFIG,
    STORAGE_KEY_AUTH_REFRESH_URL,
    "oi_relay_ws_url",
  ]);
  const currentToken = String(stored[STORAGE_KEY_AUTH_TOKEN] ?? "");
  const refreshToken = String(stored[STORAGE_KEY_AUTH_RENEWAL] ?? "");
  const apiKey = String(stored[STORAGE_KEY_FIREBASE_CONFIG] ?? "");
  const explicitRefreshUrl = String(stored[STORAGE_KEY_AUTH_REFRESH_URL] ?? "");

  if (refreshToken && apiKey) {
    const token = await refreshTokenViaFirebase(refreshToken, apiKey);
    if (token) return true;
  }

  const relayWs = String(stored.oi_relay_ws_url ?? DEFAULT_RELAY_WS_URL);
  const refreshUrl = explicitRefreshUrl || `${relayBaseHttpUrl(relayWs)}/api/auth/refresh`;
  const token = await refreshTokenViaEndpoint(refreshUrl, currentToken, deviceId);
  return Boolean(token);
}
