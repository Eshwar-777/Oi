export const AGENT_LANE_NESTED = "nested";
export const AGENT_LANE_SUBAGENT = "subagent";

export function resolveGlobalLane(lane: string | undefined | null): string {
  const normalized = String(lane || "").trim().toLowerCase();
  return normalized ? `global:${normalized}` : "global:default";
}

export function resolveSessionLane(sessionKey: string | undefined | null): string {
  const normalized = String(sessionKey || "").trim().toLowerCase();
  return normalized ? `session:${normalized}` : "session:default";
}
