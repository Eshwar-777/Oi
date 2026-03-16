import { getFirebaseMobileAuth } from "@/features/auth/firebase";

let cachedAccessToken = "";

export function setCachedAccessToken(token: string | null | undefined): void {
  cachedAccessToken = typeof token === "string" ? token : "";
}

export async function getAccessToken(forceRefresh = false): Promise<string> {
  try {
    const user = getFirebaseMobileAuth()?.currentUser ?? null;
    if (!user) {
      cachedAccessToken = "";
      return "";
    }
    cachedAccessToken = (await user.getIdToken(forceRefresh)) || "";
    return cachedAccessToken;
  } catch {
    return cachedAccessToken;
  }
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  try {
    const token = await getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    // Missing native module or anonymous session: continue without bearer token.
  }

  return headers;
}
