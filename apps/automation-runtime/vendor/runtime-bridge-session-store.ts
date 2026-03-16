import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_AGENT_ID = "main";
const DEFAULT_CONTEXT_TOKENS = 200000;
const VALID_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const VALID_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

type RuntimeConfigLike = {
  session?: {
    store?: unknown;
  };
  agents?: {
    defaults?: {
      cliBackends?: Record<string, Record<string, unknown>>;
      models?: Record<string, { params?: Record<string, unknown> }>;
    };
  };
};

type SessionEntry = {
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
  contextTokens?: number;
  modelProvider?: string;
  model?: string;
  cliSessionIds?: Record<string, string>;
  abortedLastRun?: boolean;
  systemPromptReport?: unknown;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  cacheRead?: number;
  cacheWrite?: number;
  compactionCount?: number;
};

type BrowserRunResult = {
  meta?: {
    aborted?: boolean;
    systemPromptReport?: unknown;
    agentMeta?: {
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
      promptTokens?: number;
      compactionCount?: number;
      model?: string;
      provider?: string;
      sessionId?: string;
    };
  };
};

function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return DEFAULT_AGENT_ID;
  if (VALID_AGENT_ID_RE.test(trimmed)) return trimmed.toLowerCase();
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return normalized || DEFAULT_AGENT_ID;
}

function resolveRequiredHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string {
  const explicit = env.RUNTIME_HOME?.trim() || env.HOME?.trim();
  return explicit ? explicit : homedir();
}

function expandHomePrefix(input: string, env: NodeJS.ProcessEnv, homedir: () => string): string {
  if (!input.startsWith("~")) return input;
  const home = resolveRequiredHomeDir(env, homedir);
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

function resolveUserPath(input: string, env: NodeJS.ProcessEnv, homedir: () => string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  return path.resolve(expandHomePrefix(trimmed, env, homedir));
}

function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const homedir = () => os.homedir();
  const override = env.RUNTIME_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (override) return resolveUserPath(override, env, homedir);
  const home = resolveRequiredHomeDir(env, homedir);
  const newDir = path.join(home, ".runtime");
  if (env.RUNTIME_TEST_FAST === "1" || fs.existsSync(newDir)) return newDir;
  for (const legacy of [".clawdbot", ".moldbot", ".moltbot"]) {
    const candidate = path.join(home, legacy);
    if (fs.existsSync(candidate)) return candidate;
  }
  return newDir;
}

function normalizeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "z.ai" || normalized === "z-ai") return "zai";
  if (normalized === "opencode-zen") return "opencode";
  if (normalized === "qwen") return "qwen-portal";
  if (normalized === "kimi-code") return "kimi-coding";
  if (normalized === "bedrock" || normalized === "aws-bedrock") return "amazon-bedrock";
  if (normalized === "google_vertex" || normalized === "vertexai") return "google-vertex";
  if (normalized === "bytedance" || normalized === "doubao") return "volcengine";
  return normalized;
}

function isCliProvider(provider: string, cfg?: RuntimeConfigLike): boolean {
  const normalized = normalizeProviderId(provider);
  if (normalized === "codex-cli") return true;
  const backends = cfg?.agents?.defaults?.cliBackends ?? {};
  return Object.keys(backends).some((key) => normalizeProviderId(key) === normalized);
}

function resolveConfiguredModelParams(params: {
  cfg?: RuntimeConfigLike;
  provider?: string;
  model?: string;
}): Record<string, unknown> | undefined {
  const provider = params.provider?.trim().toLowerCase();
  const model = params.model?.trim();
  if (!provider || !model) return undefined;
  const models = params.cfg?.agents?.defaults?.models;
  if (!models) return undefined;
  const key = `${provider}/${model}`;
  for (const [rawKey, entry] of Object.entries(models)) {
    if (rawKey.trim().toLowerCase() !== key) continue;
    const paramsValue = entry?.params;
    return paramsValue && typeof paramsValue === "object"
      ? (paramsValue as Record<string, unknown>)
      : undefined;
  }
  return undefined;
}

