import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeEvent } from "../contracts/events.js";
import type { BrowserExecutionStep, AutomationRuntimeRunRequest } from "../contracts/run.js";
import { loadRuntimeConfig } from "./config.js";

export type AgentBrowserBatchResult = {
  success: boolean;
  rows: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  error?: string;
};

type EmitEvent = (type: RuntimeEvent["type"], payload: Record<string, unknown>) => void;

const BRIDGE_PREFIX = "__OI_RUNTIME__";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(MODULE_DIR, "..", "..");
const OPENCLAW_BRIDGE_PATH = path.join(PACKAGE_ROOT, "vendor", "openclaw-agent-bridge.ts");
const OPENCLAW_BRIDGE_TIMEOUT_MS = 300_000;
const AGENT_BROWSER_SKILL_PATH = path.resolve(
  PACKAGE_ROOT,
  "..",
  "..",
  "node_modules",
  "agent-browser",
  "skills",
  "agent-browser",
  "SKILL.md",
);
const AGENT_BROWSER_COMMANDS_PATH = path.resolve(
  PACKAGE_ROOT,
  "..",
  "..",
  "node_modules",
  "agent-browser",
  "skills",
  "agent-browser",
  "references",
  "commands.md",
);
const AGENT_BROWSER_REFS_PATH = path.resolve(
  PACKAGE_ROOT,
  "..",
  "..",
  "node_modules",
  "agent-browser",
  "skills",
  "agent-browser",
  "references",
  "snapshot-refs.md",
);

let browserGuidanceCache: string | null = null;

type BrowserObservationMemory = {
  capturedAt: string;
  url?: string;
  targetId?: string;
  format?: string;
  snapshotText?: string;
  refCount?: number;
};

type BrowserActionMemory = {
  capturedAt: string;
  operation?: string;
  mutating: boolean;
};

export type LoopState = {
  lastBrowserObservation?: BrowserObservationMemory;
  lastBrowserAction?: BrowserActionMemory;
  browserTimeoutRecoveryCount?: number;
};

