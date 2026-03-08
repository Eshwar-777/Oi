import os from "os";
import { spawn, type ChildProcess } from "child_process";
import { createBrowserSessionAdapter, getBrowserSessionAdapterDiagnostics } from "./browserSession";
import type { BrowserSessionInputPayload, BrowserPageTarget } from "./browserSession/adapter";

export interface RunnerStatus {
  enabled: boolean;
  sessionId: string | null;
  cdpUrl: string | null;
  state: "idle" | "registering" | "ready" | "error";
  error?: string;
}

interface SessionResponse {
  session: {
    session_id: string;
  };
}

const RUNNER_ENABLED = process.env.OI_RUNNER_ENABLED === "1";
const API_BASE_URL = process.env.OI_RUNNER_API_URL ?? "http://localhost:8080";
const RUNNER_SECRET = process.env.OI_RUNNER_SECRET ?? "";
const RUNNER_USER_ID = process.env.OI_RUNNER_USER_ID ?? "";
const RUNNER_LABEL = process.env.OI_RUNNER_LABEL ?? os.hostname();
const RUNNER_ID = process.env.OI_RUNNER_ID ?? `desktop-runner-${os.hostname()}`;
const RUNNER_CDP_URL = process.env.OI_RUNNER_CDP_URL ?? "";
const CHROME_PATH = process.env.OI_RUNNER_CHROME_PATH ?? "";
const CHROME_DEBUG_PORT = Number(process.env.OI_RUNNER_CHROME_DEBUG_PORT ?? "9222");
const HEARTBEAT_MS = Number(process.env.OI_RUNNER_HEARTBEAT_MS ?? "30000");
const FRAME_MS = Number(process.env.OI_RUNNER_FRAME_MS ?? "5000");
const CHROME_USER_DATA_DIR =
  process.env.OI_RUNNER_CHROME_USER_DATA_DIR ?? `/tmp/oi-chrome-${RUNNER_ID}`;
const browserSessionAdapter = createBrowserSessionAdapter();

let runnerSessionId: string | null = null;
let runnerHeartbeat: NodeJS.Timeout | null = null;
let runnerFrameLoop: NodeJS.Timeout | null = null;
let runnerChromeProcess: ChildProcess | null = null;
let runnerSocket: WebSocket | null = null;
let runnerStatus: RunnerStatus = {
  enabled: RUNNER_ENABLED,
  sessionId: null,
  cdpUrl: RUNNER_CDP_URL || null,
  state: RUNNER_ENABLED ? "idle" : "idle",
};

function headers() {
  return {
    "Content-Type": "application/json",
    "x-oi-runner-secret": RUNNER_SECRET,
  };
}

function wsBaseUrl(): string {
  return API_BASE_URL.replace(/^http/, "ws");
}

async function postJson<T>(path: string, payload: object): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `Runner request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

function launchManagedChromeIfConfigured(): string | null {
  if (!CHROME_PATH) {
    return RUNNER_CDP_URL || null;
  }
  if (!runnerChromeProcess) {
    runnerChromeProcess = spawn(
      CHROME_PATH,
      [
        `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
        `--user-data-dir=${CHROME_USER_DATA_DIR}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    runnerChromeProcess.unref();
  }
  return `http://127.0.0.1:${CHROME_DEBUG_PORT}`;
}

async function registerRunnerSession(cdpUrl: string) {
  runnerStatus = { ...runnerStatus, state: "registering", error: undefined, cdpUrl };
  const body = await postJson<SessionResponse>("/browser/runners/register", {
    user_id: RUNNER_USER_ID,
    origin: "local_runner",
    runner_id: RUNNER_ID,
    runner_label: RUNNER_LABEL,
    browser_version: "",
    metadata: { cdp_url: cdpUrl, ...getBrowserSessionAdapterDiagnostics() },
  });
  runnerSessionId = body.session.session_id;
  runnerStatus = {
    enabled: true,
    sessionId: runnerSessionId,
    cdpUrl,
    state: "ready",
  };
}

async function sendHeartbeat(cdpUrl: string) {
  if (!runnerSessionId) return;
  const pages = await browserSessionAdapter.listPages(cdpUrl);
  await postJson<SessionResponse>("/browser/runners/heartbeat", {
    runner_id: RUNNER_ID,
    session_id: runnerSessionId,
    status: "ready",
    page_id: pages[0]?.id ?? null,
    pages: pages.map((page) => ({
      page_id: page.id,
      url: page.url,
      title: page.title,
      is_active: page.type === "page",
    })),
    metadata: { cdp_url: cdpUrl, ...getBrowserSessionAdapterDiagnostics() },
  });
}