function resolveContextTokens(params: {
  cfg?: RuntimeConfigLike;
  provider?: string;
  model?: string;
  fallbackContextTokens?: number;
}): number {
  const modelParams = resolveConfiguredModelParams(params);
  const contextTokens = modelParams?.contextTokens;
  if (typeof contextTokens === "number" && contextTokens > 0) return contextTokens;
  return params.fallbackContextTokens ?? DEFAULT_CONTEXT_TOKENS;
}

function deriveSessionTotalTokens(params: {
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  contextTokens?: number;
  promptTokens?: number;
}): number | undefined {
  const usage = params.usage;
  if (!usage) return undefined;
  const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, params.promptTokens]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  if (values.length === 0) return undefined;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (typeof params.contextTokens === "number" && Number.isFinite(params.contextTokens) && params.contextTokens > 0) {
    return Math.min(total, params.contextTokens);
  }
  return total;
}

function resolveAgentSessionsDir(agentId?: string): string {
  return path.join(resolveStateDir(), "agents", normalizeAgentId(agentId), "sessions");
}

function resolveDefaultSessionStorePath(agentId?: string): string {
  return path.join(resolveAgentSessionsDir(agentId), "sessions.json");
}

function resolveStorePath(store: unknown, opts?: { agentId?: string }): string {
  const value = typeof store === "string" ? store : "";
  const agentId = normalizeAgentId(opts?.agentId ?? DEFAULT_AGENT_ID);
  if (!value) return resolveDefaultSessionStorePath(agentId);
  const expandedAgent = value.includes("{agentId}") ? value.replaceAll("{agentId}", agentId) : value;
  return resolveUserPath(expandedAgent, process.env, () => os.homedir());
}

function validateSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!VALID_SESSION_ID_RE.test(trimmed)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  return trimmed;
}

function resolveSessionTranscriptPath(sessionId: string, agentId?: string, threadId?: string | number): string {
  const safeSessionId = validateSessionId(sessionId);
  const safeThreadId =
    typeof threadId === "string"
      ? encodeURIComponent(threadId)
      : typeof threadId === "number"
        ? String(threadId)
        : undefined;
  const fileName = safeThreadId ? `${safeSessionId}-topic-${safeThreadId}.jsonl` : `${safeSessionId}.jsonl`;
  return path.join(resolveAgentSessionsDir(agentId), fileName);
}

function resolveSessionFilePath(params: {
  sessionId: string;
  sessionEntry?: SessionEntry;
  agentId?: string;
}): string {
  const defaultPath = resolveSessionTranscriptPath(params.sessionId, params.agentId);
  const persisted = params.sessionEntry?.sessionFile?.trim();
  if (!persisted) return defaultPath;
  if (path.isAbsolute(persisted)) return persisted;
  return path.join(resolveAgentSessionsDir(params.agentId), persisted);
}

function loadSessionStore(storePath: string): Record<string, SessionEntry> {
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, SessionEntry>)
      : {};
  } catch {
    return {};
  }
}

async function writeSessionStore(storePath: string, store: Record<string, SessionEntry>): Promise<void> {
  await fsp.mkdir(path.dirname(storePath), { recursive: true });
  await fsp.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

export function resolveBrowserSession(params: {
  cfg: RuntimeConfigLike;
  sessionId: string;
  sessionKey: string;
  agentId: string;
}): {
  sessionId: string;
  sessionKey: string;
  sessionEntry?: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
} {
  const sessionId = params.sessionId.trim();
  const sessionKey = params.sessionKey.trim();
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.agentId });
  const sessionStore = loadSessionStore(storePath);
  const sessionEntry = sessionStore[sessionKey];
  return {
    sessionId: sessionId || sessionEntry?.sessionId || "",
    sessionKey,
    sessionEntry,
    sessionStore,
    storePath,
  };
}

export async function resolveBrowserSessionTranscriptFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  agentId: string;
  threadId?: string | number;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry | undefined }> {
  let sessionEntry = params.sessionEntry;
  let sessionFile = resolveSessionFilePath({
    sessionId: params.sessionId,
    sessionEntry,
    agentId: params.agentId,
  });

  if (params.sessionStore && params.storePath) {
    const baseEntry =
      sessionEntry ??
      params.sessionStore[params.sessionKey] ?? {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      };
    if (!baseEntry.sessionFile) {
      sessionFile = resolveSessionTranscriptPath(params.sessionId, params.agentId, params.threadId);
      sessionEntry = {
        ...baseEntry,
        sessionId: params.sessionId,
        updatedAt: Date.now(),
        sessionFile,
      };
      params.sessionStore[params.sessionKey] = sessionEntry;
      await writeSessionStore(params.storePath, params.sessionStore);
    } else {
      params.sessionStore[params.sessionKey] = baseEntry;
      sessionEntry = baseEntry;
      sessionFile = resolveSessionFilePath({
        sessionId: params.sessionId,
        sessionEntry,
        agentId: params.agentId,
      });
    }
  }

  return { sessionFile, sessionEntry };
}

export async function updateBrowserSessionStoreAfterRun(params: {
  cfg: RuntimeConfigLike;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  sessionStore: Record<string, SessionEntry>;
  defaultProvider: string;
  defaultModel: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  result: BrowserRunResult;
}): Promise<void> {
  const usage = params.result.meta?.agentMeta?.usage;
  const promptTokens = params.result.meta?.agentMeta?.promptTokens;
  const compactionsThisRun = Math.max(0, params.result.meta?.agentMeta?.compactionCount ?? 0);
  const modelUsed =
    params.result.meta?.agentMeta?.model?.trim() || params.fallbackModel || params.defaultModel;
  const providerUsed =
    params.result.meta?.agentMeta?.provider?.trim() || params.fallbackProvider || params.defaultProvider;
  const contextTokens = resolveContextTokens({
    cfg: params.cfg,
    provider: providerUsed,
    model: modelUsed,
    fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
  });

  const existing = params.sessionStore[params.sessionKey] ?? {
    sessionId: params.sessionId,
    updatedAt: Date.now(),
  };
  const next: SessionEntry = {
    ...existing,
    sessionId: params.sessionId,
    updatedAt: Date.now(),
    contextTokens,
    modelProvider: providerUsed,
    model: modelUsed,
    abortedLastRun: params.result.meta?.aborted ?? false,
  };

  const runtimeSessionId = params.result.meta?.agentMeta?.sessionId?.trim();
  if (runtimeSessionId && isCliProvider(providerUsed, params.cfg)) {
    next.cliSessionIds = {
      ...(existing.cliSessionIds ?? {}),
      [normalizeProviderId(providerUsed)]: runtimeSessionId,
    };
  }
  if (params.result.meta?.systemPromptReport !== undefined) {
    next.systemPromptReport = params.result.meta.systemPromptReport;
  }

  if (usage) {
    next.inputTokens = usage.input ?? 0;
    next.outputTokens = usage.output ?? 0;
    next.cacheRead = usage.cacheRead ?? 0;
    next.cacheWrite = usage.cacheWrite ?? 0;
    const totalTokens = deriveSessionTotalTokens({
      usage,
      contextTokens,
      promptTokens,
    });
    if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
      next.totalTokens = totalTokens;
      next.totalTokensFresh = true;
    } else {
      delete next.totalTokens;
      next.totalTokensFresh = false;
    }
  }
  if (compactionsThisRun > 0) {
    next.compactionCount = (existing.compactionCount ?? 0) + compactionsThisRun;
  }

  params.sessionStore[params.sessionKey] = next;
  await writeSessionStore(params.storePath, params.sessionStore);
}
