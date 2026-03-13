import type { RuntimeConfig } from "../config/types.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../config/sessions/main-session.js";
import { expandToolGroups } from "./tool-policy.js";
import { resolveBrowserSandboxConfigForAgent } from "./browser-sandbox-config.js";
import { resolveBrowserSessionAgentIds } from "./browser-session-agent.js";
import { resolveBrowserSandboxToolPolicyForAgent } from "./browser-sandbox-tool-policy.js";

function formatBrowserCliCommand(command: string): string {
  const trimmed = command.trim();
  return trimmed ? `\`${trimmed}\`` : "`runtime`";
}

function shouldSandboxSession(
  cfg: { mode: "off" | "non-main" | "all" },
  sessionKey: string,
  mainSessionKey: string,
) {
  if (cfg.mode === "off") {
    return false;
  }
  if (cfg.mode === "all") {
    return true;
  }
  return sessionKey.trim() !== mainSessionKey.trim();
}

function resolveMainSessionKeyForSandbox(params: {
  cfg?: RuntimeConfig;
  agentId: string;
}): string {
  if (params.cfg?.session?.scope === "global") {
    return "global";
  }
  return resolveAgentMainSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
  });
}

function resolveComparableSessionKeyForSandbox(params: {
  cfg?: RuntimeConfig;
  agentId: string;
  sessionKey: string;
}): string {
  return canonicalizeMainSessionAlias({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
}

export function resolveBrowserSandboxRuntimeStatus(params: {
  cfg?: RuntimeConfig;
  sessionKey?: string;
}): {
  agentId: string;
  sessionKey: string;
  mainSessionKey: string;
  mode: "off" | "non-main" | "all";
  sandboxed: boolean;
  toolPolicy: ReturnType<typeof resolveBrowserSandboxToolPolicyForAgent>;
} {
  const sessionKey = params.sessionKey?.trim() ?? "";
  const agentId = resolveBrowserSessionAgentIds({
    sessionKey,
    config: params.cfg,
  }).sessionAgentId;
  const cfg = params.cfg;
  const sandboxCfg = resolveBrowserSandboxConfigForAgent(cfg, agentId);
  const mainSessionKey = resolveMainSessionKeyForSandbox({ cfg, agentId });
  const sandboxed = sessionKey
    ? shouldSandboxSession(
        sandboxCfg,
        resolveComparableSessionKeyForSandbox({ cfg, agentId, sessionKey }),
        mainSessionKey,
      )
    : false;
  return {
    agentId,
    sessionKey,
    mainSessionKey,
    mode: sandboxCfg.mode,
    sandboxed,
    toolPolicy: resolveBrowserSandboxToolPolicyForAgent(cfg, agentId),
  };
}

export function formatBrowserSandboxToolPolicyBlockedMessage(params: {
  cfg?: RuntimeConfig;
  sessionKey?: string;
  toolName: string;
}): string | undefined {
  const tool = params.toolName.trim().toLowerCase();
  if (!tool) {
    return undefined;
  }

  const runtime = resolveBrowserSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  if (!runtime.sandboxed) {
    return undefined;
  }

  const deny = new Set(expandToolGroups(runtime.toolPolicy.deny));
  const allow = expandToolGroups(runtime.toolPolicy.allow);
  const allowSet = allow.length > 0 ? new Set(allow) : null;
  const blockedByDeny = deny.has(tool);
  const blockedByAllow = allowSet ? !allowSet.has(tool) : false;
  if (!blockedByDeny && !blockedByAllow) {
    return undefined;
  }

  const reasons: string[] = [];
  const fixes: string[] = [];
  if (blockedByDeny) {
    reasons.push("deny list");
    fixes.push(`Remove "${tool}" from ${runtime.toolPolicy.sources.deny.key}.`);
  }
  if (blockedByAllow) {
    reasons.push("allow list");
    fixes.push(
      `Add "${tool}" to ${runtime.toolPolicy.sources.allow.key} (or set it to [] to allow all).`,
    );
  }

  const lines: string[] = [];
  lines.push(`Tool "${tool}" blocked by sandbox tool policy (mode=${runtime.mode}).`);
  lines.push(`Session: ${runtime.sessionKey || "(unknown)"}`);
  lines.push(`Reason: ${reasons.join(" + ")}`);
  lines.push("Fix:");
  lines.push(`- agents.defaults.sandbox.mode=off (disable sandbox)`);
  for (const fix of fixes) {
    lines.push(`- ${fix}`);
  }
  if (runtime.mode === "non-main") {
    lines.push(`- Use main session key (direct): ${runtime.mainSessionKey}`);
  }
  lines.push(
    `- See: ${formatBrowserCliCommand(`runtime sandbox explain --session ${runtime.sessionKey}`)}`,
  );

  return lines.join("\n");
}
