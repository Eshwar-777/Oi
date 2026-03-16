import type { BrowserSessionAdapter } from "./adapter";
import { AgentBrowserSessionAdapter } from "./agentBrowserAdapter";
import { CdpBrowserSessionAdapter } from "./cdpAdapter";
import { WindowBrowserSessionAdapter } from "./windowAdapter";

const REQUESTED_ADAPTER = process.env.OI_BROWSER_SESSION_ADAPTER ?? "window";
let resolvedAdapter: BrowserSessionAdapter | null = null;

export function createBrowserSessionAdapter(): BrowserSessionAdapter {
  if (resolvedAdapter) {
    return resolvedAdapter;
  }
  if (REQUESTED_ADAPTER === "agent_browser") {
    resolvedAdapter = new AgentBrowserSessionAdapter();
    return resolvedAdapter;
  }
  if (REQUESTED_ADAPTER === "window") {
    resolvedAdapter = new WindowBrowserSessionAdapter();
    return resolvedAdapter;
  }
  if (REQUESTED_ADAPTER === "cdp") {
    resolvedAdapter = new CdpBrowserSessionAdapter();
    return resolvedAdapter;
  }
  resolvedAdapter = new WindowBrowserSessionAdapter();
  return resolvedAdapter;
}

export function getBrowserSessionAdapterDiagnostics() {
  const adapter = resolvedAdapter ?? createBrowserSessionAdapter();
  return {
    adapter_requested: REQUESTED_ADAPTER,
    adapter_resolved: adapter.kind,
    adapter_runtime: adapter.runtime ?? adapter.kind,
    adapter_version: adapter.version ?? "unknown",
  };
}
