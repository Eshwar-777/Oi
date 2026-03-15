import os from "os";
import { spawn, type ChildProcess } from "child_process";
import { mkdir } from "fs/promises";
import readline from "readline";
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
const DISPLAY_NAME = process.env.DISPLAY || process.env.OI_RUNNER_X_DISPLAY || ":99";
const DISPLAY_WIDTH = Number(process.env.OI_RUNNER_DISPLAY_WIDTH || "1440");
const DISPLAY_HEIGHT = Number(process.env.OI_RUNNER_DISPLAY_HEIGHT || "960");
const HEARTBEAT_MS = Number(process.env.OI_RUNNER_HEARTBEAT_MS ?? "30000");
const FRAME_MS = Number(process.env.OI_RUNNER_FRAME_MS ?? "900");
const ACTIVE_FRAME_MS = Number(process.env.OI_RUNNER_ACTIVE_FRAME_MS ?? "140");
const INPUT_FRAME_DEBOUNCE_MS = Number(process.env.OI_RUNNER_INPUT_FRAME_DEBOUNCE_MS ?? "75");
const ACTIVE_FRAME_WINDOW_MS = Number(process.env.OI_RUNNER_ACTIVE_FRAME_WINDOW_MS ?? "3000");
const RUNNER_SOCKET_RECONNECT_BASE_MS = Number(process.env.OI_RUNNER_SOCKET_RECONNECT_BASE_MS ?? "1000");
const RUNNER_SOCKET_RECONNECT_MAX_MS = Number(process.env.OI_RUNNER_SOCKET_RECONNECT_MAX_MS ?? "15000");
const CHROME_USER_DATA_DIR =
  process.env.OI_RUNNER_CHROME_USER_DATA_DIR ?? `/tmp/oi-chrome-${RUNNER_ID}`;
const browserSessionAdapter = createBrowserSessionAdapter();
const RUNNER_BOOTSTRAP_URL = process.env.OI_RUNNER_BOOTSTRAP_URL ?? "https://example.com";
const captureMode = () => browserSessionAdapter.getCaptureMode?.() ?? (browserSessionAdapter.kind === "window" ? "browser_window" : "page_surface");

let runnerSessionId: string | null = null;
let runnerHeartbeat: NodeJS.Timeout | null = null;
let runnerFrameLoop: NodeJS.Timeout | null = null;
let runnerImmediateFrameTimer: NodeJS.Timeout | null = null;
let runnerImmediateHeartbeatTimer: NodeJS.Timeout | null = null;
let runnerChromeProcess: ChildProcess | null = null;
let runnerDisplayProcess: ChildProcess | null = null;
let runnerSocket: WebSocket | null = null;
let runnerSocketReconnectTimer: NodeJS.Timeout | null = null;
let runnerSocketReconnectAttempts = 0;
let frameCaptureInFlight = false;
let frameCaptureQueued = false;
let lastInteractiveInputAt = 0;
let previewTarget: { pageId?: string; url?: string; title?: string; tabIndex?: number } | null = null;
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

function pipeChromeLogs(stream: NodeJS.ReadableStream | null, prefix: string) {
  if (!stream) return;
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    console.info(`[runner] chrome ${prefix}`, line);
  });
}

function pipeDisplayLogs(stream: NodeJS.ReadableStream | null, prefix: string) {
  if (!stream) return;
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    console.info(`[runner] display ${prefix}`, line);
  });
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

