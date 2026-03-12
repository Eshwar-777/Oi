import type { RuntimeEvent } from "../contracts/events.js";

export function createRuntimeEvent(
  seq: number,
  runId: string,
  type: RuntimeEvent["type"],
  payload: Record<string, unknown>,
): RuntimeEvent {
  return {
    seq,
    runId,
    type,
    payload,
    createdAt: new Date().toISOString(),
  };
}
