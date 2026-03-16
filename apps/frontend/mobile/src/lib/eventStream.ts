import { getAccessToken } from "@/lib/authHeaders";
import { getApiBaseUrl } from "@/lib/api";
import type { AutomationStreamEvent } from "@/lib/automation";

interface EventStreamOptions {
  sessionId: string;
  onEvent: (event: AutomationStreamEvent) => void;
  onError?: (error: Error) => void;
}

const MAX_RESPONSE_TEXT_CHARS = 1_500_000;
const MAX_EVENTS_PER_CONNECTION = 250;
const MAX_SEEN_EVENT_IDS = 500;

function toStreamUrl(sessionId: string, accessToken: string) {
  const url = new URL("/api/events/stream", getApiBaseUrl());
  url.searchParams.set("session_id", sessionId);
  if (accessToken) {
    url.searchParams.set("access_token", accessToken);
  }
  return url.toString();
}

function parseEventChunk(rawChunk: string) {
  const lines = rawChunk.replace(/\r/g, "").split("\n");
  let eventName = "message";
  let eventId = "";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("id:")) {
      eventId = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  return {
    eventName,
    eventId,
    data: dataLines.join("\n"),
  };
}

export function connectEventStream({ sessionId, onEvent, onError }: EventStreamOptions) {
  let cancelled = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let request: XMLHttpRequest | null = null;
  let processedLength = 0;
  let buffer = "";
  const seenEventIds = new Set<string>();
  const seenEventIdOrder: string[] = [];
  let eventsSeen = 0;

  const cleanupRequest = () => {
    if (!request) return;
    request.onprogress = null;
    request.onerror = null;
    request.onreadystatechange = null;
    request.abort();
    request = null;
  };

  const rememberEventId = (eventId: string) => {
    if (!eventId || seenEventIds.has(eventId)) return;
    seenEventIds.add(eventId);
    seenEventIdOrder.push(eventId);
    while (seenEventIdOrder.length > MAX_SEEN_EVENT_IDS) {
      const oldest = seenEventIdOrder.shift();
      if (oldest) seenEventIds.delete(oldest);
    }
  };

  const scheduleReconnect = () => {
    if (cancelled) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void openConnection();
    }, 1200);
  };

  const restartConnection = () => {
    cleanupRequest();
    processedLength = 0;
    buffer = "";
    eventsSeen = 0;
    scheduleReconnect();
  };

  const handleChunk = () => {
    if (!request) return;
    const incoming = request.responseText.slice(processedLength);
    if (!incoming) return;
    processedLength = request.responseText.length;
    buffer += incoming;

    while (true) {
      const separatorIndex = buffer.indexOf("\n\n");
      if (separatorIndex < 0) break;
      const rawChunk = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      const parsed = parseEventChunk(rawChunk);
      if (!parsed.data || parsed.eventName === "ping") continue;
      if (parsed.eventId && seenEventIds.has(parsed.eventId)) continue;

      try {
        const event = JSON.parse(parsed.data) as AutomationStreamEvent;
        if (parsed.eventId) {
          rememberEventId(parsed.eventId);
        } else if (event.event_id) {
          if (seenEventIds.has(event.event_id)) continue;
          rememberEventId(event.event_id);
        }
        eventsSeen += 1;
        onEvent(event);
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error("Malformed event stream frame"));
      }
    }

    if (request && (processedLength >= MAX_RESPONSE_TEXT_CHARS || eventsSeen >= MAX_EVENTS_PER_CONNECTION)) {
      restartConnection();
    }
  };

  const openConnection = async () => {
    cleanupRequest();
    processedLength = 0;
    buffer = "";
    eventsSeen = 0;

    try {
      const accessToken = await getAccessToken(true);
      if (cancelled) return;

      const xhr = new XMLHttpRequest();
      request = xhr;
      xhr.open("GET", toStreamUrl(sessionId, accessToken), true);
      xhr.setRequestHeader("Accept", "text/event-stream");
      xhr.timeout = 0;

      xhr.onprogress = handleChunk;
      xhr.onreadystatechange = () => {
        if (!request || xhr !== request) return;
        if (xhr.readyState >= XMLHttpRequest.LOADING) {
          handleChunk();
        }
        if (xhr.readyState === XMLHttpRequest.DONE && !cancelled) {
          if (xhr.status >= 400) {
            onError?.(new Error(`Event stream failed with status ${xhr.status}`));
          }
          scheduleReconnect();
        }
      };
      xhr.onerror = () => {
        if (cancelled) return;
        onError?.(new Error("Event stream connection failed"));
        scheduleReconnect();
      };
      xhr.send();
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error("Failed to open event stream"));
      scheduleReconnect();
    }
  };

  void openConnection();

  return () => {
    cancelled = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanupRequest();
  };
}
