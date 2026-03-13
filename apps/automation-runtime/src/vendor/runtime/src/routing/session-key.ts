export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_MAIN_KEY = "main";
export const DEFAULT_ACCOUNT_ID = "default";

const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function normalizeAgentId(value: string | undefined | null): string {
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

export function normalizeAccountId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  return trimmed || DEFAULT_ACCOUNT_ID;
}

export function normalizeMainKey(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  return trimmed || DEFAULT_MAIN_KEY;
}

export function parseAgentSessionKey(
  sessionKey: string | undefined | null,
): { agentId: string; rest: string } | null {
  const raw = (sessionKey ?? "").trim().toLowerCase();
  const match = /^agent:([^:]+):(.+)$/.exec(raw);
  if (!match) {
    return null;
  }
  return { agentId: normalizeAgentId(match[1]), rest: match[2] };
}

export function classifySessionKeyShape(
  sessionKey: string | undefined | null,
): "missing" | "agent" | "legacy_or_alias" | "malformed_agent" {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return "missing";
  }
  if (parseAgentSessionKey(raw)) {
    return "agent";
  }
  return raw.toLowerCase().startsWith("agent:") ? "malformed_agent" : "legacy_or_alias";
}

export function resolveAgentIdFromSessionKey(sessionKey: string | undefined | null): string {
  return normalizeAgentId(parseAgentSessionKey(sessionKey)?.agentId ?? DEFAULT_AGENT_ID);
}

export function buildAgentMainSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
}): string {
  return `agent:${normalizeAgentId(params.agentId)}:${normalizeMainKey(params.mainKey)}`;
}

export function scopedHeartbeatWakeOptions<T extends object>(
  sessionKey: string,
  wakeOptions: T,
): T | (T & { sessionKey: string }) {
  return parseAgentSessionKey(sessionKey) ? { ...wakeOptions, sessionKey } : wakeOptions;
}

export function isCronSessionKey(sessionKey: string | undefined | null): boolean {
  return (sessionKey ?? "").trim().toLowerCase().startsWith("cron:");
}

export function isSubagentSessionKey(sessionKey: string | undefined | null): boolean {
  return (sessionKey ?? "").trim().toLowerCase().includes(":subagent:");
}

export function isAcpSessionKey(sessionKey: string | undefined | null): boolean {
  return (sessionKey ?? "").trim().toLowerCase().startsWith("acp:");
}
