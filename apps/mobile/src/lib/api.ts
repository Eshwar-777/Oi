import Constants from "expo-constants";

const BACKEND_PORT = 8080;

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

  const hostUri = Constants.expoConfig?.hostUri ?? Constants.manifest?.hostUri;
  if (hostUri) {
    const host = hostUri.split(":")[0];
    if (host) {
      return `http://${host}:${BACKEND_PORT}`;
    }
  }

  return `http://localhost:${BACKEND_PORT}`;
}
