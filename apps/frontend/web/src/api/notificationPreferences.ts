import type { NotificationPreferences } from "@/domain/automation";
import { toApiUrl } from "@/lib/api";

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message =
      typeof (body as { detail?: unknown }).detail === "string"
        ? (body as { detail: string }).detail
        : `Request failed with status ${response.status}`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function getNotificationPreferences(): Promise<NotificationPreferences> {
  const response = await fetch(toApiUrl("/api/notification-preferences"), {
    headers: { "Content-Type": "application/json" },
  });
  const body = await parseJson<{ preferences: NotificationPreferences }>(response);
  return body.preferences;
}

export async function updateNotificationPreferences(
  payload: Omit<NotificationPreferences, "user_id" | "updated_at">,
): Promise<NotificationPreferences> {
  const response = await fetch(toApiUrl("/api/notification-preferences"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await parseJson<{ preferences: NotificationPreferences }>(response);
  return body.preferences;
}
