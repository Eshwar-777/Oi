import { resolveBrowserGatewayMessageChannel } from "./browser-message-channel.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { createBrowserTool } from "./tools/browser-tool.js";

export function createRuntimeBrowserOnlyTools(options?: {
  sandboxBrowserBridgeUrl?: string;
  allowHostBrowserControl?: boolean;
  agentSessionKey?: string;
  messageProvider?: string;
}): AnyAgentTool[] {
  return [
    createBrowserTool({
      sandboxBridgeUrl: options?.sandboxBrowserBridgeUrl,
      allowHostControl: options?.allowHostBrowserControl,
      agentSessionKey: options?.agentSessionKey,
      agentChannel: resolveBrowserGatewayMessageChannel(options?.messageProvider),
    }),
  ];
}
