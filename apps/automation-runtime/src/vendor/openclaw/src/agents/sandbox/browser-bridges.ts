import type { BrowserBridge } from "../../browser/bridge-core-server.js";

export const BROWSER_BRIDGES = new Map<
  string,
  {
    bridge: BrowserBridge;
    containerName: string;
    authToken?: string;
    authPassword?: string;
  }
>();
