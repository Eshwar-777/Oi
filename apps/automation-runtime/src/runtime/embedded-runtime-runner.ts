import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeEvent } from "../contracts/events.js";
import type { AutomationRuntimeRunRequest } from "../contracts/run.js";
import { loadRuntimeConfig } from "./config.js";

export type AgentBrowserBatchResult = {
  success: boolean;
  rows: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  error?: string;
};

export type EmitEvent = (type: RuntimeEvent["type"], payload: Record<string, unknown>) => void;

export type PreparedEmbeddedRuntimeRun = {
  request: AutomationRuntimeRunRequest;
  modelRef?: string;
  sessionId: string;
  sessionKey: string;
  stateDir: string;
  workspaceDir: string;
  bridgeEnv: Record<string, string>;
};

type BridgeInput = {
  request: AutomationRuntimeRunRequest;
  sessionId: string;
  sessionKey: string;
  modelRef?: string;
  workspaceDir: string;
};

const BRIDGE_PREFIX = "__OI_RUNTIME__";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(MODULE_DIR, "..", "..");
const RUNTIME_BRIDGE_PATH = path.join(PACKAGE_ROOT, "vendor", "runtime-agent-bridge.ts");
const RUNTIME_BRIDGE_TIMEOUT_MS = 300_000;

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeAgentId(value: string | undefined): string {
  const trimmed = String(value || "").trim().toLowerCase();
  return trimmed || "main";
}

function normalizeSessionName(value: string | undefined): string {
  const trimmed = String(value || "").trim().toLowerCase();
  return trimmed || "ui";
}

function sanitizePathSegment(value: string | undefined): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "default";
}

function resolveRunStateDir(scopeId: string): string {
  const override = process.env.RUNTIME_STATE_DIR?.trim();
  if (override) {
    return path.resolve(override, sanitizePathSegment(scopeId));
  }
  return path.join(os.tmpdir(), "oi-automation-runtime", "runtime", sanitizePathSegment(scopeId));
}

function splitModelRef(model: string): { providerOverride?: string; modelOverride: string } {
  const trimmed = String(model || "").trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return { modelOverride: trimmed };
  }
  return {
    providerOverride: trimmed.slice(0, slashIndex),
    modelOverride: trimmed.slice(slashIndex + 1),
  };
}

async function loadSessionStore(storePath: string): Promise<Record<string, Record<string, unknown>>> {
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, Record<string, unknown>>)
      : {};
  } catch {
    return {};
  }
}

