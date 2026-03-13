import type { RuntimeConfig } from "../config/types.js";
import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import { resolveBrowserAgentConfig } from "./browser-agent-config.js";

export function resolveBrowserToolLoopDetectionConfig(params: {
  cfg?: RuntimeConfig;
  agentId?: string;
}): ToolLoopDetectionConfig | undefined {
  const global = params.cfg?.tools?.loopDetection;
  const agent =
    params.agentId && params.cfg
      ? resolveBrowserAgentConfig(params.cfg, params.agentId)?.tools?.loopDetection
      : undefined;

  if (!agent) {
    return global;
  }
  if (!global) {
    return agent;
  }

  return {
    ...global,
    ...agent,
    detectors: {
      ...global.detectors,
      ...agent.detectors,
    },
  };
}
