import { toApiUrl } from "@/lib/api";
import type { AutomationStreamEvent } from "@/domain/automation";

export interface EventStreamClient {
  connect: (sessionId: string, onEvent: (event: AutomationStreamEvent) => void) => () => void;
}

export const eventStreamClient: EventStreamClient = {
  connect(sessionId, onEvent) {
    const url = new URL(toApiUrl("/api/events/stream"), window.location.origin);
    url.searchParams.set("session_id", sessionId);

    const source = new EventSource(url.toString(), { withCredentials: true });

    const handleMessage = (message: MessageEvent<string>) => {
      if (!message.data) return;
      try {
        const event = JSON.parse(message.data) as AutomationStreamEvent;
        onEvent(event);
      } catch {
        // Ignore malformed frames and keep the stream alive.
      }
    };

    source.addEventListener("message", handleMessage as EventListener);
    source.addEventListener("ping", () => undefined);

    source.onerror = () => {
      // Allow the browser EventSource client to retry automatically.
    };

    return () => {
      source.removeEventListener("message", handleMessage as EventListener);
      source.close();
    };
  },
};
