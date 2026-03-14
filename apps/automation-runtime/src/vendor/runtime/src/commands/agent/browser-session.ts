import { setCliSessionId } from "../../agents/cli-session.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { deriveSessionTotalTokens, hasNonzeroUsage } from "../../agents/usage.js";
import type { RuntimeConfig } from "../../config/types.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  mergeSessionEntry,
  setSessionRuntimeModel,
  type SessionEntry,
} from "../../config/sessions/types.js";
import {
  loadBrowserSessionStore,
  updateBrowserSessionStore,
} from "./browser-session-store.js";

type BrowserRunResult = Awaited<
  ReturnType<
    (typeof import("../../agents/pi-embedded-runner/browser-run.js"))["runEmbeddedBrowserPiAgent"]
  >
>;

function resolveConfiguredModelParams(params: {
  cfg?: RuntimeConfig;
  provider?: string;
  model?: string;
}): Record<string, unknown> | undefined {
  const provider = params.provider?.trim().toLowerCase();
  const model = params.model?.trim();
  if (!provider || !model) {
    return undefined;
  }
  const models = params.cfg?.agents?.defaults?.models;
  if (!models) {
    return undefined;
  }
  const key = `${provider}/${model}`;
  for (const [rawKey, entry] of Object.entries(models)) {
    if (rawKey.trim().toLowerCase() !== key) {
      continue;
    }
    const paramsValue = (entry as { params?: unknown } | undefined)?.params;
    return paramsValue && typeof paramsValue === "object"
      ? (paramsValue as Record<string, unknown>)
      : undefined;
  }
  return undefined;
}

function resolveBrowserContextTokensForModel(params: {
  cfg?: RuntimeConfig;
  provider?: string;
  model?: string;
  contextTokensOverride?: number;
  fallbackContextTokens?: number;
}): number | undefined {
  if (typeof params.contextTokensOverride === "number" && params.contextTokensOverride > 0) {
    return params.contextTokensOverride;
  }
  const provider = params.provider?.trim().toLowerCase();
  const model = params.model?.trim();
  if (provider && model) {
    const modelParams = resolveConfiguredModelParams({
      cfg: params.cfg,
      provider,
      model,
    });
    if (typeof modelParams?.contextTokens === "number" && modelParams.contextTokens > 0) {
      return modelParams.contextTokens;
    }
  }
  return params.fallbackContextTokens;
}

export function resolveBrowserSession(params: {
  cfg: RuntimeConfig;
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
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const sessionStore = loadBrowserSessionStore(storePath);
  const sessionEntry = sessionStore[sessionKey];
  return {
    sessionId: sessionId || sessionEntry?.sessionId || "",
    sessionKey,
    sessionEntry,
    sessionStore,
    storePath,
  };
}

export async function updateBrowserSessionStoreAfterRun(params: {
  cfg: RuntimeConfig;
  contextTokensOverride?: number;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  sessionStore: Record<string, SessionEntry>;
  defaultProvider: string;
  defaultModel: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  result: BrowserRunResult;
}) {
  const {
    cfg,
    sessionId,
    sessionKey,
    storePath,
    sessionStore,
    defaultProvider,
    defaultModel,
    fallbackProvider,
    fallbackModel,
    result,
  } = params;

  const usage = result.meta.agentMeta?.usage;
  const promptTokens = result.meta.agentMeta?.promptTokens;
  const compactionsThisRun = Math.max(0, result.meta.agentMeta?.compactionCount ?? 0);
  const modelUsed = result.meta.agentMeta?.model ?? fallbackModel ?? defaultModel;
  const providerUsed = result.meta.agentMeta?.provider ?? fallbackProvider ?? defaultProvider;
  const contextTokens =
    resolveBrowserContextTokensForModel({
      cfg,
      provider: providerUsed,
      model: modelUsed,
      contextTokensOverride: params.contextTokensOverride,
      fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
    }) ?? DEFAULT_CONTEXT_TOKENS;

  const entry = sessionStore[sessionKey] ?? {
    sessionId,
    updatedAt: Date.now(),
  };
  const next: SessionEntry = {
    ...entry,
    sessionId,
    updatedAt: Date.now(),
    contextTokens,
  };
  setSessionRuntimeModel(next, {
    provider: providerUsed,
    model: modelUsed,
  });
  if (isCliProvider(providerUsed, cfg)) {
    const cliSessionId = result.meta.agentMeta?.sessionId?.trim();
    if (cliSessionId) {
      setCliSessionId(next, providerUsed, cliSessionId);
    }
  }
  next.abortedLastRun = result.meta.aborted ?? false;
  if (result.meta.systemPromptReport) {
    next.systemPromptReport = result.meta.systemPromptReport;
  }
  if (hasNonzeroUsage(usage)) {
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const totalTokens = deriveSessionTotalTokens({
      usage,
      contextTokens,
      promptTokens,
    });
    next.inputTokens = input;
    next.outputTokens = output;
    if (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0) {
      next.totalTokens = totalTokens;
      next.totalTokensFresh = true;
    } else {
      next.totalTokens = undefined;
      next.totalTokensFresh = false;
    }
    next.cacheRead = usage.cacheRead ?? 0;
    next.cacheWrite = usage.cacheWrite ?? 0;
  }
  if (compactionsThisRun > 0) {
    next.compactionCount = (entry.compactionCount ?? 0) + compactionsThisRun;
  }
  const persisted = await updateBrowserSessionStore(storePath, (store) => {
    const merged = mergeSessionEntry(store[sessionKey], next);
    store[sessionKey] = merged;
    return merged;
  });
  sessionStore[sessionKey] = persisted;
}
