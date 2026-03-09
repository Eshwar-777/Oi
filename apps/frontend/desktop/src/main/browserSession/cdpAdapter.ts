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

async function withTargetSocket<T>(
  targets: BrowserPageTarget[],
  fn: (socket: WebSocket, target: BrowserPageTarget) => Promise<T>,
): Promise<T> {
  const target = targets[0];
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("No debuggable browser page available.");
  }
  return await new Promise<T>((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl!);
    socket.addEventListener("open", () => {
      void fn(socket, target).then(resolve).catch(reject);
    });
    socket.addEventListener("error", () => reject(new Error("CDP websocket error")));
  }).finally(() => undefined);
}

export class CdpBrowserSessionAdapter implements BrowserSessionAdapter {
  readonly kind = "cdp";
  readonly runtime = "builtin_cdp";
  readonly version = "local";

  async listPages(cdpUrl: string): Promise<BrowserPageTarget[]> {
    const response = await fetch(`${cdpUrl}/json/list`);
    if (!response.ok) {
      throw new Error(`Failed to list CDP targets (${response.status})`);
    }
    const body = (await response.json()) as BrowserPageTarget[];
    return Array.isArray(body) ? body.filter((item) => item.type === "page") : [];
  }

  async captureFrame(cdpUrl: string): Promise<BrowserSessionFrame | null> {
    const targets = await this.listPages(cdpUrl);
    return await withTargetSocket(targets, async (socket, target) => {
      await cdpCommand(socket, "Page.enable");
      const screenshotResult = await cdpCommand<{ data: string }>(socket, "Page.captureScreenshot", {
        format: "png",
      });
      socket.close();
      return {
        screenshot: `data:image/png;base64,${screenshotResult.data}`,
        current_url: target.url,
        page_title: target.title,
        page_id: target.id,
      };
    }).catch(() => null);
  }

  async navigate(cdpUrl: string, url: string): Promise<void> {
    const targets = await this.listPages(cdpUrl);
    await withTargetSocket(targets, async (socket) => {
      await cdpCommand(socket, "Page.enable");
      await cdpCommand(socket, "Page.navigate", { url });
      socket.close();
    });
  }

  async dispatchInput(cdpUrl: string, payload: BrowserSessionInputPayload): Promise<void> {
    const targets = await this.listPages(cdpUrl);
    await withTargetSocket(targets, async (socket) => {
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

      socket.close();
    });
  }
}
