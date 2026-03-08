import type { BrowserSessionAdapter } from "./adapter";
import { CdpBrowserSessionAdapter } from "./cdpAdapter";

const REQUESTED_ADAPTER = process.env.OI_BROWSER_SESSION_ADAPTER ?? "agent_browser";

export function createBrowserSessionAdapter(): BrowserSessionAdapter {
  if (REQUESTED_ADAPTER === "agent_browser") {
    return new CdpBrowserSessionAdapter();
  }
  return new CdpBrowserSessionAdapter();
}

export function getBrowserSessionAdapterDiagnostics() {
  return {
    adapter_requested: REQUESTED_ADAPTER,
    adapter_resolved: "cdp",
    adapter_runtime: "builtin_cdp",
  };
}
