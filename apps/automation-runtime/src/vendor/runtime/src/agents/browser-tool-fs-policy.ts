import type { RuntimeConfig } from "../config/types.js";
import { resolveBrowserAgentConfig } from "./browser-agent-config.js";

export function resolveBrowserEffectiveToolFsWorkspaceOnly(params: {
  cfg?: RuntimeConfig;
  agentId?: string;
}): boolean {
  const globalFs = params.cfg?.tools?.fs;
  const agentFs =
    params.cfg && params.agentId
      ? resolveBrowserAgentConfig(params.cfg, params.agentId)?.tools?.fs
      : undefined;
  return (agentFs?.workspaceOnly ?? globalFs?.workspaceOnly) === true;
}
