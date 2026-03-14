import http from "http";
import { startLocalRunner } from "./main/runner";

const port = Number(process.env.PORT || "8080");

type WorkerState =
  | { status: "starting" }
  | { status: "ready"; sessionId: string | null; cdpUrl: string | null }
  | { status: "error"; error: string };

let state: WorkerState = { status: "starting" };

function jsonResponse(body: object, statusCode = 200): string {
  return JSON.stringify(body);
}

const server = http.createServer((req, res) => {
  const path = req.url || "/";
  const isHealthy = state.status === "ready";
  if (path === "/healthz" || path === "/ready" || path === "/") {
    const payload =
      state.status === "error"
        ? { ok: false, state: state.status, error: state.error }
        : state.status === "ready"
          ? { ok: true, state: state.status, sessionId: state.sessionId, cdpUrl: state.cdpUrl }
          : { ok: false, state: state.status };
    res.writeHead(isHealthy ? 200 : state.status === "error" ? 500 : 503, {
      "Content-Type": "application/json",
    });
    res.end(jsonResponse(payload, isHealthy ? 200 : state.status === "error" ? 500 : 503));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(jsonResponse({ ok: false, error: "not_found" }, 404));
});

async function main(): Promise<void> {
  server.listen(port);
  const status = await startLocalRunner();
  if (status.state === "error") {
    state = { status: "error", error: status.error || "Runner failed to start." };
    throw new Error(status.error || "Runner failed to start.");
  }
  state = {
    status: "ready",
    sessionId: status.sessionId,
    cdpUrl: status.cdpUrl,
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
