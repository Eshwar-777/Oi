import type { RuntimeConfig } from "../config/types.js";
import { resolveBrowserAgentConfig } from "./browser-agent-config.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "./glob-pattern.js";
import { expandToolGroups } from "./tool-policy.js";
import { DEFAULT_TOOL_ALLOW, DEFAULT_TOOL_DENY } from "./sandbox/constants.js";

function normalizeGlob(value: string) {
  return value.trim().toLowerCase();
}

export function resolveBrowserSandboxToolPolicyForAgent(
  cfg?: RuntimeConfig,
  agentId?: string,
) {
  const agentConfig = cfg && agentId ? resolveBrowserAgentConfig(cfg, agentId) : undefined;
  const agentAllow = agentConfig?.tools?.sandbox?.tools?.allow;
  const agentDeny = agentConfig?.tools?.sandbox?.tools?.deny;
  const globalAllow = cfg?.tools?.sandbox?.tools?.allow;
  const globalDeny = cfg?.tools?.sandbox?.tools?.deny;

  const allowSource = Array.isArray(agentAllow)
    ? { source: "agent" as const, key: "agents.list[].tools.sandbox.tools.allow" }
    : Array.isArray(globalAllow)
      ? { source: "global" as const, key: "tools.sandbox.tools.allow" }
      : { source: "default" as const, key: "tools.sandbox.tools.allow" };
  const denySource = Array.isArray(agentDeny)
    ? { source: "agent" as const, key: "agents.list[].tools.sandbox.tools.deny" }
    : Array.isArray(globalDeny)
      ? { source: "global" as const, key: "tools.sandbox.tools.deny" }
      : { source: "default" as const, key: "tools.sandbox.tools.deny" };

  const deny = Array.isArray(agentDeny)
    ? agentDeny
    : Array.isArray(globalDeny)
      ? globalDeny
      : [...DEFAULT_TOOL_DENY];
  const allow = Array.isArray(agentAllow)
    ? agentAllow
    : Array.isArray(globalAllow)
      ? globalAllow
      : [...DEFAULT_TOOL_ALLOW];

  const expandedDeny = expandToolGroups(deny);
  let expandedAllow = expandToolGroups(allow);
  if (
    expandedAllow.length > 0 &&
    !expandedDeny.map((v) => v.toLowerCase()).includes("image") &&
    !expandedAllow.map((v) => v.toLowerCase()).includes("image")
  ) {
    expandedAllow = [...expandedAllow, "image"];
  }

  return {
    allow: expandedAllow,
    deny: expandedDeny,
    sources: {
      allow: allowSource,
      deny: denySource,
    },
  };
}

export function isBrowserSandboxToolAllowed(
  policy: { allow?: string[]; deny?: string[] },
  name: string,
) {
  const normalized = normalizeGlob(name);
  const deny = compileGlobPatterns({
    raw: expandToolGroups(policy.deny ?? []),
    normalize: normalizeGlob,
  });
  if (matchesAnyGlobPattern(normalized, deny)) {
    return false;
  }
  const allow = compileGlobPatterns({
    raw: expandToolGroups(policy.allow ?? []),
    normalize: normalizeGlob,
  });
  if (allow.length === 0) {
    return true;
  }
  return matchesAnyGlobPattern(normalized, allow);
}
