import { getAccessToken } from "@/lib/authHeaders";
import { getApiBaseUrl } from "@/lib/api";

export interface BrowserSessionStreamFrame {
  session_id?: string;
  screenshot?: string;
  current_url?: string;
  page_title?: string;
  page_id?: string;
  timestamp?: string;
  viewport?: {
    width: number;
    height: number;
    dpr: number;
  };
}

interface BrowserSessionStreamPayload {
  type?: string;
  payload?: BrowserSessionStreamFrame;
}

interface BrowserSessionStreamOptions {
  sessionId: string;
  onFrame: (frame: BrowserSessionStreamFrame) => void;
  onError?: (error: Error) => void;
}

const MAX_RESPONSE_TEXT_CHARS = 6_000_000;
const MAX_FRAMES_PER_CONNECTION = 24;

function toStreamUrl(sessionId: string, accessToken: string) {
  const url = new URL(`/browser/sessions/${encodeURIComponent(sessionId)}/stream`, getApiBaseUrl());
  if (accessToken) {
    url.searchParams.set("access_token", accessToken);
  }
  return url.toString();
}

function parseEventChunk(rawChunk: string) {
  const lines = rawChunk.replace(/\r/g, "").split("\n");
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  return dataLines.join("\n");
}

export function connectBrowserSessionStream({
  sessionId,
  onFrame,
  onError,
}: BrowserSessionStreamOptions) {
  let cancelled = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let request: XMLHttpRequest | null = null;
  let processedLength = 0;
  let buffer = "";
  let framesSeen = 0;

  const cleanupRequest = () => {
    if (!request) return;
    request.onprogress = null;
    request.onerror = null;
    request.onreadystatechange = null;
    request.abort();
    request = null;
  };

  const restartConnection = () => {
    cleanupRequest();
    processedLength = 0;
    buffer = "";
    framesSeen = 0;
    scheduleReconnect();
  };

  const scheduleReconnect = () => {
    if (cancelled) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void openConnection();
    }, 1200);
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

      const data = parseEventChunk(rawChunk);
      if (!data) continue;

      try {
        const payload = JSON.parse(data) as BrowserSessionStreamPayload;
        if (payload.payload) {
          framesSeen += 1;
          onFrame(payload.payload);
        }
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error("Malformed browser session stream frame"));
      }
    }

    if (request && (processedLength >= MAX_RESPONSE_TEXT_CHARS || framesSeen >= MAX_FRAMES_PER_CONNECTION)) {
      restartConnection();
    }
  };

  const openConnection = async () => {
    cleanupRequest();
    processedLength = 0;
    buffer = "";
    framesSeen = 0;

    try {
      const accessToken = await getAccessToken();
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
            onError?.(new Error(`Browser session stream failed with status ${xhr.status}`));
          }
          scheduleReconnect();
        }
      };
      xhr.onerror = () => {
        if (cancelled) return;
        onError?.(new Error("Browser session stream connection failed"));
        scheduleReconnect();
      };
      xhr.send();
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error("Failed to open browser session stream"));
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
