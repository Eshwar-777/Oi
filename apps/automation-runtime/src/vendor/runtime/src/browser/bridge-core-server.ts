import type { ResolvedBrowserConfig } from "./config.js";

export type BrowserBridge = {
  server: { close?: () => void | Promise<void> };
  state: {
    resolved: ResolvedBrowserConfig;
  };
};

export async function startBrowserCoreBridgeServer(params: {
  resolved: ResolvedBrowserConfig;
  authToken?: string;
  authPassword?: string;
  onEnsureAttachTarget?: () => Promise<void>;
  resolveSandboxNoVncToken?: (token: string) => Promise<string | null> | string | null;
}): Promise<BrowserBridge> {
  await params.onEnsureAttachTarget?.();
  return {
    server: {
      close: async () => undefined,
    },
    state: {
      resolved: params.resolved,
    },
  };
}

export async function stopBrowserCoreBridgeServer(
  server: BrowserBridge["server"] | undefined,
): Promise<void> {
  await server?.close?.();
}
