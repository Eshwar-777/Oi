import type { AgentTool } from "@mariozechner/pi-agent-core";
import { toBrowserToolDefinitions } from "../browser-tool-definition-adapter.js";

type AnyAgentTool = AgentTool;

export function splitBrowserSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }): {
  builtInTools: AnyAgentTool[];
  customTools: ReturnType<typeof toBrowserToolDefinitions>;
} {
  const { tools } = options;
  return {
    builtInTools: [],
    customTools: toBrowserToolDefinitions(tools),
  };
}