async function saveSessionStore(
  storePath: string,
  store: Record<string, Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

async function ensureUiSession(params: {
  scopeId: string;
  sessionId: string;
  model?: string;
  agentId?: string;
  sessionName?: string;
}): Promise<{ stateDir: string; sessionKey: string; sessionId: string }> {
  const stateDir = resolveRunStateDir(params.scopeId);
  const agentId = normalizeAgentId(params.agentId);
  const sessionName = normalizeSessionName(params.sessionName || params.sessionId);
  const sessionStorePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
  const store = await loadSessionStore(sessionStorePath);
  const sessionKey = `agent:${agentId}:${sessionName}`;
  const existing = store[sessionKey];
  const nextSession: Record<string, unknown> = {
    sessionId: String(existing?.sessionId || params.sessionId).trim() || params.sessionId,
    updatedAt: Date.now(),
  };
  if (params.model) {
    const modelRef = splitModelRef(params.model);
    nextSession.modelOverride = modelRef.modelOverride;
    nextSession.providerOverride = modelRef.providerOverride;
  }
  store[sessionKey] = nextSession;
  await saveSessionStore(sessionStorePath, store);
  return {
    stateDir,
    sessionKey,
    sessionId: String(store[sessionKey]?.sessionId || params.sessionId),
  };
}

function buildDirectCdpProfileConfig(cdpUrl: string): Record<string, unknown> {
  return {
    browser: {
      defaultProfile: "web-cdp",
      profiles: {
        "web-cdp": {
          cdpUrl,
          attachOnly: true,
          color: "#0B57D0",
        },
      },
    },
  };
}

async function ensureBrowserConfig(stateDir: string, cdpUrl: string): Promise<string> {
  const configPath = path.join(stateDir, "runtime.json");
  await fs.mkdir(stateDir, { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const nextConfig = {
    ...existing,
    tools: {
      ...((existing.tools && typeof existing.tools === "object") ? existing.tools : {}),
      allow: ["browser"],
    },
    agents: {
      ...((existing.agents && typeof existing.agents === "object") ? existing.agents : {}),
      defaults: {
        ...(
          existing.agents &&
          typeof existing.agents === "object" &&
          (existing.agents as Record<string, unknown>).defaults &&
          typeof (existing.agents as Record<string, unknown>).defaults === "object"
            ? ((existing.agents as Record<string, unknown>).defaults as Record<string, unknown>)
            : {}
        ),
        skipBootstrap: true,
      },
    },
    gateway: {
      ...((existing.gateway && typeof existing.gateway === "object")
        ? (existing.gateway as Record<string, unknown>)
        : {}),
      nodes: {
        ...(
          existing.gateway &&
          typeof existing.gateway === "object" &&
          (existing.gateway as Record<string, unknown>).nodes &&
          typeof (existing.gateway as Record<string, unknown>).nodes === "object"
            ? (((existing.gateway as Record<string, unknown>).nodes as Record<string, unknown>) ??
              {})
            : {}
        ),
        browser: {
          mode: "off",
        },
      },
    },
    browser: buildDirectCdpProfileConfig(cdpUrl).browser,
  };
  await fs.writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return configPath;
}

async function seedRuntimeAuthProfile(params: {
  stateDir: string;
  configPath: string;
  modelRef?: string;
  emit: EmitEvent;
}): Promise<void> {
  const runtimeConfig = loadRuntimeConfig();
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(params.configPath, "utf8")) as Record<string, unknown>;
  } catch {
    existing = {};
  }

  const agents =
    existing.agents && typeof existing.agents === "object"
      ? ({ ...(existing.agents as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const defaults =
    agents.defaults && typeof agents.defaults === "object"
      ? ({ ...(agents.defaults as Record<string, unknown>) } as Record<string, unknown>)
      : {};

  if (params.modelRef) {
    defaults.model = { primary: params.modelRef };
  }
  agents.defaults = defaults;

  const auth =
    existing.auth && typeof existing.auth === "object"
      ? ({ ...(existing.auth as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const profiles =
    auth.profiles && typeof auth.profiles === "object"
      ? ({ ...(auth.profiles as Record<string, unknown>) } as Record<string, unknown>)
      : {};

  if (runtimeConfig.googleApiKey) {
    profiles["google:default"] = { provider: "google", mode: "api_key" };
  } else if (runtimeConfig.googleGenAiUseVertexAi) {
    profiles["google-vertex:default"] = { provider: "google-vertex", mode: "api_key" };
  }
  if (Object.keys(profiles).length > 0) {
    auth.profiles = profiles;
  }

  const nextConfig = {
    ...existing,
    agents,
    ...(Object.keys(auth).length > 0 ? { auth } : {}),
  };

  await fs.writeFile(params.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  params.emit("run.log", {
    level: "info",
    source: "runtime",
    message: `Seeded runtime config for ${params.modelRef || runtimeConfig.plannerModel || "default model"}`,
    createdAt: nowIso(),
  });
}

function stripGatewayAuthEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string> {
  const next = { ...env } as Record<string, string | undefined>;
  delete next.RUNTIME_GATEWAY_TOKEN;
  delete next.CLAWDBOT_GATEWAY_TOKEN;
  delete next.RUNTIME_GATEWAY_PASSWORD;
  delete next.CLAWDBOT_GATEWAY_PASSWORD;
  return Object.fromEntries(
    Object.entries(next).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function mapPayloadsToRows(payloads: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return payloads.map((payload, index) => ({
    index,
    text: payload.text ?? null,
    mediaUrl: payload.mediaUrl ?? null,
    mediaUrls: Array.isArray(payload.mediaUrls) ? payload.mediaUrls : [],
  }));
}

function extractVisibleText(payloads: Array<Record<string, unknown>>): string {
  return payloads
    .map((payload) => String(payload.text || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export async function prepareEmbeddedRuntimeRun(params: {
  request: AutomationRuntimeRunRequest;
  emit: EmitEvent;
  modelRef?: string;
}): Promise<PreparedEmbeddedRuntimeRun> {
  const { request, emit, modelRef } = params;
  const scopeId = request.browserSessionId || request.sessionId || request.runId;
  const embeddedSessionBaseId = request.runId || request.sessionId;
  const { stateDir, sessionKey, sessionId } = await ensureUiSession({
    scopeId,
    sessionId: embeddedSessionBaseId,
    model: modelRef,
  });
  const configPath = await ensureBrowserConfig(stateDir, request.browser.cdpUrl);
  await seedRuntimeAuthProfile({ stateDir, configPath, modelRef, emit });
  const workspaceDir = request.cwd ? path.resolve(request.cwd) : PACKAGE_ROOT;
  const runtimeConfig = loadRuntimeConfig();
  const bridgeEnv: Record<string, string> = {
    RUNTIME_DISABLE_EXTENSION_PROFILE: "1",
    RUNTIME_STATE_DIR: stateDir,
    RUNTIME_CONFIG_PATH: configPath,
    RUNTIME_SKIP_CHANNELS: "1",
    CLAWDBOT_SKIP_CHANNELS: "1",
    OI_RUNNER_CDP_URL: request.browser.cdpUrl,
  };
  if (runtimeConfig.googleApiKey) {
    bridgeEnv.GOOGLE_API_KEY = runtimeConfig.googleApiKey;
  }
  if (runtimeConfig.googleGenAiUseVertexAi) {
    bridgeEnv.GOOGLE_GENAI_USE_VERTEXAI = "true";
  }
  if (runtimeConfig.gcpProject) {
    bridgeEnv.GOOGLE_CLOUD_PROJECT = runtimeConfig.gcpProject;
    bridgeEnv.GCLOUD_PROJECT = runtimeConfig.gcpProject;
  }
  if (runtimeConfig.gcpLocation) {
    bridgeEnv.GOOGLE_CLOUD_LOCATION = runtimeConfig.gcpLocation;
  }
  if (runtimeConfig.googleApplicationCredentials) {
    bridgeEnv.GOOGLE_APPLICATION_CREDENTIALS = runtimeConfig.googleApplicationCredentials;
  }
  emit("run.log", {
    level: "info",
    source: "runtime",
    message: `Prepared Runtime session ${sessionKey}${modelRef ? ` using ${modelRef}` : " using Runtime defaults"}`,
    createdAt: nowIso(),
  });
  return {
    request,
    modelRef,
    sessionId,
    sessionKey,
    stateDir,
    workspaceDir,
    bridgeEnv,
  };
}

export async function prepareEmbeddedRuntimeRetryRun(params: {
  prepared: PreparedEmbeddedRuntimeRun;
  emit: EmitEvent;
}): Promise<PreparedEmbeddedRuntimeRun> {
  const request = params.prepared.request;
  const retrySessionId = `${request.runId || request.sessionId}-retry-${Date.now().toString(36)}`;
  const { stateDir, sessionKey, sessionId } = await ensureUiSession({
    scopeId: request.browserSessionId || request.sessionId || request.runId,
    sessionId: retrySessionId,
    model: params.prepared.modelRef,
  });
  const retryConfigPath = await ensureBrowserConfig(stateDir, request.browser.cdpUrl);
  await seedRuntimeAuthProfile({
    stateDir,
    configPath: retryConfigPath,
    modelRef: params.prepared.modelRef,
    emit: params.emit,
  });
  return {
    ...params.prepared,
    stateDir,
    sessionKey,
    sessionId,
  };
}

export async function restartEmbeddedBrowserBridgeDaemons(): Promise<void> {
  const child = spawn(
    "sh",
    [
      "-lc",
      "pids=$(ps -ax -o pid= -o command= | awk '/node_modules\\/agent-browser\\/.*dist\\/daemon\\.js/ {print $1}'); if [ -n \"$pids\" ]; then kill $pids 2>/dev/null || true; fi",
    ],
    {
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  await new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
}

export async function executePreparedEmbeddedRuntimeRun(params: {
  prepared: PreparedEmbeddedRuntimeRun;
  request?: AutomationRuntimeRunRequest;
  emit: EmitEvent;
  signal?: AbortSignal;
}): Promise<AgentBrowserBatchResult> {
  const input: BridgeInput = {
    request: params.request || params.prepared.request,
    sessionId: params.prepared.sessionId,
    sessionKey: params.prepared.sessionKey,
    modelRef: params.prepared.modelRef,
    workspaceDir: params.prepared.workspaceDir,
  };
  const bridgeEnv = {
    ...stripGatewayAuthEnv(process.env),
    ...params.prepared.bridgeEnv,
  };
  return await new Promise<AgentBrowserBatchResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", RUNTIME_BRIDGE_PATH], {
      cwd: PACKAGE_ROOT,
      env: bridgeEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    let resultPayload: AgentBrowserBatchResult | null = null;
    let resultExitTimer: NodeJS.Timeout | null = null;
    const abortHandler = () => {
      if (settled) {
        return;
      }
      clearTimeout(timeout);
      child.kill("SIGTERM");
      reject(new Error("Runtime browser run aborted."));
    };
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      params.emit("run.log", {
        level: "error",
        source: "runtime",
        message: `Runtime bridge exceeded ${RUNTIME_BRIDGE_TIMEOUT_MS}ms and was terminated.`,
        createdAt: nowIso(),
      });
      child.kill("SIGTERM");
      settle({
        success: false,
        rows: [],
        metadata: {
          terminalCode: "EXECUTION_FAILED",
          sessionId: input.sessionId,
          sessionKey: input.sessionKey,
          model: input.modelRef,
        },
        error: `Runtime bridge timed out after ${RUNTIME_BRIDGE_TIMEOUT_MS}ms.`,
      });
    }, RUNTIME_BRIDGE_TIMEOUT_MS);

    const settle = (payload: AgentBrowserBatchResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (resultExitTimer) {
        clearTimeout(resultExitTimer);
        resultExitTimer = null;
      }
      params.signal?.removeEventListener("abort", abortHandler);
      resolve(payload);
    };

    const settleStructuredResult = (payload: AgentBrowserBatchResult) => {
      resultPayload = payload;
      settle(payload);
      // The bridge occasionally keeps handles open briefly after emitting the final
      // structured result. Nudge it to exit, but do not block terminal state on it.
      resultExitTimer = setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGTERM");
        }
      }, 50);
    };

    if (params.signal) {
      if (params.signal.aborted) {
        abortHandler();
        return;
      }
      params.signal.addEventListener("abort", abortHandler, { once: true });
    }

    const handleStructuredLine = (line: string) => {
      if (!line.startsWith(BRIDGE_PREFIX)) {
        params.emit("run.log", {
          level: "info",
          source: "runtime-stdout",
          message: line,
          createdAt: nowIso(),
        });
        return;
      }
      const raw = line.slice(BRIDGE_PREFIX.length);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        params.emit("run.log", {
          level: "error",
          source: "runtime",
          message: `Failed to parse Runtime bridge payload: ${raw}`,
          createdAt: nowIso(),
        });
        return;
      }
      if (message.kind === "event") {
        params.emit(String(message.eventType) as RuntimeEvent["type"], {
          ...(typeof message.payload === "object" && message.payload ? message.payload : {}),
        });
        return;
      }
      if (message.kind === "result") {
        const payloads = Array.isArray(message.payloads)
          ? (message.payloads as Array<Record<string, unknown>>)
          : [];
        const meta =
          message.meta && typeof message.meta === "object"
            ? (message.meta as Record<string, unknown>)
            : {};
        const payload = {
          success: Boolean(message.success),
          rows: mapPayloadsToRows(payloads),
          metadata: {
            payloads,
            meta,
            sessionId: input.sessionId,
            sessionKey: input.sessionKey,
            model: input.modelRef,
            text: extractVisibleText(payloads),
          },
          error: typeof message.error === "string" ? message.error : undefined,
        };
        settleStructuredResult(payload);
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutBuffer += chunk.toString();
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line) {
          handleStructuredLine(line);
        }
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderrBuffer += text;
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        params.emit("run.log", {
          level: "warn",
          source: "runtime-stderr",
          message: trimmed,
          createdAt: nowIso(),
        });
      }
    });

    child.once("error", (error) => {
      settle({
        success: false,
        rows: [],
        metadata: {
          terminalCode: "EXECUTION_FAILED",
          sessionId: input.sessionId,
          sessionKey: input.sessionKey,
          model: input.modelRef,
        },
        error: `Failed to start Runtime bridge: ${error.message}`,
      });
    });

    child.once("close", (code) => {
      if (resultPayload) {
        settle(resultPayload);
        return;
      }
      settle({
        success: false,
        rows: [],
        metadata: {
          terminalCode: "EXECUTION_FAILED",
          sessionId: input.sessionId,
          sessionKey: input.sessionKey,
          model: input.modelRef,
          stderr: stderrBuffer.trim(),
        },
        error:
          stderrBuffer.trim() ||
          `Runtime bridge exited before returning a result${typeof code === "number" ? ` (code ${code})` : ""}.`,
      });
    });

    child.stdin.write(`${JSON.stringify(input)}\n`);
    child.stdin.end();
  });
}