interface SessionControlPayload extends BrowserSessionInputPayload {
  action?: string;
  url?: string;
}

function publishFrame(frame: {
  screenshot: string;
  current_url: string;
  page_title: string;
  page_id: string;
}) {
  if (!runnerSocket || runnerSocket.readyState !== WebSocket.OPEN || !runnerSessionId) return;
  runnerSocket.send(
    JSON.stringify({
      type: "session_frame",
      payload: {
        session_id: runnerSessionId,
        screenshot: frame.screenshot,
        current_url: frame.current_url,
        page_title: frame.page_title,
        page_id: frame.page_id,
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    }),
  );
}

async function publishFrameOnce(cdpUrl: string): Promise<void> {
  const frame = await browserSessionAdapter.captureFrame(cdpUrl);
  if (frame) publishFrame(frame);
}

function startRunnerSocket(cdpUrl: string): void {
  if (!runnerSessionId) return;
  const socket = new WebSocket(`${wsBaseUrl()}/ws/runner`);
  runnerSocket = socket;

  socket.addEventListener("open", () => {
    socket.send(
      JSON.stringify({
        type: "runner_auth",
        payload: {
          secret: RUNNER_SECRET,
          runner_id: RUNNER_ID,
          user_id: RUNNER_USER_ID,
          session_id: runnerSessionId,
        },
        timestamp: new Date().toISOString(),
      }),
    );
  });

  socket.addEventListener("message", (event) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(frame.type || "");
    if (type === "ping") {
      socket.send(JSON.stringify({ type: "pong", payload: {}, timestamp: new Date().toISOString() }));
      return;
    }
    if (type === "session_control") {
      const payload = (frame.payload ?? {}) as SessionControlPayload;
      const action = String(payload.action || "");
      if (action === "navigate" && typeof payload.url === "string") {
        void browserSessionAdapter.navigate(cdpUrl, payload.url).then(() => publishFrameOnce(cdpUrl));
      } else if (action === "refresh_stream") {
        void publishFrameOnce(cdpUrl);
      } else if (action === "input") {
        void browserSessionAdapter.dispatchInput(cdpUrl, payload).then(() => publishFrameOnce(cdpUrl));
      }
    }
  });

  socket.addEventListener("close", () => {
    if (runnerSocket === socket) runnerSocket = null;
  });
}

export async function startLocalRunner(): Promise<RunnerStatus> {
  if (!RUNNER_ENABLED) return runnerStatus;
  if (!RUNNER_SECRET || !RUNNER_USER_ID) {
    runnerStatus = {
      enabled: true,
      sessionId: null,
      cdpUrl: null,
      state: "error",
      error: "Runner secret or user id is missing.",
    };
    return runnerStatus;
  }

  const cdpUrl = launchManagedChromeIfConfigured();
  if (!cdpUrl) {
    runnerStatus = {
      enabled: true,
      sessionId: null,
      cdpUrl: null,
      state: "error",
      error: "No CDP URL or Chrome path configured for local runner.",
    };
    return runnerStatus;
  }

  try {
    await registerRunnerSession(cdpUrl);
    startRunnerSocket(cdpUrl);
    if (runnerHeartbeat) clearInterval(runnerHeartbeat);
    runnerHeartbeat = setInterval(() => {
      void sendHeartbeat(cdpUrl).catch((error) => {
        runnerStatus = {
          enabled: true,
          sessionId: runnerSessionId,
          cdpUrl,
          state: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      });
    }, HEARTBEAT_MS);
    if (runnerFrameLoop) clearInterval(runnerFrameLoop);
    runnerFrameLoop = setInterval(() => {
      void publishFrameOnce(cdpUrl);
    }, FRAME_MS);
    await publishFrameOnce(cdpUrl);
    return runnerStatus;
  } catch (error) {
    runnerStatus = {
      enabled: true,
      sessionId: null,
      cdpUrl,
      state: "error",
      error: error instanceof Error ? error.message : String(error),
    };
    return runnerStatus;
  }
}

export function getRunnerStatus(): RunnerStatus {
  return runnerStatus;
}
