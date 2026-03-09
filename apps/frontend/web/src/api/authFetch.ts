import { getCurrentAccessToken } from "@/features/auth/session";
import { toApiUrl } from "@/lib/api";

export async function authFetch(path: string, init: RequestInit = {}) {
  const token = await getCurrentAccessToken();
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(toApiUrl(path), { ...init, headers });
}
