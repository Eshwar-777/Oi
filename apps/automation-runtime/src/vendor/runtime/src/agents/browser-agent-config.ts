import type { RuntimeConfig } from "../config/types.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";

function normalizeAgentId(value: string | null | undefined): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized || "main";
}

type AgentEntry = NonNullable<NonNullable<RuntimeConfig["agents"]>["list"]>[number];

function listAgentEntries(cfg: RuntimeConfig): AgentEntry[] {
  const list = cfg.agents?.list;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry): entry is AgentEntry => Boolean(entry && typeof entry === "object"));
}

function resolveAgentEntry(cfg: RuntimeConfig, agentId: string): AgentEntry | undefined {
  const normalized = normalizeAgentId(agentId);
  return listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === normalized);
}

export function resolveBrowserAgentConfig(cfg: RuntimeConfig, agentId: string) {
  const entry = resolveAgentEntry(cfg, agentId);
  if (!entry) {
    return undefined;
  }
  return {
    model:
      typeof entry.model === "string" || (entry.model && typeof entry.model === "object")
        ? entry.model
        : undefined,
    subagents:
      typeof entry.subagents === "object" && entry.subagents ? entry.subagents : undefined,
  };
}

export function resolveBrowserAgentEffectiveModelPrimary(
  cfg: RuntimeConfig,
  agentId: string,
): string | undefined {
  return (
    resolveAgentModelPrimaryValue(resolveBrowserAgentConfig(cfg, agentId)?.model) ??
    resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)
  );
}
