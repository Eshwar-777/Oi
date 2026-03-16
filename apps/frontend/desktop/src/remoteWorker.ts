import http, { type IncomingMessage, type ServerResponse } from "http";
import { pipeline } from "stream";
import WebSocket, { WebSocketServer } from "ws";
import { startLocalRunner } from "./main/runner";

if (typeof globalThis.WebSocket === "undefined") {
  (globalThis as any).WebSocket = WebSocket;
}

const port = Number(process.env.PORT || "8080");
const LOCAL_CDP_ORIGIN = process.env.OI_RUNNER_LOCAL_CDP_ORIGIN || "http://127.0.0.1:9222";

type WorkerState =
  | { status: "starting" }
  | { status: "ready"; sessionId: string | null; cdpUrl: string | null }
  | { status: "error"; error: string };

let state: WorkerState = { status: "starting" };
let publicOrigin = "";

function requestOrigin(req: IncomingMessage): string {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0]?.trim();
  const protocol = forwardedProto || "http";
  const host = String(req.headers.host || "").trim();
  return host ? `${protocol}://${host}` : "";
}

function publishedCdpUrl(): string | null {
  const globalUrl = String((globalThis as any).__oiPublicCdpUrl || "").trim();
  if (globalUrl) return globalUrl;
  if (publicOrigin) return `${publicOrigin}/cdp`;
  if (state.status === "ready") return state.cdpUrl;
  return null;
}

function updatePublicOrigin(req: IncomingMessage): void {
  const origin = requestOrigin(req);
  if (!origin || origin === publicOrigin) return;
  publicOrigin = origin;
  const publicCdpUrl = `${origin}/cdp`;
  (globalThis as any).__oiPublicCdpUrl = publicCdpUrl;
  const refresh = (globalThis as any).__oiRunnerRefreshSessionMetadata;
  if (typeof refresh === "function") {
    refresh();
  }
}

function jsonResponse(body: object, statusCode = 200): string {
  return JSON.stringify(body);
}

function requestWsOrigin(req: IncomingMessage): string {
  const origin = requestOrigin(req);
  if (!origin) return "";
  return origin.replace(/^http/i, "ws");
}

function rewriteCdpUrl(raw: string, req: IncomingMessage): string {
  const normalized = String(raw || "").trim();
  if (!normalized) {
    return normalized;
  }
  try {
    const parsed = new URL(normalized);
    const localOrigin = new URL(LOCAL_CDP_ORIGIN);
    const sameLocalOrigin =
      parsed.protocol === localOrigin.protocol &&
      parsed.hostname === localOrigin.hostname &&
      parsed.port === localOrigin.port;
    if (!sameLocalOrigin) {
      return normalized;
    }
    const wsOrigin = requestWsOrigin(req);
    const httpOrigin = requestOrigin(req);
    if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
      return wsOrigin ? `${wsOrigin}/cdp${parsed.pathname}${parsed.search}` : normalized;
    }
    return httpOrigin ? `${httpOrigin}/cdp${parsed.pathname}${parsed.search}` : normalized;
  } catch {
    return normalized;
  }
}

function rewriteCdpPayload(value: unknown, req: IncomingMessage): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteCdpPayload(entry, req));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "webSocketDebuggerUrl" || key === "devtoolsFrontendUrl") && typeof entry === "string") {
      out[key] = rewriteCdpUrl(entry, req);
      continue;
    }
    out[key] = rewriteCdpPayload(entry, req);
  }
  return out;
}

function proxyHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  const path = req.url || "/";
  const targetPath = path.replace(/^\/cdp/, "") || "/";
  const target = new URL(targetPath, LOCAL_CDP_ORIGIN);
  const upstream = http.request(
    target,
    {
      method: req.method || "GET",
      headers: {
        ...req.headers,
        host: target.host,
      },
    },
    (upstreamRes) => {
      const shouldRewriteJson = req.method === "GET" && target.pathname.startsWith("/json");
      if (shouldRewriteJson) {
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        upstreamRes.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            const payload = JSON.parse(raw);
            const rewritten = JSON.stringify(rewriteCdpPayload(payload, req));
            const headers = { ...upstreamRes.headers };
            delete headers["content-length"];
            res.writeHead(upstreamRes.statusCode || 502, {
              ...headers,
              "content-type": "application/json; charset=utf-8",
              "content-length": Buffer.byteLength(rewritten),
            });
            res.end(rewritten);
          } catch {
            res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
            res.end(raw);
          }
        });
        return;
      }
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      pipeline(upstreamRes, res, () => undefined);
    },
  );
  upstream.on("error", (error) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, 502));
  });
  pipeline(req, upstream, () => undefined);
}

const wsServer = new WebSocketServer({ noServer: true });

wsServer.on("connection", (clientSocket, req) => {
  updatePublicOrigin(req);
  const path = req.url || "/";
  const targetPath = path.replace(/^\/cdp/, "") || "/";
  const target = new URL(targetPath, LOCAL_CDP_ORIGIN);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  const upstream = new WebSocket(target.toString());

  const closeBoth = () => {
    if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close();
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
  };

  upstream.on("open", () => {
    clientSocket.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      }
    });
    clientSocket.on("close", closeBoth);
    clientSocket.on("error", closeBoth);
  });
  upstream.on("message", (data, isBinary) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(data, { binary: isBinary });
    }
  });
  upstream.on("close", closeBoth);
  upstream.on("error", () => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close();
    }
  });
});

const server = http.createServer((req, res) => {
  const path = req.url || "/";
  updatePublicOrigin(req);
  const isHealthy = state.status === "ready";
  if (path === "/healthz" || path === "/ready" || path === "/") {
    const payload =
      state.status === "error"
        ? { ok: false, state: state.status, error: state.error }
        : state.status === "ready"
          ? { ok: true, state: state.status, sessionId: state.sessionId, cdpUrl: publishedCdpUrl() }
          : { ok: false, state: state.status };
    res.writeHead(isHealthy ? 200 : state.status === "error" ? 500 : 503, {
      "Content-Type": "application/json",
    });
    res.end(jsonResponse(payload, isHealthy ? 200 : state.status === "error" ? 500 : 503));
    return;
  }
  if (path === "/cdp" || path.startsWith("/cdp/")) {
    proxyHttpRequest(req, res);
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(jsonResponse({ ok: false, error: "not_found" }, 404));
});

server.on("upgrade", (req, socket, head) => {
  const path = req.url || "/";
  if (!(path === "/cdp" || path.startsWith("/cdp/"))) {
    socket.destroy();
    return;
  }
  wsServer.handleUpgrade(req, socket, head, (clientSocket) => {
    wsServer.emit("connection", clientSocket, req);
  });
});

async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  process.stdout.write(`[remote-worker] listening on 0.0.0.0:${port}\n`);
  const status = await startLocalRunner();
  if (status.state === "error") {
    state = { status: "error", error: status.error || "Runner failed to start." };
    throw new Error(status.error || "Runner failed to start.");
  }
  state = {
    status: "ready",
    sessionId: status.sessionId,
    cdpUrl: publishedCdpUrl() || status.cdpUrl,
  };
}

void main().catch((error) => {
  state = {
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  };
  process.stderr.write(`${state.error}\n`);
  process.exitCode = 1;
});
