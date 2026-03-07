import { PING_INTERVAL_MS } from "./constants";

export async function captureScreenshotBase64(
  tabId: number,
  debuggerAttachedTabs: Set<number>,
): Promise<string | null> {
  if (debuggerAttachedTabs.has(tabId)) {
    try {
      const result = (await chrome.debugger.sendCommand(
        { tabId },
        "Page.captureScreenshot",
        { format: "jpeg", quality: 60 },
      )) as { data: string };
      return `data:image/jpeg;base64,${result.data}`;
    } catch {
      // fall through
    }
  }
  try {
    return await chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 60 });
  } catch {
    return null;
  }
}

export async function captureAndSendScreenshot(params: {
  tabId: number;
  runId?: string;
  currentRunId: string;
  socket: WebSocket | null;
  debuggerAttachedTabs: Set<number>;
}): Promise<void> {
  const { tabId, runId, currentRunId, socket, debuggerAttachedTabs } = params;
  const dataUrl = await captureScreenshotBase64(tabId, debuggerAttachedTabs);
  if (!dataUrl) return;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        type: "browser_frame",
        payload: {
          screenshot: dataUrl,
          current_url: tab?.url ?? "",
          page_title: tab?.title ?? "",
          tab_id: tabId,
          run_id: runId ?? currentRunId,
          timestamp: new Date().toISOString(),
        },
      }),
    );
  }
}

export function createScreenshotStreamController(params: {
  getAutomationPaused: () => boolean;
  getFirstAttachedTabId: () => number | null;
  getCurrentRunId: () => string;
  getSocket: () => WebSocket | null;
  debuggerAttachedTabs: Set<number>;
  onError?: (error: unknown) => void;
}): { start: (intervalMs: number) => void; stop: () => void } {
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const stop = () => {
    inFlight = false;
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  const start = (intervalMs: number) => {
    stop();
    intervalId = setInterval(() => {
      if (params.getAutomationPaused() || inFlight) return;
      const tabId = params.getFirstAttachedTabId();
      if (!tabId) return;
      inFlight = true;
      void captureAndSendScreenshot({
        tabId,
        runId: params.getCurrentRunId(),
        currentRunId: params.getCurrentRunId(),
        socket: params.getSocket(),
        debuggerAttachedTabs: params.debuggerAttachedTabs,
      })
        .catch((error) => {
          params.onError?.(error);
        })
        .finally(() => {
          inFlight = false;
        });
    }, intervalMs);
  };

  return { start, stop };
}

export function createPingController(getSocket: () => WebSocket | null): {
  start: () => void;
  stop: () => void;
} {
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  const start = () => {
    stop();
    intervalId = setInterval(() => {
      const socket = getSocket();
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping", timestamp: new Date().toISOString() }));
      }
    }, PING_INTERVAL_MS);
  };

  return { start, stop };
}
