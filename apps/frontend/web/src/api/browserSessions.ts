import { authFetch } from "./authFetch";
import { toApiUrl } from "@/lib/api";
import type { BrowserSessionRecord, SessionControlAuditRecord } from "@/domain/automation";

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
  action: "navigate" | "refresh_stream" | "activate_page" | "preview_page" | "clear_preview_page";
  url?: string;
  page_id?: string;
  page_title?: string;
  tab_index?: number;
}

export interface ManagedRunnerStatus {
  enabled: boolean;
  state: "disabled" | "idle" | "starting" | "ready" | "stopping" | "error";
  origin: "local_runner" | "server_runner";
  runner_id?: string | null;
  runner_label?: string | null;
  session_id?: string | null;
  cdp_url?: string | null;
  error?: string | null;
}

export async function fetchBrowserSessionFrame(sessionId: string) {
  const response = await authFetch(`/browser/sessions/${encodeURIComponent(sessionId)}/frame`);
  const body = await parseJson<{
    session_id: string;
    frame?: SessionFramePayload["payload"] | null;
  }>(response);
  return body.frame ?? null;
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
