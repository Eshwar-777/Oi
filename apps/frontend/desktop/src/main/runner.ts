import os from "os";
import { spawn, type ChildProcess } from "child_process";
import { createBrowserSessionAdapter, getBrowserSessionAdapterDiagnostics } from "./browserSession";
import type { BrowserSessionInputPayload, BrowserPageTarget } from "./browserSession/adapter";

export interface RunnerStatus {
  enabled: boolean;
  sessionId: string | null;
  cdpUrl: string | null;
  origin: "local_runner" | "server_runner";
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
const RUNNER_USER_ID =
  process.env.OI_RUNNER_USER_ID && process.env.OI_RUNNER_USER_ID.trim()
    ? process.env.OI_RUNNER_USER_ID.trim()
    : API_BASE_URL.includes("localhost") || API_BASE_URL.includes("127.0.0.1")
      ? "dev-user"
      : "";
const RUNNER_LABEL = process.env.OI_RUNNER_LABEL ?? os.hostname();
const RUNNER_ID = process.env.OI_RUNNER_ID ?? `desktop-runner-${os.hostname()}`;
const RUNNER_ORIGIN = process.env.OI_RUNNER_ORIGIN === "server_runner" ? "server_runner" : "local_runner";
const RUNNER_CDP_URL = process.env.OI_RUNNER_CDP_URL ?? "";
const CHROME_PATH = process.env.OI_RUNNER_CHROME_PATH ?? "";
const CHROME_DEBUG_PORT = Number(process.env.OI_RUNNER_CHROME_DEBUG_PORT ?? "9222");
const HEARTBEAT_MS = Number(process.env.OI_RUNNER_HEARTBEAT_MS ?? "30000");
const FRAME_MS = Number(process.env.OI_RUNNER_FRAME_MS ?? "1200");
const ACTIVE_FRAME_MS = Number(process.env.OI_RUNNER_ACTIVE_FRAME_MS ?? "140");
const INPUT_FRAME_DEBOUNCE_MS = Number(process.env.OI_RUNNER_INPUT_FRAME_DEBOUNCE_MS ?? "75");
const ACTIVE_FRAME_WINDOW_MS = Number(process.env.OI_RUNNER_ACTIVE_FRAME_WINDOW_MS ?? "3000");
const CHROME_USER_DATA_DIR =
  process.env.OI_RUNNER_CHROME_USER_DATA_DIR ?? `/tmp/oi-chrome-${RUNNER_ID}`;
const browserSessionAdapter = createBrowserSessionAdapter();
const RUNNER_BOOTSTRAP_URL = process.env.OI_RUNNER_BOOTSTRAP_URL ?? "https://example.com";

let runnerSessionId: string | null = null;
let runnerHeartbeat: NodeJS.Timeout | null = null;
let runnerFrameLoop: NodeJS.Timeout | null = null;
let runnerImmediateFrameTimer: NodeJS.Timeout | null = null;
let runnerChromeProcess: ChildProcess | null = null;
let runnerSocket: WebSocket | null = null;
let frameCaptureInFlight = false;
let frameCaptureQueued = false;
let lastInteractiveInputAt = 0;
let runnerStatus: RunnerStatus = {
  enabled: RUNNER_ENABLED,
  sessionId: null,
  cdpUrl: RUNNER_CDP_URL || null,
  origin: RUNNER_ORIGIN,
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
  if (RUNNER_CDP_URL) {
    console.info(
      "[runner] using configured CDP target",
      JSON.stringify({ cdpUrl: RUNNER_CDP_URL, origin: RUNNER_ORIGIN, runnerId: RUNNER_ID }),
    );
    return RUNNER_CDP_URL;
  }
  if (!CHROME_PATH) {
    return null;
  }
  if (!runnerChromeProcess) {
    console.info(
      "[runner] launching managed chrome",
      JSON.stringify({
        chromePath: CHROME_PATH,
        debugPort: CHROME_DEBUG_PORT,
        userDataDir: CHROME_USER_DATA_DIR,
        origin: RUNNER_ORIGIN,
        runnerId: RUNNER_ID,
      }),
    );
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

interface CdpListTarget {
  id?: string;
  title?: string;
  url?: string;
  type?: string;
}

function isUsableCdpPage(target: CdpListTarget): boolean {
  const targetType = String(target.type || "");
  const url = String(target.url || "");
  if (targetType !== "page") return false;
  if (!url) return false;
  if (url === "about:blank") return false;
  return true;
}

async function ensureCdpBrowserHasPage(cdpUrl: string): Promise<void> {
  let baseUrl: URL;
  try {
    baseUrl = new URL(cdpUrl);
  } catch {
    return;
  }
  const listUrl = new URL("/json/list", baseUrl).toString();
  const targetsResponse = await fetch(listUrl);
  if (!targetsResponse.ok) {
    throw new Error(`Failed to query CDP targets: ${targetsResponse.status}`);
  }
  const targets = (await targetsResponse.json()) as CdpListTarget[];
  if (Array.isArray(targets) && targets.some(isUsableCdpPage)) {
    console.info("[runner] found existing CDP page", JSON.stringify({ cdpUrl, count: targets.length }));
    return;
  }

  const bootstrapPath = `/json/new?${encodeURIComponent(RUNNER_BOOTSTRAP_URL)}`;
  const bootstrapUrl = new URL(bootstrapPath, baseUrl).toString();
  let bootstrapResponse = await fetch(bootstrapUrl, { method: "PUT" }).catch(() => null);
  if (!bootstrapResponse || !bootstrapResponse.ok) {
    bootstrapResponse = await fetch(bootstrapUrl).catch(() => null);
  }
  if (!bootstrapResponse || !bootstrapResponse.ok) {
    throw new Error(
      `CDP browser has no usable page and failed to bootstrap one via DevTools endpoint for ${RUNNER_BOOTSTRAP_URL}.`,
    );
  }
  console.info(
    "[runner] bootstrapped CDP page",
    JSON.stringify({ cdpUrl, bootstrapUrl: RUNNER_BOOTSTRAP_URL }),
  );
}

async function registerRunnerSession(cdpUrl: string) {
  if (!RUNNER_USER_ID) {
    throw new Error("Runner requires OI_RUNNER_USER_ID to register a browser session.");
  }
  runnerStatus = { ...runnerStatus, state: "registering", error: undefined, cdpUrl };
  const pages = await browserSessionAdapter.listPages(cdpUrl);
  const initialFrame = await browserSessionAdapter.captureFrame(cdpUrl);
  const body = await postJson<SessionResponse>("/browser/runners/register", {
    user_id: RUNNER_USER_ID,
    origin: RUNNER_ORIGIN,
    automation_engine: "agent_browser",
    runner_id: RUNNER_ID,
    runner_label: RUNNER_LABEL,
    browser_version: "",
    page_id: pages.find((page) => page.active)?.id ?? pages[0]?.id ?? null,
    pages: pages.map((page) => ({
      page_id: page.id,
      url: page.url,
      title: page.title,
      is_active: Boolean(page.active),
    })),
    viewport: initialFrame?.viewport,
    metadata: { cdp_url: cdpUrl, ...getBrowserSessionAdapterDiagnostics() },
  });
  runnerSessionId = body.session.session_id;
  runnerStatus = {
    enabled: true,
    sessionId: runnerSessionId,
    cdpUrl,
    origin: RUNNER_ORIGIN,
    state: "ready",
  };
}

async function sendHeartbeat(cdpUrl: string) {
  if (!runnerSessionId) return;
  const pages = await browserSessionAdapter.listPages(cdpUrl);
  const frame = await browserSessionAdapter.captureFrame(cdpUrl);
  await postJson<SessionResponse>("/browser/runners/heartbeat", {
    runner_id: RUNNER_ID,
    session_id: runnerSessionId,
    status: "ready",
    automation_engine: "agent_browser",
    page_id: pages[0]?.id ?? null,
    pages: pages.map((page) => ({
      page_id: page.id,
      url: page.url,
      title: page.title,
      is_active: Boolean(page.active),
    })),
    viewport: frame?.viewport,
    metadata: { cdp_url: cdpUrl, ...getBrowserSessionAdapterDiagnostics() },
  });
}

interface SessionControlPayload extends BrowserSessionInputPayload {
  action?: string;
  url?: string;
  page_id?: string;
  page_title?: string;
  tab_index?: number;
}

function publishFrame(frame: {
  screenshot: string;
  current_url: string;
  page_title: string;
  page_id: string;
  viewport?: {
    width: number;
    height: number;
    dpr: number;
  };
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
        viewport: frame.viewport,
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    }),
  );
}

async function publishFrameOnce(cdpUrl: string): Promise<void> {
  if (frameCaptureInFlight) {
    frameCaptureQueued = true;
    return;
  }
  frameCaptureInFlight = true;
  try {
    const frame = await browserSessionAdapter.captureFrame(cdpUrl);
    if (frame) publishFrame(frame);
  } finally {
    frameCaptureInFlight = false;
    if (frameCaptureQueued) {
      frameCaptureQueued = false;
      void publishFrameOnce(cdpUrl);
    }
  }
}

function currentFrameIntervalMs(): number {
  const now = Date.now();
  if (now - lastInteractiveInputAt <= ACTIVE_FRAME_WINDOW_MS) {
    return ACTIVE_FRAME_MS;
  }
  return FRAME_MS;
}

function startAdaptiveFrameLoop(cdpUrl: string): void {
  if (runnerFrameLoop) {
    clearTimeout(runnerFrameLoop);
  }

  const tick = () => {
    void publishFrameOnce(cdpUrl).finally(() => {
      runnerFrameLoop = setTimeout(tick, currentFrameIntervalMs());
    });
  };

  runnerFrameLoop = setTimeout(tick, currentFrameIntervalMs());
}

function scheduleFramePublish(cdpUrl: string, delayMs: number): void {
  if (runnerImmediateFrameTimer) {
    clearTimeout(runnerImmediateFrameTimer);
  }
  runnerImmediateFrameTimer = setTimeout(() => {
    runnerImmediateFrameTimer = null;
    void publishFrameOnce(cdpUrl);
  }, delayMs);
}

function startRunnerSocket(cdpUrl: string): void {
  if (!runnerSessionId) return;
  if (runnerSocket && runnerSocket.readyState === WebSocket.OPEN) return;
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
    void publishFrameOnce(cdpUrl);
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
        lastInteractiveInputAt = Date.now();
        void browserSessionAdapter.navigate(cdpUrl, payload.url).then(() => scheduleFramePublish(cdpUrl, INPUT_FRAME_DEBOUNCE_MS));
      } else if (action === "activate_page") {
        lastInteractiveInputAt = Date.now();
        void browserSessionAdapter
          .activatePage(cdpUrl, {
            pageId: typeof payload.page_id === "string" ? payload.page_id : undefined,
            url: typeof payload.url === "string" ? payload.url : undefined,
            title: typeof payload.page_title === "string" ? payload.page_title : undefined,
            tabIndex: typeof payload.tab_index === "number" ? payload.tab_index : undefined,
          })
          .then(() => scheduleFramePublish(cdpUrl, INPUT_FRAME_DEBOUNCE_MS));
      } else if (action === "open_tab") {
        lastInteractiveInputAt = Date.now();
        void browserSessionAdapter
          .openTab(cdpUrl, typeof payload.url === "string" ? payload.url : "about:blank")
          .then(() => scheduleFramePublish(cdpUrl, INPUT_FRAME_DEBOUNCE_MS));
      } else if (action === "refresh_stream") {
        void publishFrameOnce(cdpUrl);
      } else if (action === "input") {
        lastInteractiveInputAt = Date.now();
        void browserSessionAdapter.dispatchInput(cdpUrl, payload).then(() => scheduleFramePublish(cdpUrl, INPUT_FRAME_DEBOUNCE_MS));
      }
    }
  });

  socket.addEventListener("close", () => {
    if (runnerSocket === socket) runnerSocket = null;
  });
  socket.addEventListener("error", () => {
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
      origin: RUNNER_ORIGIN,
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
      origin: RUNNER_ORIGIN,
      state: "error",
      error: "No CDP URL or Chrome path configured for local runner.",
    };
    return runnerStatus;
  }

  try {
    await ensureCdpBrowserHasPage(cdpUrl);
    await registerRunnerSession(cdpUrl);
    startRunnerSocket(cdpUrl);
    if (runnerHeartbeat) clearInterval(runnerHeartbeat);
    runnerHeartbeat = setInterval(() => {
      void sendHeartbeat(cdpUrl).catch((error) => {
        runnerStatus = {
          enabled: true,
          sessionId: runnerSessionId,
          cdpUrl,
          origin: RUNNER_ORIGIN,
          state: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      });
    }, HEARTBEAT_MS);
	    startAdaptiveFrameLoop(cdpUrl);
	    await publishFrameOnce(cdpUrl);
	    return runnerStatus;
  } catch (error) {
    runnerStatus = {
      enabled: true,
      sessionId: null,
      cdpUrl,
      origin: RUNNER_ORIGIN,
      state: "error",
      error: error instanceof Error ? error.message : String(error),
    };
    return runnerStatus;
  }
}

export function getRunnerStatus(): RunnerStatus {
  return runnerStatus;
}