export function createLoopStateForRun(): LoopState {
  return { browserTimeoutRecoveryCount: 0 };
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeModelRef(request: AutomationRuntimeRunRequest): string | undefined {
  const explicitProvider = String(request.model?.provider || "").trim();
  const explicitModel = String(request.model?.name || "").trim();
  if (!explicitProvider && !explicitModel) {
    return undefined;
  }
  const config = loadRuntimeConfig();
  const provider = explicitProvider || (config.googleGenAiUseVertexAi ? "google-vertex" : "google");
  const modelName = explicitModel;
  if (!modelName) {
    return undefined;
  }
  if (modelName.includes("/")) {
    return modelName;
  }
  return `${provider}/${modelName}`;
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
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return path.resolve(override, sanitizePathSegment(scopeId));
  }
  return path.join(os.tmpdir(), "oi-automation-runtime", "openclaw", sanitizePathSegment(scopeId));
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

function extractVisibleText(payloads: Array<Record<string, unknown>>): string {
  return payloads
    .map((payload) => String(payload.text || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

async function loadBrowserGuidance(): Promise<string> {
  if (browserGuidanceCache) {
    return browserGuidanceCache;
  }
  const [skill, commands, refs] = await Promise.all([
    fs.readFile(AGENT_BROWSER_SKILL_PATH, "utf8"),
    fs.readFile(AGENT_BROWSER_COMMANDS_PATH, "utf8"),
    fs.readFile(AGENT_BROWSER_REFS_PATH, "utf8"),
  ]);
  const compact = [
    "# agent-browser upstream guidance",
    skill.split("## Essential Commands")[0].trim(),
    "## Essential command excerpts",
    commands.split("## Get Information")[0].trim(),
    "## Snapshot and refs excerpts",
    refs.split("## Troubleshooting")[0].trim(),
  ].join("\n\n");
  browserGuidanceCache = compact;
  return compact;
}

function looksLikeCapabilityRefusal(result: AgentBrowserBatchResult): boolean {
  const text = String(result.error || result.metadata.text || "").toLowerCase();
  if (!text) {
    return false;
  }
  return (
    text.includes("cannot directly send emails") ||
    text.includes("can't directly send emails") ||
    text.includes("cannot directly send messages") ||
    text.includes("can't directly send messages") ||
    text.includes("my capabilities are limited") ||
    text.includes("there isn't a tool for sending emails")
  );
}

async function buildBrowserFirstPrompt(request: AutomationRuntimeRunRequest): Promise<string> {
  const guidance = await loadBrowserGuidance();
  return [
    guidance,
    "",
    "## Execution directive",
    "This is a browser UI automation task in an already attached browser session.",
    "Use the browser tool as the primary tool.",
    "Do not answer with generic capability limitations when the task can be completed through the browser UI.",
    "Follow the upstream agent-browser workflow strictly: open or focus page, snapshot, act by ref, re-snapshot after UI changes.",
    "If the current UI already exposes the target form, draft, modal, drawer, popup, or editor, continue from that foreground surface instead of restarting the flow.",
    "Prefer observing the active foreground surface before taking action in dynamic multi-step forms.",
    "When a visible dialog, composer, drawer, popup, sheet, or editor is already open, do not start with a broad body snapshot. Start with a scoped snapshot of that active surface first.",
    "Do not use broad selectors such as body, button, div[role='button'], or generic role-button containers as scoped snapshot selectors when a foreground surface is already visible.",
    "Only switch into a frame if the latest snapshot explicitly showed the relevant interactive controls inside that frame. Do not probe arbitrary iframe refs when the target is still discoverable from the main document.",
    "If multiple similar surfaces are visible, prefer the most recently focused or frontmost visible surface and continue inside it.",
    "When using the browser tool, valid top-level actions are browser tool actions such as open, snapshot, navigate, and act.",
    "For interactive UI steps, use action=\"act\" and provide a request object with a concrete act kind such as click, type, press, select, fill, or hover.",
    "For click, type, select, fill, and drag, always use refs from the latest snapshot. Do not use visible labels or free-text descriptions as stand-ins for refs.",
    "After any mutating UI action such as click, type, press, select, fill, close, or drag, take a fresh snapshot before attempting the next ref-based action.",
    "In dynamic forms, dialogs, drawers, popups, sheets, and editors, never emit multiple mutating browser actions in a single assistant turn. Perform one mutating action, wait for the tool result, then re-snapshot before the next mutating action.",
    "",
    "## User task",
    request.text.trim(),
  ].join("\n");
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

async function clearAgentBrowserDaemons(): Promise<void> {
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

function stripGatewayAuthEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Record<string, string> {
  const next = { ...env } as Record<string, string | undefined>;
  delete next.OPENCLAW_GATEWAY_TOKEN;
  delete next.CLAWDBOT_GATEWAY_TOKEN;
  delete next.OPENCLAW_GATEWAY_PASSWORD;
  delete next.CLAWDBOT_GATEWAY_PASSWORD;
  return Object.fromEntries(
    Object.entries(next).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function ensureBrowserConfig(stateDir: string, cdpUrl: string): Promise<string> {
  const configPath = path.join(stateDir, "openclaw.json");
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
  await fs.writeFile(
    configPath,
    `${JSON.stringify(nextConfig, null, 2)}\n`,
    "utf8",
  );
  return configPath;
}

async function seedOpenClawAuthProfile(params: {
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

function stringifyLogArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function mapPayloadsToRows(payloads: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return payloads.map((payload, index) => ({
    index,
    text: payload.text ?? null,
    mediaUrl: payload.mediaUrl ?? null,
    mediaUrls: Array.isArray(payload.mediaUrls) ? payload.mediaUrls : [],
  }));
}

function snippet(value: string | undefined, limit = 1500): string | undefined {
  const text = String(value || "").trim();
  if (!text) {
    return undefined;
  }
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function countRefs(value: unknown): number | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return Object.keys(record).length;
}

function findObservationCandidate(value: unknown, depth = 0): BrowserObservationMemory | null {
  if (depth > 4) {
    return null;
  }
  const record = asRecord(value);
  if (!record) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findObservationCandidate(item, depth + 1);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  const snapshotText = snippet(
    typeof record.snapshot === "string"
      ? record.snapshot
      : typeof record.text === "string"
        ? record.text
        : undefined,
  );
  const url =
    typeof record.url === "string"
      ? record.url
      : typeof record.origin === "string"
        ? record.origin
        : undefined;
  const targetId =
    typeof record.targetId === "string"
      ? record.targetId
      : typeof record.pageId === "string"
        ? record.pageId
        : undefined;
  const format = typeof record.format === "string" ? record.format : undefined;
  const refCount =
    typeof record.refs === "object" && record.refs
      ? countRefs(record.refs)
      : typeof record.labelsCount === "number"
        ? record.labelsCount
        : undefined;

  if (snapshotText || format || targetId || url || refCount) {
    return {
      capturedAt: nowIso(),
      url,
      targetId,
      format,
      snapshotText,
      refCount,
    };
  }

  for (const nested of Object.values(record)) {
    const found = findObservationCandidate(nested, depth + 1);
    if (found) {
      return found;
    }
  }
  return null;
}

function observationSpecificityScore(observation: BrowserObservationMemory | undefined): number {
  if (!observation) {
    return -1;
  }
  const refCount = typeof observation.refCount === "number" ? observation.refCount : 999;
  let score = 0;
  // Lower ref counts are generally more scoped/foreground-specific than broad page snapshots.
  score += Math.max(0, 200 - Math.min(refCount, 200));
  if (observation.targetId) {
    score += 10;
  }
  if (observation.format === "aria") {
    score += 5;
  }
  if (observation.snapshotText && observation.snapshotText.length > 0) {
    score += 5;
  }
  return score;
}

function shouldReplaceObservationMemory(
  current: BrowserObservationMemory | undefined,
  candidate: BrowserObservationMemory,
  lastAction: BrowserActionMemory | undefined,
): boolean {
  if (!current) {
    return true;
  }
  const currentScore = observationSpecificityScore(current);
  const candidateScore = observationSpecificityScore(candidate);
  if (candidateScore >= currentScore) {
    return true;
  }
  if (
    lastAction?.mutating &&
    typeof current.refCount === "number" &&
    typeof candidate.refCount === "number" &&
    current.refCount <= 25 &&
    candidate.refCount >= current.refCount * 3
  ) {
    return false;
  }
  return true;
}

function classifyBrowserOperationFromEventPayload(payload: Record<string, unknown>): string | undefined {
  const meta = typeof payload.meta === "string" ? payload.meta.trim().toLowerCase() : "";
  if (meta) {
    const kindMatch = /^kind\s+([a-z]+)/.exec(meta);
    if (kindMatch?.[1]) {
      return `act:${kindMatch[1]}`;
    }
    if (meta === "snapshot") {
      return "snapshot";
    }
  }
  const resultRecord = asRecord(payload.result);
  const partialRecord = asRecord(payload.partialResult);
  const candidate =
    (resultRecord && typeof resultRecord.kind === "string" ? resultRecord.kind : "") ||
    (partialRecord && typeof partialRecord.kind === "string" ? partialRecord.kind : "");
  return candidate ? String(candidate).trim().toLowerCase() : undefined;
}

function isMutatingBrowserOperation(operation: string | undefined): boolean {
  return new Set([
    "open",
    "upload",
    "dialog",
    "click",
    "type",
    "press",
    "hover",
    "drag",
    "select",
    "fill",
    "act:click",
    "act:type",
    "act:press",
    "act:hover",
    "act:drag",
    "act:select",
    "act:fill",
  ]).has(String(operation || "").trim().toLowerCase());
}

function rememberBrowserRuntimeEvent(
  loopState: LoopState,
  type: RuntimeEvent["type"],
  payload: Record<string, unknown>,
): void {
  if (type === "run.browser.snapshot" || type === "run.tool.finished") {
    const toolName = type === "run.tool.finished" ? String(payload.toolName || "") : "browser";
    if (toolName && toolName !== "browser") {
      return;
    }
    const observation =
      findObservationCandidate(payload.result) ||
      findObservationCandidate(payload.partialResult) ||
      findObservationCandidate(payload);
    if (observation) {
      if (
        shouldReplaceObservationMemory(
          loopState.lastBrowserObservation,
          observation,
          loopState.lastBrowserAction,
        )
      ) {
        loopState.lastBrowserObservation = observation;
      }
    }
    const operation = classifyBrowserOperationFromEventPayload(payload);
    if (operation === "snapshot") {
      return;
    }
    if (operation) {
      loopState.lastBrowserAction = {
        capturedAt: nowIso(),
        operation,
        mutating: isMutatingBrowserOperation(operation),
      };
    }
  }
  if (type === "run.browser.action") {
    const operation = classifyBrowserOperationFromEventPayload(payload);
    if (operation) {
      loopState.lastBrowserAction = {
        capturedAt: nowIso(),
        operation,
        mutating: isMutatingBrowserOperation(operation),
      };
    }
  }
}

function buildBrowserTimeoutRecoveryPrompt(
  request: AutomationRuntimeRunRequest,
  loopState: LoopState,
  attempt: number,
): string {
  const observation = loopState.lastBrowserObservation;
  const action = loopState.lastBrowserAction;
  const contextLines = [
    "The previous browser-tool attempt timed out during a dynamic UI flow.",
    "Recover generically from the current live browser state.",
    "Do not restart the workflow from the beginning.",
    "Start with a fresh snapshot of the current foreground surface, then continue from there.",
    "If a dialog, composer, drawer, popup, sheet, or active form is already open, observe that surface first and continue inside it.",
    "Treat any previous refs as stale unless re-seen in the fresh snapshot.",
    "Do not use broad selectors such as body, button, div[role='button'], or generic role-button containers for recovery while a foreground surface is already visible.",
    "If the last good observation came from a foreground surface, stay anchored to that same surface before broadening to the full page.",
    "Only switch into a frame if the last good observation explicitly showed the relevant interactive controls inside that frame. Do not recover by probing arbitrary iframe refs after a timeout; recover in the main document first.",
    "Do not retry the same mutating ref actions in one batch. Perform one mutating action, inspect the result, then re-snapshot before continuing.",
  ];
  if (attempt >= 2) {
    contextLines.push(
      "If a fresh foreground snapshot still cannot produce stable refs, take a labeled browser screenshot of the current viewport as a visual recovery aid.",
    );
    contextLines.push(
      "Use the labeled screenshot only to identify the single active foreground target or surface, then take another fresh snapshot of that same surface before acting.",
    );
    contextLines.push(
      "Prefer visual identification only for isolated click targets. For typing or filling fields, always re-establish a fresh snapshot and refs before entering text.",
    );
  }
  if (action?.operation) {
    contextLines.push(`Last browser action: ${action.operation}`);
  }
  if (observation?.url) {
    contextLines.push(`Last observed URL: ${observation.url}`);
  }
  if (observation?.targetId) {
    contextLines.push(`Last observed targetId: ${observation.targetId}`);
  }
  if (observation?.format) {
    contextLines.push(`Last observation format: ${observation.format}`);
  }
  if (typeof observation?.refCount === "number") {
    contextLines.push(`Last observation ref count: ${observation.refCount}`);
  }
  if (observation?.snapshotText) {
    contextLines.push("Last observation excerpt:");
    contextLines.push(observation.snapshotText);
  }
  return [
    request.text.trim(),
    "",
    "## Recovery context",
    ...contextLines,
  ].join("\n");
}

function extractResultText(result: AgentBrowserBatchResult): string {
  const text = [
    result.error || "",
    String(result.metadata.text || ""),
    ...result.rows.map((row) => String(row.text || "")),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return text;
}

function shouldRecoverBrowserChannel(result: AgentBrowserBatchResult): boolean {
  const text = extractResultText(result);
  if (!text) {
    return false;
  }
  return (
    text.includes("browser tool timed out") ||
    text.includes("browser tool is currently unavailable") ||
    text.includes("browser proxy timed out") ||
    text.includes("restart the openclaw gateway") ||
    text.includes("openclaw gateway restart")
  );
}

function shouldRecoverModelTimeout(result: AgentBrowserBatchResult): boolean {
  const text = extractResultText(result);
  if (!text) {
    return false;
  }
  return (
    text.includes("llm request timed out") ||
    text.includes("request timed out before a response was generated") ||
    text.includes("connection reset by peer") ||
    text.includes("timed out") && text.includes("request")
  );
}

export async function executePromptBrowserRun(params: {
  request: AutomationRuntimeRunRequest;
  loopState: LoopState;
  emit: EmitEvent;
  signal?: AbortSignal;
}): Promise<AgentBrowserBatchResult> {
  const { request, emit } = params;
  const modelRef = normalizeModelRef(request);
  const scopeId = request.browserSessionId || request.sessionId || request.runId;
  // Keep the browser state scope stable across turns, but give each runtime run its
  // own embedded OpenClaw session transcript so concurrent runs from the same chat
  // session never contend on the same jsonl lock file.
  const embeddedSessionBaseId = request.runId || request.sessionId;
  const createSession = async (retryLabel?: string) => {
    const retrySessionId = retryLabel
      ? `${embeddedSessionBaseId}-${retryLabel}-${Date.now().toString(36)}`
      : embeddedSessionBaseId;
    return await ensureUiSession({
      scopeId,
      sessionId: retrySessionId,
      model: modelRef,
    });
  };
  let { stateDir, sessionKey, sessionId } = await createSession();
  const configPath = await ensureBrowserConfig(stateDir, request.browser.cdpUrl);
  await seedOpenClawAuthProfile({ stateDir, configPath, modelRef, emit });
  const workspaceDir = request.cwd ? path.resolve(request.cwd) : PACKAGE_ROOT;
  const runtimeConfig = loadRuntimeConfig();
  const openClawEnv: Record<string, string> = {
    OPENCLAW_DISABLE_EXTENSION_PROFILE: "1",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SKIP_CHANNELS: "1",
    CLAWDBOT_SKIP_CHANNELS: "1",
    OI_RUNNER_CDP_URL: request.browser.cdpUrl,
  };
  if (runtimeConfig.googleApiKey) {
    openClawEnv.GOOGLE_API_KEY = runtimeConfig.googleApiKey;
  }
  if (runtimeConfig.googleGenAiUseVertexAi) {
    openClawEnv.GOOGLE_GENAI_USE_VERTEXAI = "true";
  }
  if (runtimeConfig.gcpProject) {
    openClawEnv.GOOGLE_CLOUD_PROJECT = runtimeConfig.gcpProject;
    openClawEnv.GCLOUD_PROJECT = runtimeConfig.gcpProject;
  }
  if (runtimeConfig.gcpLocation) {
    openClawEnv.GOOGLE_CLOUD_LOCATION = runtimeConfig.gcpLocation;
  }
  if (runtimeConfig.googleApplicationCredentials) {
    openClawEnv.GOOGLE_APPLICATION_CREDENTIALS = runtimeConfig.googleApplicationCredentials;
  }

  emit("run.log", {
    level: "info",
    source: "runtime",
    message: `Prepared OpenClaw session ${sessionKey}${modelRef ? ` using ${modelRef}` : " using OpenClaw defaults"}`,
    createdAt: nowIso(),
  });

  const emitAndRemember: EmitEvent = (type, payload) => {
    rememberBrowserRuntimeEvent(params.loopState, type, payload);
    emit(type, payload);
  };

  const initialResult = await executeOpenClawBridge({
    env: openClawEnv,
    input: {
      request,
      sessionId,
      sessionKey,
      modelRef,
      workspaceDir,
    },
    emit: emitAndRemember,
    signal: params.signal,
  });
  if (shouldRecoverBrowserChannel(initialResult)) {
    const recoveryCount = Number(params.loopState.browserTimeoutRecoveryCount || 0);
    if (recoveryCount >= 2) {
      emit("run.log", {
        level: "warn",
        source: "runtime",
        message:
          "Browser channel timeout recurred after recovery. Not retrying again in this run.",
        createdAt: nowIso(),
      });
      return initialResult;
    }
    params.loopState.browserTimeoutRecoveryCount = recoveryCount + 1;
    emit("run.log", {
      level: "warn",
      source: "runtime",
      message:
        recoveryCount === 0
          ? "Detected browser channel timeout/unavailability from OpenClaw. Restarting browser daemon and retrying from the last good observation."
          : "Browser channel timed out again after foreground-snapshot recovery. Restarting browser daemon and retrying once more with labeled-screenshot guidance.",
      createdAt: nowIso(),
    });
    await clearAgentBrowserDaemons();
    return await executeOpenClawBridge({
      env: openClawEnv,
      input: {
        request: {
          ...request,
          text: buildBrowserTimeoutRecoveryPrompt(
            request,
            params.loopState,
            params.loopState.browserTimeoutRecoveryCount || 1,
          ),
        },
        sessionId,
        sessionKey,
        modelRef,
        workspaceDir,
      },
      emit: emitAndRemember,
      signal: params.signal,
    });
  }
  if (shouldRecoverModelTimeout(initialResult)) {
    emit("run.log", {
      level: "warn",
      source: "runtime",
      message:
        "Detected model/network timeout from OpenClaw. Retrying once with a fresh embedded session.",
      createdAt: nowIso(),
    });
    ({ stateDir, sessionKey, sessionId } = await createSession("retry"));
    const retryConfigPath = await ensureBrowserConfig(stateDir, request.browser.cdpUrl);
    await seedOpenClawAuthProfile({ stateDir, configPath: retryConfigPath, modelRef, emit });
    return await executeOpenClawBridge({
      env: openClawEnv,
      input: {
        request,
        sessionId,
        sessionKey,
        modelRef,
        workspaceDir,
      },
      emit: emitAndRemember,
      signal: params.signal,
    });
  }
  if (looksLikeCapabilityRefusal(initialResult)) {
    params.emit("run.log", {
      level: "info",
      source: "runtime",
      message:
        "OpenClaw returned a generic capability refusal; retrying once with upstream agent-browser guidance injected into the prompt.",
      createdAt: nowIso(),
    });
    const browserFirstPrompt = await buildBrowserFirstPrompt(request);
    return await executeOpenClawBridge({
      env: openClawEnv,
      input: {
        request: { ...request, text: browserFirstPrompt },
        sessionId,
        sessionKey,
        modelRef,
        workspaceDir,
      },
      emit: emitAndRemember,
      signal: params.signal,
    });
  }
  return initialResult;
}

export async function executeAgentBrowserSteps(params: {
  cdpUrl: string;
  runId: string;
  steps: BrowserExecutionStep[];
  loopState: LoopState;
  emit: EmitEvent;
}): Promise<AgentBrowserBatchResult> {
  const stepPrompt = [
    "Execute the task using the browser based on the following intended steps.",
    "Treat them as hints, not as an authoritative plan.",
    "",
    ...params.steps.map((step, index) => {
      const command = String(step.command || step.action || "unknown").trim();
      const description = String(step.description || "").trim();
      return `${index + 1}. ${command}${description ? ` - ${description}` : ""}`;
    }),
  ].join("\n");
  return await executePromptBrowserRun({
    request: {
      runId: params.runId,
      sessionId: params.runId,
      text: stepPrompt,
      browser: { mode: "cdp", cdpUrl: params.cdpUrl },
      context: { userId: "system" },
    },
    loopState: params.loopState,
    emit: params.emit,
  });
}

type BridgeInput = {
  request: AutomationRuntimeRunRequest;
  sessionId: string;
  sessionKey: string;
  modelRef?: string;
  workspaceDir: string;
};

async function executeOpenClawBridge(params: {
  env: Record<string, string>;
  input: BridgeInput;
  emit: EmitEvent;
  signal?: AbortSignal;
}): Promise<AgentBrowserBatchResult> {
  const bridgeEnv = {
    ...stripGatewayAuthEnv(process.env),
    ...params.env,
  };
  return await new Promise<AgentBrowserBatchResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", OPENCLAW_BRIDGE_PATH],
      {
        cwd: PACKAGE_ROOT,
        env: bridgeEnv,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    let resultPayload: AgentBrowserBatchResult | null = null;
    const abortHandler = () => {
      if (settled) {
        return;
      }
      clearTimeout(timeout);
      child.kill("SIGTERM");
      reject(new Error("OpenClaw browser run aborted."));
    };
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      params.emit("run.log", {
        level: "error",
        source: "runtime",
        message: `OpenClaw bridge exceeded ${OPENCLAW_BRIDGE_TIMEOUT_MS}ms and was terminated.`,
        createdAt: nowIso(),
      });
      child.kill("SIGTERM");
      settle({
        success: false,
        rows: [],
        metadata: {
          terminalCode: "EXECUTION_FAILED",
          sessionId: params.input.sessionId,
          sessionKey: params.input.sessionKey,
          model: params.input.modelRef,
        },
        error: `OpenClaw bridge timed out after ${OPENCLAW_BRIDGE_TIMEOUT_MS}ms.`,
      });
    }, OPENCLAW_BRIDGE_TIMEOUT_MS);

    const settle = (payload: AgentBrowserBatchResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", abortHandler);
      resolve(payload);
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
          source: "openclaw-stdout",
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
          message: `Failed to parse OpenClaw bridge payload: ${raw}`,
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
        resultPayload = {
          success: Boolean(message.success),
          rows: mapPayloadsToRows(payloads),
          metadata: {
            payloads,
            meta,
            sessionId: params.input.sessionId,
            sessionKey: params.input.sessionKey,
            model: params.input.modelRef,
            text: extractVisibleText(payloads),
          },
          error: typeof message.error === "string" ? message.error : undefined,
        };
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
          level: "error",
          source: "openclaw-stderr",
          message: trimmed,
          createdAt: nowIso(),
        });
      }
    });

    child.on("error", (error) => {
      params.signal?.removeEventListener("abort", abortHandler);
      settle({
        success: false,
        rows: [],
        metadata: {
          terminalCode: "EXECUTION_FAILED",
          sessionId: params.input.sessionId,
          sessionKey: params.input.sessionKey,
          model: params.input.modelRef,
        },
        error: error.message,
      });
    });

    child.on("close", (code) => {
      params.signal?.removeEventListener("abort", abortHandler);
      if (resultPayload) {
        settle(resultPayload);
        return;
      }
      const stderrMessage = stderrBuffer.trim();
      settle({
        success: false,
        rows: [],
        metadata: {
          terminalCode: "EXECUTION_FAILED",
          sessionId: params.input.sessionId,
          sessionKey: params.input.sessionKey,
          model: params.input.modelRef,
        },
        error:
          stderrMessage ||
          `OpenClaw bridge exited without result${code == null ? "" : ` (code ${code})`}.`,
      });
    });

    child.stdin.end(`${JSON.stringify(params.input)}\n`);
  });
}
