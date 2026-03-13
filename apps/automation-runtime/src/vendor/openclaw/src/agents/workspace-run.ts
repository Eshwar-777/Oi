import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveBrowserAgentWorkspaceDir,
  resolveBrowserDefaultAgentId,
} from "./browser-workspace-config.js";
import { redactBrowserIdentifier } from "./browser-redact-identifier.js";
import { createBrowserSubsystemLogger } from "./browser-subsystem-logger.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

const log = createBrowserSubsystemLogger("workspace-run");
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

function classifySessionKeyShape(
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

export type WorkspaceFallbackReason = "missing" | "blank" | "invalid_type";
type AgentIdSource = "explicit" | "session_key" | "default";

export type ResolveRunWorkspaceResult = {
  workspaceDir: string;
  usedFallback: boolean;
  fallbackReason?: WorkspaceFallbackReason;
  agentId: string;
  agentIdSource: AgentIdSource;
};

function resolveRunAgentId(params: {
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): {
  agentId: string;
  agentIdSource: AgentIdSource;
} {
  const rawSessionKey = params.sessionKey?.trim() ?? "";
  const shape = classifySessionKeyShape(rawSessionKey);
  if (shape === "malformed_agent") {
    throw new Error("Malformed agent session key; refusing workspace resolution.");
  }

  const explicit =
    typeof params.agentId === "string" && params.agentId.trim()
      ? normalizeAgentId(params.agentId)
      : undefined;
  if (explicit) {
    return { agentId: explicit, agentIdSource: "explicit" };
  }

  const defaultAgentId = resolveBrowserDefaultAgentId(params.config ?? {});
  if (shape === "missing" || shape === "legacy_or_alias") {
    return {
      agentId: defaultAgentId || DEFAULT_AGENT_ID,
      agentIdSource: "default",
    };
  }

  const parsed = parseAgentSessionKey(rawSessionKey);
  if (parsed?.agentId) {
    return {
      agentId: normalizeAgentId(parsed.agentId),
      agentIdSource: "session_key",
    };
  }

  // Defensive fallback, should be unreachable for non-malformed shapes.
  return {
    agentId: defaultAgentId || DEFAULT_AGENT_ID,
    agentIdSource: "default",
  };
}

export function redactRunIdentifier(value: string | undefined): string {
  return redactBrowserIdentifier(value, { len: 12 });
}

export function resolveRunWorkspaceDir(params: {
  workspaceDir: unknown;
  sessionKey?: string;
  agentId?: string;
  config?: OpenClawConfig;
}): ResolveRunWorkspaceResult {
  const requested = params.workspaceDir;
  const { agentId, agentIdSource } = resolveRunAgentId({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    config: params.config,
  });
  if (typeof requested === "string") {
    const trimmed = requested.trim();
    if (trimmed) {
      const sanitized = sanitizeForPromptLiteral(trimmed);
      if (sanitized !== trimmed) {
        log.warn("Control/format characters stripped from workspaceDir (OC-19 hardening).");
      }
      return {
        workspaceDir: resolveBrowserUserPath(sanitized),
        usedFallback: false,
        agentId,
        agentIdSource,
      };
    }
  }

  const fallbackReason: WorkspaceFallbackReason =
    requested == null ? "missing" : typeof requested === "string" ? "blank" : "invalid_type";
  const fallbackWorkspace = resolveBrowserAgentWorkspaceDir(params.config ?? {}, agentId);
  const sanitizedFallback = sanitizeForPromptLiteral(fallbackWorkspace);
  if (sanitizedFallback !== fallbackWorkspace) {
    log.warn("Control/format characters stripped from fallback workspaceDir (OC-19 hardening).");
  }
  return {
    workspaceDir: resolveBrowserUserPath(sanitizedFallback),
    usedFallback: true,
    fallbackReason,
    agentId,
    agentIdSource,
  };
}
