import type { AutomationStreamEvent, RunDetailResponse } from "@/domain/automation";

export function shouldNotifyInBrowser(
  event: AutomationStreamEvent,
  preferences: { browser_enabled: boolean; urgency_mode: "all" | "important_only" | "none" } | null,
): boolean {
  if (!preferences?.browser_enabled) return false;
  if (preferences.urgency_mode === "none") return false;
  if (event.type === "run.waiting_for_human") return true;
  if (event.type === "run.runtime_incident") {
    return preferences.urgency_mode === "all";
  }
  return false;
}

export function buildNotificationRoute(
  event: AutomationStreamEvent,
  detail?: RunDetailResponse | null,
  conversationId?: string | null,
): string | undefined {
  if (!event.run_id) return undefined;
  const browserSessionId = detail?.run.browser_session_id;
  if (conversationId) {
    const search = new URLSearchParams({
      conversation_id: conversationId,
      run_id: event.run_id,
      ...(browserSessionId ? { session_id: browserSessionId } : {}),
    });
    return `/chat?${search.toString()}`;
  }
  if (browserSessionId) {
    return `/sessions?session_id=${encodeURIComponent(browserSessionId)}&run_id=${encodeURIComponent(event.run_id)}`;
  }
  return `/chat?run_id=${encodeURIComponent(event.run_id)}`;
}

export function getNotificationBody(event: AutomationStreamEvent): string | null {
  if (event.type === "run.waiting_for_human") {
    return typeof event.payload?.reason === "string" ? event.payload.reason : "The automation is waiting for human review.";
  }
  if (event.type === "run.runtime_incident") {
    const incident = event.payload?.incident;
    if (incident && typeof incident === "object") {
      const summary = (incident as { summary?: unknown }).summary;
      if (typeof summary === "string" && summary.trim()) {
        return summary;
      }
    }
    return "The automation hit a runtime incident.";
  }
  return null;
}
