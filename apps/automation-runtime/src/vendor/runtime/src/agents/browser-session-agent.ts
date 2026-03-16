import type { RuntimeConfig } from "../config/types.js";

const DEFAULT_AGENT_ID = "main";
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_AGENT_ID;
  }
  if (VALID_ID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return normalized || DEFAULT_AGENT_ID;
}

function parseAgentSessionKey(
  sessionKey: string | undefined | null,
): { agentId: string; rest: string } | null {
  const raw = (sessionKey ?? "").trim().toLowerCase();
  const match = /^agent:([^:]+):(.+)$/.exec(raw);
  if (!match) {
    return null;
  }
  return { agentId: normalizeAgentId(match[1]), rest: match[2] };
}

function listAgentEntries(cfg: RuntimeConfig) {
  const list = cfg.agents?.list;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry) => Boolean(entry && typeof entry === "object"));
}

export function resolveBrowserDefaultAgentId(cfg: RuntimeConfig): string {
  const agents = listAgentEntries(cfg);
  if (agents.length === 0) {
    return DEFAULT_AGENT_ID;
  }
  const defaults = agents.filter((agent) => agent?.default);
  const chosen = (defaults[0] ?? agents[0])?.id?.trim();
  return normalizeAgentId(chosen || DEFAULT_AGENT_ID);
}

export function resolveBrowserSessionAgentIds(params: {
  sessionKey?: string;
  config?: RuntimeConfig;
  agentId?: string;
}): {
  defaultAgentId: string;
  sessionAgentId: string;
} {
  const defaultAgentId = resolveBrowserDefaultAgentId(params.config ?? {});
  const explicitAgentIdRaw =
    typeof params.agentId === "string" ? params.agentId.trim().toLowerCase() : "";
  const explicitAgentId = explicitAgentIdRaw ? normalizeAgentId(explicitAgentIdRaw) : null;
  const sessionKey = params.sessionKey?.trim();
  const normalizedSessionKey = sessionKey ? sessionKey.toLowerCase() : undefined;
  const parsed = normalizedSessionKey ? parseAgentSessionKey(normalizedSessionKey) : null;
  const sessionAgentId =
    explicitAgentId ?? (parsed?.agentId ? normalizeAgentId(parsed.agentId) : defaultAgentId);
  return { defaultAgentId, sessionAgentId };
}

export function resolveBrowserSessionAgentId(params: {
  sessionKey?: string;
  config?: RuntimeConfig;
  agentId?: string;
}): string {
  return resolveBrowserSessionAgentIds(params).sessionAgentId;
}
