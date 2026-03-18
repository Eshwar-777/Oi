import { authFetch } from "./authFetch";
import { toApiUrl } from "@/lib/api";
import type { BrowserSessionRecord, SessionControlAuditRecord } from "@/domain/automation";
import { getCurrentAccessToken } from "@/features/auth/session";

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

export async function listBrowserSessions(): Promise<BrowserSessionRecord[]> {
  const response = await authFetch("/browser/sessions");
  const body = await parseJson<{ items: BrowserSessionRecord[] }>(response);
  return Array.isArray(body.items) ? body.items : [];
}

export interface BrowserSessionControlRequest {
  action: "navigate" | "refresh_stream" | "activate_page" | "preview_page" | "clear_preview_page" | "open_tab";
  url?: string;
  page_id?: string;
  page_title?: string;
  tab_index?: number;
}

export interface ManagedRunnerStatus {
  enabled: boolean;
  state: "disabled" | "idle" | "starting" | "ready" | "stopping" | "error";
  phase?: "idle" | "provisioning" | "booting_browser" | "connecting" | "ready" | "failed";
  origin: "local_runner" | "server_runner";
  runner_id?: string | null;
  runner_label?: string | null;
  session_id?: string | null;
  cdp_url?: string | null;
  error?: string | null;
  detail?: string | null;
  retry_count?: number;
  max_retries?: number;
  can_retry?: boolean;
  is_retrying?: boolean;
}

export async function fetchBrowserSessionFrame(sessionId: string) {
  const response = await authFetch(`/browser/sessions/${encodeURIComponent(sessionId)}/frame`);
  const body = await parseJson<{
    session_id: string;
    frame?: SessionFramePayload | SessionFramePayload["payload"] | null;
  }>(response);
  return normalizeSessionFramePayload(body.frame);
}

export async function fetchManagedRunnerStatus(): Promise<ManagedRunnerStatus> {
  const response = await authFetch("/browser/server-runner");
  const body = await parseJson<{ runner: ManagedRunnerStatus }>(response);
  return body.runner;
}

export async function startManagedRunner(): Promise<ManagedRunnerStatus> {
  const response = await authFetch("/browser/server-runner/start", {
    method: "POST",
  });
  const body = await parseJson<{ runner: ManagedRunnerStatus }>(response);
  return body.runner;
}

export async function stopManagedRunner(): Promise<ManagedRunnerStatus> {
  const response = await authFetch("/browser/server-runner/stop", {
    method: "POST",
  });
  const body = await parseJson<{ runner: ManagedRunnerStatus }>(response);
  return body.runner;
}

