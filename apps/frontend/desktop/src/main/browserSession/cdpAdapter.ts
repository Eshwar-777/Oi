import type { BrowserPageTarget, BrowserSessionAdapter, BrowserSessionFrame, BrowserSessionInputPayload } from "./adapter";

async function cdpCommand<T = unknown>(
  socket: WebSocket,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const id = Math.floor(Math.random() * 1_000_000_000);
  return await new Promise<T>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          id?: number;
          result?: T;
          error?: { message?: string };
        };
        if (payload.id !== id) return;
        socket.removeEventListener("message", onMessage as EventListener);
        if (payload.error) {
          reject(new Error(payload.error.message || `CDP ${method} failed`));
          return;
        }
        resolve((payload.result ?? {}) as T);
      } catch (error) {
        socket.removeEventListener("message", onMessage as EventListener);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    socket.addEventListener("message", onMessage as EventListener);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

interface CachedSocketEntry {
  ready: Promise<WebSocket>;
  queue: Promise<void>;
  socket: WebSocket | null;
}

interface CachedTargetEntry {
  target: BrowserPageTarget;
  resolvedAt: number;
}

async function openSocket(webSocketDebuggerUrl: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const handleOpen = () => {
      socket.removeEventListener("error", handleError as EventListener);
      resolve(socket);
    };
    const handleError = () => {
      socket.removeEventListener("open", handleOpen as EventListener);
      reject(new Error("CDP websocket error"));
    };
    socket.addEventListener("open", handleOpen as EventListener, { once: true });
    socket.addEventListener("error", handleError as EventListener, { once: true });
  });
}

async function readViewport(socket: WebSocket): Promise<{ width: number; height: number; dpr: number } | undefined> {
  const result: {
    result?: {
      value?: { width?: number; height?: number; dpr?: number };
    };
  } | null = await cdpCommand<{
    result?: {
      value?: { width?: number; height?: number; dpr?: number };
    };
  }>(socket, "Runtime.evaluate", {
    expression: "({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 })",
    returnByValue: true,
  }).catch(() => null);
  const value = result?.result?.value;
  if (!value?.width || !value?.height) return undefined;
  return {
    width: Math.round(value.width),
    height: Math.round(value.height),
    dpr: typeof value.dpr === "number" && Number.isFinite(value.dpr) ? value.dpr : 1,
  };
}

export class CdpBrowserSessionAdapter implements BrowserSessionAdapter {
  readonly kind = "cdp";
  readonly runtime = "builtin_cdp";
  readonly version = "local";
  private readonly sockets = new Map<string, CachedSocketEntry>();
  private readonly targets = new Map<string, CachedTargetEntry>();
  private readonly targetTtlMs = 5_000;

  private dropSocket(webSocketDebuggerUrl: string) {
    const entry = this.sockets.get(webSocketDebuggerUrl);
    this.sockets.delete(webSocketDebuggerUrl);
    try {
      entry?.socket?.close();
    } catch {
      // best effort cleanup
    }
  }

  private invalidateTarget(cdpUrl: string) {
    this.targets.delete(cdpUrl);
  }

  private async resolveTarget(cdpUrl: string, forceRefresh = false): Promise<BrowserPageTarget> {
    const cached = this.targets.get(cdpUrl);
    if (!forceRefresh && cached && Date.now() - cached.resolvedAt < this.targetTtlMs && cached.target.webSocketDebuggerUrl) {
      return cached.target;
    }

    const targets = await this.listPages(cdpUrl);
    const target = targets[0];
    if (!target?.webSocketDebuggerUrl) {
      throw new Error("No debuggable browser page available.");
    }
    this.targets.set(cdpUrl, {
      target,
      resolvedAt: Date.now(),
    });
    return target;
  }

