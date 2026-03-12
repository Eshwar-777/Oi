import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { RunManager } from "../runtime/run-manager.js";
import { loadRuntimeConfig, runtimeConfigSummary, validateRuntimeConfig } from "../runtime/config.js";
import type { AutomationRuntimeRunRequest } from "../contracts/run.js";
import { THIRD_PARTY_NOTICES } from "../adapter/openclaw/third_party_notices.js";

const manager = new RunManager();
const runtimeConfig = loadRuntimeConfig();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: "Not found" });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { error: "Unauthorized" });
}

function isAuthorized(req: IncomingMessage): boolean {
  if (!runtimeConfig.sharedSecret) {
    return true;
  }
  return String(req.headers["x-automation-runtime-secret"] || "").trim() === runtimeConfig.sharedSecret;
}

export function createAutomationRuntimeServer() {
  return createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && requestUrl.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "automation-runtime" });
    }
    if (req.method === "GET" && requestUrl.pathname === "/ready") {
      const missing = validateRuntimeConfig(runtimeConfig);
      return sendJson(res, missing.length === 0 ? 200 : 503, {
        ok: missing.length === 0,
        ready: missing.length === 0,
        detail: missing.length === 0 ? "Runtime ready." : `Missing config: ${missing.join(", ")}`,
        missing,
        summary: runtimeConfigSummary(runtimeConfig),
      });
    }
    if (req.method === "GET" && requestUrl.pathname === "/config") {
      const plannerReady = Boolean(
        runtimeConfig.googleApiKey ||
          (runtimeConfig.googleGenAiUseVertexAi &&
            runtimeConfig.gcpProject &&
            (runtimeConfig.googleApplicationCredentials || runtimeConfig.googleAdcPath)),
      );
      return sendJson(res, 200, {
        available: true,
        host: runtimeConfig.host,
        port: runtimeConfig.port,
        browser: { mode: "cdp" },
        toolsReady: true,
        plannerReady,
        plannerModel: runtimeConfig.plannerModel,
        plannerAuthMode: runtimeConfig.googleGenAiUseVertexAi ? "vertexai" : "api_key",
        plannerAuthSource: runtimeConfig.googleApiKey
          ? "api_key"
          : runtimeConfig.googleApplicationCredentials
            ? "service_account"
            : runtimeConfig.googleAdcPath
              ? "adc"
              : "unconfigured",
        memoryReady: false,
        summary: runtimeConfigSummary(runtimeConfig),
        thirdPartyNotices: THIRD_PARTY_NOTICES.trim(),
      });
    }
    if (!isAuthorized(req)) {
      return unauthorized(res);
    }
    if (req.method === "POST" && requestUrl.pathname === "/runs") {
      const body = (await readJson(req)) as unknown as AutomationRuntimeRunRequest;
      const { run, cursor } = await manager.startRun(body);
      return sendJson(res, 202, { run, cursor });
    }
    const runMatch = requestUrl.pathname.match(/^\/runs\/([^/]+)$/);
    if (req.method === "GET" && runMatch) {
      const run = manager.getRun(runMatch[1] || "");
      if (!run) {
        return notFound(res);
      }
      return sendJson(res, 200, { run });
    }
    const cancelMatch = requestUrl.pathname.match(/^\/runs\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const run = manager.cancelRun(cancelMatch[1] || "");
      if (!run) {
        return notFound(res);
      }
      return sendJson(res, 200, { run });
    }
    const pauseMatch = requestUrl.pathname.match(/^\/runs\/([^/]+)\/pause$/);
    if (req.method === "POST" && pauseMatch) {
      const run = manager.pauseRun(pauseMatch[1] || "");
      if (!run) {
        return notFound(res);
      }
      return sendJson(res, 200, { run });
    }
    const eventsMatch = requestUrl.pathname.match(/^\/runs\/([^/]+)\/events$/);
    if (req.method === "GET" && eventsMatch) {
      const runId = eventsMatch[1] || "";
      const after = Number.parseInt(requestUrl.searchParams.get("after") || "-1", 10);
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");
      for (const event of manager.listEvents(runId, after)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      const unsubscribe = manager.subscribe(runId, (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
      req.on("close", () => {
        unsubscribe();
      });
      return;
    }
    return notFound(res);
  });
}