async function launchManagedChromeIfConfigured(): Promise<string | null> {
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
  if (RUNNER_ORIGIN === "server_runner" && !runnerDisplayProcess) {
    runnerDisplayProcess = spawn(
      "Xvfb",
      [
        DISPLAY_NAME,
        "-screen",
        "0",
        `${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}x24`,
        "-ac",
        "-nolisten",
        "tcp",
      ],
      {
        stdio: "pipe",
      },
    );
    pipeDisplayLogs(runnerDisplayProcess.stdout, "stdout");
    pipeDisplayLogs(runnerDisplayProcess.stderr, "stderr");
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  if (!runnerChromeProcess) {
    await mkdir(CHROME_USER_DATA_DIR, { recursive: true }).catch(() => {});
    const chromeArgs = [
      `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${CHROME_USER_DATA_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
    ];
    if (RUNNER_ORIGIN === "server_runner") {
      chromeArgs.push(
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        `--window-size=${DISPLAY_WIDTH},${DISPLAY_HEIGHT}`,
        "--start-maximized",
        "--force-device-scale-factor=1",
      );
    }
    chromeArgs.push("about:blank");
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
      chromeArgs,
      {
        detached: RUNNER_ORIGIN !== "server_runner",
        stdio: RUNNER_ORIGIN === "server_runner" ? "pipe" : "ignore",
        env: RUNNER_ORIGIN === "server_runner"
          ? {
              ...process.env,
              DISPLAY: DISPLAY_NAME,
            }
          : process.env,
      },
    );
    if (RUNNER_ORIGIN !== "server_runner") {
      runnerChromeProcess.unref();
    } else {
      pipeChromeLogs(runnerChromeProcess.stdout, "stdout");
      pipeChromeLogs(runnerChromeProcess.stderr, "stderr");
      runnerChromeProcess.on("exit", (code, signal) => {
        console.error(
          "[runner] chrome exited",
          JSON.stringify({ code, signal, runnerId: RUNNER_ID, origin: RUNNER_ORIGIN }),
        );
      });
    }
  }
  return `http://127.0.0.1:${CHROME_DEBUG_PORT}`;
}

interface CdpListTarget {
  id?: string;
  title?: string;
  url?: string;
  type?: string;
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
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
  const deadline = Date.now() + (RUNNER_ORIGIN === "server_runner" ? 30_000 : 8_000);
  let targets: CdpListTarget[] = [];
  while (Date.now() < deadline) {
    try {
      const body = await fetchJsonWithTimeout<CdpListTarget[]>(listUrl, 2_500);
      targets = Array.isArray(body) ? body : [];
      if (targets.some(isUsableCdpPage)) {
        console.info("[runner] found existing CDP page", JSON.stringify({ cdpUrl, count: targets.length }));
        return;
      }
      break;
    } catch (error) {
      if (runnerChromeProcess?.exitCode !== null && runnerChromeProcess?.exitCode !== undefined) {
        throw new Error(`Managed Chromium exited before CDP became reachable (code ${runnerChromeProcess.exitCode}).`);
      }
      console.info(
        "[runner] waiting for CDP target list",
        JSON.stringify({
          cdpUrl,
          error: error instanceof Error ? error.message : String(error),
          remainingMs: Math.max(0, deadline - Date.now()),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
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

  while (Date.now() < deadline) {
    try {
      const body = await fetchJsonWithTimeout<CdpListTarget[]>(listUrl, 2_500);
      targets = Array.isArray(body) ? body : [];
      if (targets.some(isUsableCdpPage)) {
        return;
      }
    } catch {
      if (runnerChromeProcess?.exitCode !== null && runnerChromeProcess?.exitCode !== undefined) {
        throw new Error(`Managed Chromium exited before a usable page appeared (code ${runnerChromeProcess.exitCode}).`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Timed out waiting for a usable CDP page.");
}

async function registerRunnerSession(cdpUrl: string) {
  if (!RUNNER_USER_ID) {
    throw new Error("Runner requires OI_RUNNER_USER_ID to register a browser session.");
  }
  runnerStatus = { ...runnerStatus, state: "registering", error: undefined, cdpUrl };
  console.info("[runner] preparing initial session payload", JSON.stringify({ cdpUrl, runnerId: RUNNER_ID }));
  const pages = await browserSessionAdapter.listPages(cdpUrl);
  console.info("[runner] collected browser pages", JSON.stringify({ count: pages.length, runnerId: RUNNER_ID }));
  const initialFrame = await browserSessionAdapter.captureFrame(cdpUrl);
  console.info(
    "[runner] captured initial frame",
    JSON.stringify({ hasFrame: Boolean(initialFrame), pageId: initialFrame?.page_id ?? null, runnerId: RUNNER_ID }),
  );
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
    metadata: {
      cdp_url: cdpUrl,
      capture_mode: captureMode(),
      ...getBrowserSessionAdapterDiagnostics(),
    },
  });
  console.info("[runner] registered browser session", JSON.stringify({ sessionId: body.session.session_id, runnerId: RUNNER_ID }));
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
  const frame = await browserSessionAdapter.captureFrame(cdpUrl, previewTarget ?? undefined);
  const activePage = pages.find((page) => page.active) ?? (frame ? pages.find((page) => page.id === frame.page_id) : undefined) ?? pages[0];
  await postJson<SessionResponse>("/browser/runners/heartbeat", {
    runner_id: RUNNER_ID,
    session_id: runnerSessionId,
    status: "ready",
    automation_engine: "agent_browser",
    page_id: activePage?.id ?? frame?.page_id ?? null,
    pages: pages.map((page) => ({
      page_id: page.id,
      url: page.url,
      title: page.title,
      is_active: activePage ? page.id === activePage.id : Boolean(page.active),
    })),
    viewport: frame?.viewport,
    metadata: {
      cdp_url: cdpUrl,
      capture_mode: captureMode(),
      ...getBrowserSessionAdapterDiagnostics(),
    },
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
  const message = JSON.stringify({
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
  });
  console.info(
    "[runner] publishing session frame",
    JSON.stringify({
      sessionId: runnerSessionId,
      pageId: frame.page_id,
      chars: message.length,
      screenshotChars: frame.screenshot.length,
    }),
  );
  runnerSocket.send(message);
}

async function publishFrameOnce(cdpUrl: string): Promise<void> {
  if (frameCaptureInFlight) {
    frameCaptureQueued = true;
    return;
  }
  frameCaptureInFlight = true;
  try {
    const frame = await browserSessionAdapter.captureFrame(cdpUrl, previewTarget ?? undefined);
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
  const activeMin = browserSessionAdapter.kind === "window" ? 180 : ACTIVE_FRAME_MS;
  const idleMin = browserSessionAdapter.kind === "window" ? 900 : FRAME_MS;
  const now = Date.now();
  if (now - lastInteractiveInputAt <= ACTIVE_FRAME_WINDOW_MS) {
    return activeMin;
  }
  return idleMin;
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

function scheduleHeartbeatPublish(cdpUrl: string, delayMs: number): void {
  if (runnerImmediateHeartbeatTimer) {
    clearTimeout(runnerImmediateHeartbeatTimer);
  }
  runnerImmediateHeartbeatTimer = setTimeout(() => {
    runnerImmediateHeartbeatTimer = null;
    void sendHeartbeat(cdpUrl).catch((error) => {
      console.error("[runner] immediate heartbeat failed", error);
    });
  }, delayMs);
}

function clearRunnerSocketReconnect(): void {
  if (!runnerSocketReconnectTimer) return;
  clearTimeout(runnerSocketReconnectTimer);
  runnerSocketReconnectTimer = null;
}

function scheduleRunnerSocketReconnect(cdpUrl: string): void {
  if (!runnerSessionId || runnerSocketReconnectTimer) return;
  const delayMs = Math.min(
    RUNNER_SOCKET_RECONNECT_BASE_MS * Math.pow(2, runnerSocketReconnectAttempts),
    RUNNER_SOCKET_RECONNECT_MAX_MS,
  );
  runnerSocketReconnectAttempts += 1;
  runnerSocketReconnectTimer = setTimeout(() => {
    runnerSocketReconnectTimer = null;
    startRunnerSocket(cdpUrl);
  }, delayMs);
}

function startRunnerSocket(cdpUrl: string): void {
  if (!runnerSessionId) return;
  if (runnerSocket && (runnerSocket.readyState === WebSocket.OPEN || runnerSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const socket = new WebSocket(`${wsBaseUrl()}/ws/runner`);
  runnerSocket = socket;

  socket.addEventListener("open", () => {
    clearRunnerSocketReconnect();
    runnerSocketReconnectAttempts = 0;
    runnerStatus = {
      ...runnerStatus,
      enabled: true,
      sessionId: runnerSessionId,
      cdpUrl,
      origin: RUNNER_ORIGIN,
      state: "ready",
      error: undefined,
    };
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
        previewTarget = null;
        lastInteractiveInputAt = Date.now();
        void browserSessionAdapter.navigate(cdpUrl, payload.url).then(() => {
          scheduleHeartbeatPublish(cdpUrl, INPUT_FRAME_DEBOUNCE_MS);
          scheduleFramePublish(cdpUrl, INPUT_FRAME_DEBOUNCE_MS);
        });
      } else if (action === "preview_page") {
        previewTarget = {
          pageId: typeof payload.page_id === "string" ? payload.page_id : undefined,
          url: typeof payload.url === "string" ? payload.url : undefined,
          title: typeof payload.page_title === "string" ? payload.page_title : undefined,
          tabIndex: typeof payload.tab_index === "number" ? payload.tab_index : undefined,
        };
        void publishFrameOnce(cdpUrl);
      } else if (action === "clear_preview_page") {
        previewTarget = null;
        void publishFrameOnce(cdpUrl);
      } else if (action === "activate_page") {
        previewTarget = null;
        lastInteractiveInputAt = Date.now();
        console.info(
          "[runner] activate_page",
          JSON.stringify({
            page_id: typeof payload.page_id === "string" ? payload.page_id : undefined,
            url: typeof payload.url === "string" ? payload.url : undefined,
            page_title: typeof payload.page_title === "string" ? payload.page_title : undefined,
            tab_index: typeof payload.tab_index === "number" ? payload.tab_index : undefined,
          }),
        );
        void browserSessionAdapter
          .activatePage(cdpUrl, {
            pageId: typeof payload.page_id === "string" ? payload.page_id : undefined,
            url: typeof payload.url === "string" ? payload.url : undefined,
            title: typeof payload.page_title === "string" ? payload.page_title : undefined,
            tabIndex: typeof payload.tab_index === "number" ? payload.tab_index : undefined,
          })
          .then(() => {
            scheduleHeartbeatPublish(cdpUrl, INPUT_FRAME_DEBOUNCE_MS);
            scheduleFramePublish(cdpUrl, INPUT_FRAME_DEBOUNCE_MS);
          })
          .catch((error) => {
            console.error("[runner] activate_page failed", error);
          });
      } else if (action === "open_tab") {
        previewTarget = null;
        lastInteractiveInputAt = Date.now();
        void browserSessionAdapter
          .openTab(cdpUrl, typeof payload.url === "string" ? payload.url : "about:blank")
          .then(() => {
            scheduleHeartbeatPublish(cdpUrl, INPUT_FRAME_DEBOUNCE_MS);
            scheduleFramePublish(cdpUrl, INPUT_FRAME_DEBOUNCE_MS);
          });
      } else if (action === "refresh_stream") {
        void publishFrameOnce(cdpUrl);
      } else if (action === "input") {
        lastInteractiveInputAt = Date.now();
        void browserSessionAdapter
          .dispatchInput(cdpUrl, payload, previewTarget ?? {
            pageId: typeof payload.page_id === "string" ? payload.page_id : undefined,
          })
          .then(() => {
            scheduleHeartbeatPublish(cdpUrl, INPUT_FRAME_DEBOUNCE_MS);
            scheduleFramePublish(cdpUrl, INPUT_FRAME_DEBOUNCE_MS);
          });
      }
    }
  });

  socket.addEventListener("close", () => {
    if (runnerSocket === socket) {
      runnerSocket = null;
      scheduleRunnerSocketReconnect(cdpUrl);
    }
  });
  socket.addEventListener("error", () => {
    if (runnerSocket === socket) {
      runnerSocket = null;
      scheduleRunnerSocketReconnect(cdpUrl);
    }
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

  const cdpUrl = await launchManagedChromeIfConfigured();
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
