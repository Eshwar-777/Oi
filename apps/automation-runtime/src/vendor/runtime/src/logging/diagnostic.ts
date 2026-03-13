import { createSubsystemLogger } from "./subsystem.js";

export const diagnosticLogger = createSubsystemLogger("diagnostic");

export function logMessageQueued(_params: {
  sessionId?: string;
  sessionKey?: string;
  channel?: string;
  source: string;
}): void {
  // Browser-runtime compatibility shim: detailed diagnostics were pruned.
}

export function logSessionStateChange(_params: {
  sessionId?: string;
  sessionKey?: string;
  state: string;
  reason?: string;
}): void {
  // Browser-runtime compatibility shim: detailed diagnostics were pruned.
}
