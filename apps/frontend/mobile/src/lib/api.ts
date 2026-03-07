import Constants from "expo-constants";

const BACKEND_PORT = Number(process.env.EXPO_PUBLIC_API_PORT ?? "8080");
const DEFAULT_TIMEOUT_MS = 12_000;
const PAIRING_TIMEOUT_MS = 35_000;

interface ExpoConstantsWithLegacyHosts {
  expoGoConfig?: {
    debuggerHost?: string;
  };
  manifest2?: {
    extra?: {
      expoGo?: {
        debuggerHost?: string;
      };
    };
  };
}

function getDevServerHost(): string | null {
  const hostUri = Constants.expoConfig?.hostUri ?? Constants.manifest?.hostUri;
  if (hostUri) {
    return hostUri.split(":")[0] || null;
  }

  const legacyConstants = Constants as typeof Constants & ExpoConstantsWithLegacyHosts;
  const debuggerHost = legacyConstants.expoGoConfig?.debuggerHost;
  if (debuggerHost) {
    return debuggerHost.split(":")[0] || null;
  }

  const manifest2DebuggerHost = legacyConstants.manifest2?.extra?.expoGo?.debuggerHost;
  if (manifest2DebuggerHost) {
    return manifest2DebuggerHost.split(":")[0] || null;
  }

  return null;
}

/**
 * Returns the OI backend base URL (no trailing slash).
 *
 * - If EXPO_PUBLIC_API_URL is set (e.g. in .env), uses that.
 * - Otherwise, when running in Expo Go, uses the same host as the dev server
 *   (from the QR code / exp:// URL) with port 8080, so the phone can reach
 *   your machine's backend without hardcoding an IP.
 * - Falls back to localhost for simulators or when host cannot be determined.
 */
export function getApiBaseUrl(): string {
  const envUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envUrl) {
    return envUrl.replace(/\/$/, "");
  }

  const host = getDevServerHost();
  if (host) {
    return `http://${host}:${BACKEND_PORT}`;
  }

  return `http://localhost:${BACKEND_PORT}`;
}

export function getPairingTimeoutMs(): number {
  return PAIRING_TIMEOUT_MS;
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
