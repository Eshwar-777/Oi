import { getCurrentAccessToken } from "@/features/auth/session";
import { toApiUrl } from "@/lib/api";

function readCookie(name: string) {
  if (typeof document === "undefined") return "";
  const parts = document.cookie.split(";").map((part) => part.trim());
  const matched = parts.find((part) => part.startsWith(`${name}=`));
  return matched ? decodeURIComponent(matched.slice(name.length + 1)) : "";
}

export async function authFetch(path: string, init: RequestInit = {}, options?: { useBearer?: boolean }) {
  const headers = new Headers(init.headers);
  const method = String(init.method || "GET").toUpperCase();
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (options?.useBearer) {
    const token = await getCurrentAccessToken();
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }
  if (!options?.useBearer && !["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrfToken = readCookie("oi_csrf");
    if (csrfToken) {
      headers.set("X-CSRF-Token", csrfToken);
    }
  }
  return fetch(toApiUrl(path), { ...init, headers, credentials: "include" });
}