export async function controlBrowserSession(sessionId: string, payload: BrowserSessionControlRequest) {
  const response = await authFetch(`/browser/sessions/${encodeURIComponent(sessionId)}/control`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return parseJson<{ ok: boolean; session_id: string; action: string }>(response);
}

export async function acquireBrowserSessionControl(sessionId: string, payload: {
  actor_id: string;
  actor_type?: "web" | "mobile" | "desktop" | "system";
  priority?: number;
  ttl_seconds?: number;
}) {
  const response = await authFetch(`/browser/sessions/${encodeURIComponent(sessionId)}/controller/acquire`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return parseJson<{ ok: boolean; session: BrowserSessionRecord }>(response);
}

export async function releaseBrowserSessionControl(sessionId: string, payload: { actor_id: string }) {
  const response = await authFetch(`/browser/sessions/${encodeURIComponent(sessionId)}/controller/release`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return parseJson<{ ok: boolean; session: BrowserSessionRecord }>(response);
}

export async function sendBrowserSessionInput(sessionId: string, payload: {
  actor_id: string;
  input_type: "click" | "type" | "scroll" | "keypress" | "move" | "mouse_down" | "mouse_up";
  page_id?: string;
  x?: number;
  y?: number;
  text?: string;
  delta_x?: number;
  delta_y?: number;
  key?: string;
  button?: "left" | "middle" | "right";
}) {
  const response = await authFetch(`/browser/sessions/${encodeURIComponent(sessionId)}/input`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return parseJson<{ ok: boolean; session_id: string; input_type: string }>(response);
}

export async function listBrowserSessionAudit(sessionId: string): Promise<SessionControlAuditRecord[]> {
  const response = await authFetch(`/browser/sessions/${encodeURIComponent(sessionId)}/audit`);
  const body = await parseJson<{ items: SessionControlAuditRecord[] }>(response);
  return Array.isArray(body.items) ? body.items : [];
}

export interface SessionFramePayload {
  type?: string;
  payload?: {
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
  };
}

function normalizeSessionFramePayload(
  frame: SessionFramePayload | SessionFramePayload["payload"] | Record<string, unknown> | null | undefined,
): SessionFramePayload["payload"] | null {
  if (!frame || typeof frame !== "object") {
    return null;
  }
  const candidate = frame as Record<string, unknown>;
  if (
    typeof candidate.screenshot === "string" ||
    typeof candidate.current_url === "string" ||
    typeof candidate.page_title === "string" ||
    typeof candidate.page_id === "string"
  ) {
    return candidate as SessionFramePayload["payload"];
  }
  if (candidate.payload && typeof candidate.payload === "object") {
    return normalizeSessionFramePayload(candidate.payload as Record<string, unknown>);
  }
  return null;
}

export function connectBrowserSessionStream(
  sessionId: string,
  onFrame: (event: SessionFramePayload) => void,
): () => void {
  const url = new URL(toApiUrl(`/browser/sessions/${encodeURIComponent(sessionId)}/stream`), window.location.origin);
  const source = new EventSource(url.toString(), { withCredentials: true });

  const handleMessage = (message: MessageEvent<string>) => {
    if (!message.data) return;
    try {
      onFrame(JSON.parse(message.data) as SessionFramePayload);
    } catch {
      // ignore malformed frames
    }
  };

  source.addEventListener("message", handleMessage as EventListener);
  return () => {
    source.removeEventListener("message", handleMessage as EventListener);
    source.close();
  };
}

export interface BrowserSessionLiveSocket {
  close: () => void;
  sendControl: (payload: BrowserSessionControlRequest) => boolean;
  sendInput: (payload: {
    actor_id: string;
    input_type: "click" | "type" | "scroll" | "keypress" | "move" | "mouse_down" | "mouse_up";
    page_id?: string;
    x?: number;
    y?: number;
    text?: string;
    delta_x?: number;
    delta_y?: number;
    key?: string;
    button?: "left" | "middle" | "right";
  }) => boolean;
}

function toWebSocketUrl(path: string) {
  const apiUrl = toApiUrl(path);
  const parsed = new URL(apiUrl, window.location.origin);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString();
}

export async function connectBrowserSessionLiveSocket(
  sessionId: string,
  handlers: {
    onFrame: (event: SessionFramePayload) => void;
    onError?: (message: string) => void;
    onOpen?: () => void;
    onClose?: () => void;
  },
): Promise<BrowserSessionLiveSocket> {
  const socket = new WebSocket(toWebSocketUrl(`/ws/browser-session/${encodeURIComponent(sessionId)}`));
  const token = await getCurrentAccessToken().catch(() => "");

  return await new Promise<BrowserSessionLiveSocket>((resolve, reject) => {
    let settled = false;

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // ignore close failures
      }
      reject(new Error(message));
    };

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        type: "session_view_auth",
        payload: {
          token: token || undefined,
        },
      }));
    });

    socket.addEventListener("message", (event) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = String(payload.type || "");
      if (type === "auth_ok") {
        if (!settled) {
          settled = true;
          handlers.onOpen?.();
          resolve({
            close: () => socket.close(),
            sendControl: (controlPayload) => {
              if (socket.readyState !== WebSocket.OPEN) return false;
              socket.send(JSON.stringify({ type: "session_control", payload: controlPayload }));
              return true;
            },
            sendInput: (inputPayload) => {
              if (socket.readyState !== WebSocket.OPEN) return false;
              socket.send(JSON.stringify({ type: "session_input", payload: inputPayload }));
              return true;
            },
          });
        }
        return;
      }
      if (type === "session_frame") {
        handlers.onFrame({ type, payload: normalizeSessionFramePayload(payload.payload as Record<string, unknown>) ?? undefined });
        return;
      }
      if (type === "error") {
        const detail = String(payload.detail || "Live session socket error");
        handlers.onError?.(detail);
        if (!settled) {
          fail(detail);
        }
      }
    });

    socket.addEventListener("error", () => {
      if (!settled) {
        fail("Live session socket connection failed");
      } else {
        handlers.onError?.("Live session socket connection failed");
      }
    });

    socket.addEventListener("close", () => {
      if (!settled) {
        fail("Live session socket closed during setup");
        return;
      }
      handlers.onClose?.();
    });
  });
}