  private async withPersistentTargetSocket<T>(
    cdpUrl: string,
    fn: (socket: WebSocket, target: BrowserPageTarget) => Promise<T>,
  ): Promise<T> {
    const execute = async (target: BrowserPageTarget): Promise<T> => {
      const webSocketDebuggerUrl = target.webSocketDebuggerUrl;
      if (!webSocketDebuggerUrl) {
        throw new Error("No debuggable browser page available.");
      }

      let entry = this.sockets.get(webSocketDebuggerUrl);
      if (!entry) {
        entry = {
          ready: openSocket(webSocketDebuggerUrl),
          queue: Promise.resolve(),
          socket: null,
        };
        this.sockets.set(webSocketDebuggerUrl, entry);
        entry.ready
          .then((socket) => {
            entry!.socket = socket;
            socket.addEventListener("close", () => this.dropSocket(webSocketDebuggerUrl), { once: true });
            socket.addEventListener("error", () => this.dropSocket(webSocketDebuggerUrl), { once: true });
          })
          .catch(() => {
            this.dropSocket(webSocketDebuggerUrl);
          });
      }

      const currentEntry = entry;
      const run = currentEntry.queue.then(async () => {
        const socket = await currentEntry.ready;
        if (socket.readyState !== WebSocket.OPEN) {
          this.dropSocket(webSocketDebuggerUrl);
          throw new Error("CDP websocket closed");
        }
        return await fn(socket, target);
      });

      currentEntry.queue = run.then(
        () => undefined,
        () => undefined,
      );
      return await run;
    };

    const target = await this.resolveTarget(cdpUrl);
    try {
      return await execute(target);
    } catch (error) {
      this.dropSocket(target.webSocketDebuggerUrl ?? "");
      this.invalidateTarget(cdpUrl);
      const refreshedTarget = await this.resolveTarget(cdpUrl, true);
      return await execute(refreshedTarget);
    }
  }

  async listPages(cdpUrl: string): Promise<BrowserPageTarget[]> {
    const response = await fetch(`${cdpUrl}/json/list`);
    if (!response.ok) {
      throw new Error(`Failed to list CDP targets (${response.status})`);
    }
    const body = (await response.json()) as BrowserPageTarget[];
    return Array.isArray(body) ? body.filter((item) => item.type === "page") : [];
  }

  async captureFrame(cdpUrl: string): Promise<BrowserSessionFrame | null> {
    return await this.withPersistentTargetSocket(cdpUrl, async (socket, target) => {
      await cdpCommand(socket, "Page.enable");
      const viewport = await readViewport(socket);
      const screenshotResult = await cdpCommand<{ data: string }>(socket, "Page.captureScreenshot", {
        format: "png",
      });
      return {
        screenshot: `data:image/png;base64,${screenshotResult.data}`,
        current_url: target.url,
        page_title: target.title,
        page_id: target.id,
        viewport,
      };
    }).catch(() => null);
  }

  async navigate(cdpUrl: string, url: string): Promise<void> {
    await this.withPersistentTargetSocket(cdpUrl, async (socket) => {
      await cdpCommand(socket, "Page.enable");
      await cdpCommand(socket, "Page.navigate", { url });
    });
    this.invalidateTarget(cdpUrl);
  }

  async dispatchInput(cdpUrl: string, payload: BrowserSessionInputPayload): Promise<void> {
    await this.withPersistentTargetSocket(cdpUrl, async (socket) => {
      await cdpCommand(socket, "Page.enable");
      const x = typeof payload.x === "number" ? payload.x : 0;
      const y = typeof payload.y === "number" ? payload.y : 0;
      const button = payload.button ?? "left";

      if (payload.input_type === "click") {
        await cdpCommand(socket, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
        await cdpCommand(socket, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
      } else if (payload.input_type === "move") {
        await cdpCommand(socket, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
      } else if (payload.input_type === "mouse_down") {
        await cdpCommand(socket, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
      } else if (payload.input_type === "mouse_up") {
        await cdpCommand(socket, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
      } else if (payload.input_type === "scroll") {
        await cdpCommand(socket, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX: payload.delta_x ?? 0,
          deltaY: payload.delta_y ?? 480,
        });
      } else if (payload.input_type === "type" && typeof payload.text === "string" && payload.text.length > 0) {
        await cdpCommand(socket, "Input.insertText", { text: payload.text });
      } else if (payload.input_type === "keypress" && typeof payload.key === "string" && payload.key.length > 0) {
        await cdpCommand(socket, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: payload.key,
          text: payload.key.length === 1 ? payload.key : undefined,
        });
        await cdpCommand(socket, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: payload.key,
        });
      }
    });
  }
}
