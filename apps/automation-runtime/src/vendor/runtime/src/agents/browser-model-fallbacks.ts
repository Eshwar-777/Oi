import type { RuntimeConfig } from "../config/types.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";

function normalizeAgentId(value: string | null | undefined): string | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized || null;
}

function resolveFallbackAgentId(params: {
  agentId?: string | null;
  sessionKey?: string | null;
}): string | null {
  const explicitAgentId = normalizeAgentId(params.agentId);
  if (explicitAgentId) {
    return explicitAgentId;
  }
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
  if (!sessionKey) {
    return null;
  }
  const match = /^agent:([^:]+)/.exec(sessionKey.toLowerCase());
  return normalizeAgentId(match?.[1]);
}

function resolveAgentModelFallbacksOverride(
  cfg: RuntimeConfig,
  agentId: string,
): string[] | undefined {
  const list = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const agent = list.find((entry) => normalizeAgentId(entry?.id) === agentId);
  const model = agent?.model;
  if (!model || typeof model === "string") {
    return undefined;
  }
  if (!Object.hasOwn(model, "fallbacks")) {
    return undefined;
  }
  return Array.isArray(model.fallbacks) ? model.fallbacks : undefined;
}

export function hasConfiguredBrowserModelFallbacks(params: {
  cfg: RuntimeConfig | undefined;
  agentId?: string | null;
  sessionKey?: string | null;
}): boolean {
  if (!params.cfg) {
    return false;
  }
  const fallbackAgentId = resolveFallbackAgentId(params);
  const override = fallbackAgentId
    ? resolveAgentModelFallbacksOverride(params.cfg, fallbackAgentId)
    : undefined;
  const defaults = resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
  return (override ?? defaults).length > 0;
}
