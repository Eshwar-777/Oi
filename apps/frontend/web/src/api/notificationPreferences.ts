import type { NotificationPreferences } from "@/domain/automation";
import { authFetch } from "./authFetch";

let cachedNotificationPreferences: NotificationPreferences | null = null;
let notificationPreferencesRequest: Promise<NotificationPreferences> | null = null;

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
  if (cachedNotificationPreferences) {
    return cachedNotificationPreferences;
  }
  if (!notificationPreferencesRequest) {
    notificationPreferencesRequest = authFetch("/api/notification-preferences", {
      headers: { "Content-Type": "application/json" },
    })
      .then((response) => parseJson<{ preferences: NotificationPreferences }>(response))
      .then((body) => {
        cachedNotificationPreferences = body.preferences;
        return body.preferences;
      })
      .finally(() => {
        notificationPreferencesRequest = null;
      });
  }
  return notificationPreferencesRequest;
}

export async function updateNotificationPreferences(
  payload: Omit<NotificationPreferences, "user_id" | "updated_at">,
): Promise<NotificationPreferences> {
  const response = await authFetch("/api/notification-preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await parseJson<{ preferences: NotificationPreferences }>(response);
  cachedNotificationPreferences = body.preferences;
  return body.preferences;
}
