import path from "node:path";
import type { RuntimeConfig } from "../config/types.js";
import { resolveStateDir } from "../config/paths.js";

const DEFAULT_AGENT_ID = "main";

function normalizeAgentId(value: string | null | undefined): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized || DEFAULT_AGENT_ID;
}

function stripNullBytes(value: string): string {
  return value.replace(/\0/g, "");
}

function resolveBrowserUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home) {
      return path.resolve(path.join(home, trimmed.slice(1)));
    }
  }
  return path.resolve(trimmed);
}

function listAgentEntries(cfg: RuntimeConfig) {
  const list = cfg.agents?.list;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry) => Boolean(entry && typeof entry === "object"));
}

function resolveAgentEntry(cfg: RuntimeConfig, agentId: string) {
  const normalized = normalizeAgentId(agentId);
  return listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === normalized);
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

export function resolveBrowserAgentWorkspaceDir(cfg: RuntimeConfig, agentId: string): string {
  const normalizedAgentId = normalizeAgentId(agentId);
  const configured = resolveAgentEntry(cfg, normalizedAgentId)?.workspace?.trim();
  if (configured) {
    return stripNullBytes(resolveBrowserUserPath(configured));
  }
  const defaultAgentId = resolveBrowserDefaultAgentId(cfg);
  if (normalizedAgentId === defaultAgentId) {
    const fallback = cfg.agents?.defaults?.workspace?.trim();
    if (fallback) {
      return stripNullBytes(resolveBrowserUserPath(fallback));
    }
    return stripNullBytes(path.join(resolveStateDir(process.env), "workspace"));
  }
  return stripNullBytes(path.join(resolveStateDir(process.env), `workspace-${normalizedAgentId}`));
}

export function resolveBrowserDefaultAgentWorkspaceDir(
  cfg?: RuntimeConfig,
  agentId?: string,
): string {
  if (cfg) {
    return resolveBrowserAgentWorkspaceDir(cfg, agentId ?? resolveBrowserDefaultAgentId(cfg));
  }
  return stripNullBytes(path.join(resolveStateDir(process.env), "workspace"));
}
