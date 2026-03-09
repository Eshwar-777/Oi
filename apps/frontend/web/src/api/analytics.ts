import { toApiUrl } from "@/lib/api";
import type { AutomationEngineAnalyticsItem, RuntimeIncidentAnalyticsItem } from "@/domain/automation";

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

export async function listAutomationEngineAnalytics(): Promise<AutomationEngineAnalyticsItem[]> {
  const response = await fetch(toApiUrl("/api/analytics/automation-engines"), {
    headers: { "Content-Type": "application/json" },
  });
  const body = await parseJson<{ items: AutomationEngineAnalyticsItem[] }>(response);
  return Array.isArray(body.items) ? body.items : [];
}

export async function listRuntimeIncidentAnalytics(): Promise<RuntimeIncidentAnalyticsItem[]> {
  const response = await fetch(toApiUrl("/api/analytics/runtime-incidents"), {
    headers: { "Content-Type": "application/json" },
  });
  const body = await parseJson<{ items: RuntimeIncidentAnalyticsItem[] }>(response);
  return Array.isArray(body.items) ? body.items : [];
}
