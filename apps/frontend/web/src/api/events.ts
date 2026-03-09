import { toApiUrl } from "@/lib/api";
import type { AutomationStreamEvent } from "@/domain/automation";
import { getCurrentAccessToken } from "@/features/auth/session";

export interface EventStreamClient {
  connect: (sessionId: string, onEvent: (event: AutomationStreamEvent) => void) => () => void;
}

export const eventStreamClient: EventStreamClient = {
  connect(sessionId, onEvent) {
    let source: EventSource | null = null;
    let cancelled = false;

    const handleMessage = (message: MessageEvent<string>) => {
      if (!message.data) return;
      try {
        const event = JSON.parse(message.data) as AutomationStreamEvent;
        onEvent(event);
      } catch {
        // Ignore malformed frames and keep the stream alive.
      }
    };

    void (async () => {
      const token = await getCurrentAccessToken();
      if (cancelled) return;
      const url = new URL(toApiUrl("/api/events/stream"), window.location.origin);
      url.searchParams.set("session_id", sessionId);
      if (token) {
        url.searchParams.set("access_token", token);
      }
      source = new EventSource(url.toString(), { withCredentials: true });
      source.addEventListener("message", handleMessage as EventListener);
      source.addEventListener("ping", () => undefined);
      source.onerror = () => {
        // Allow the browser EventSource client to retry automatically.
      };
    })();

    return () => {
      cancelled = true;
      source?.removeEventListener("message", handleMessage as EventListener);
      source?.close();
    };
  },
};
