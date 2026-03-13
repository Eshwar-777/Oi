type LoopRecord = {
  signature: string;
  resultHash: string;
};

export type LoopDetectionResult =
  | { stuck: false }
  | {
      stuck: true;
      detector: "generic_repeat" | "ping_pong";
      count: number;
      message: string;
    };

export type LoopState = {
  history: LoopRecord[];
};

const WARNING_THRESHOLD = 3;
const CRITICAL_THRESHOLD = 4;
const HISTORY_LIMIT = 16;

export function createLoopState(): LoopState {
  return { history: [] };
}

export function recordLoopObservation(
  state: LoopState,
  signature: string,
  resultHash: string,
): LoopDetectionResult {
  state.history.push({ signature, resultHash });
  if (state.history.length > HISTORY_LIMIT) {
    state.history.splice(0, state.history.length - HISTORY_LIMIT);
  }

  const identical = state.history.filter(
    (item) => item.signature === signature && item.resultHash === resultHash,
  ).length;
  if (identical >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      detector: "generic_repeat",
      count: identical,
      message:
        "Repeated identical browser observations made no progress. Stop retrying and surface an observation_exhausted incident.",
    };
  }

  const recent = state.history.slice(-CRITICAL_THRESHOLD);
  if (
    recent.length >= CRITICAL_THRESHOLD &&
    recent.every((item) => item.resultHash === recent[0]?.resultHash) &&
    new Set(recent.map((item) => item.signature)).size === 2
  ) {
    return {
      stuck: true,
      detector: "ping_pong",
      count: recent.length,
      message:
        "Alternating browser observation patterns are producing the same result. Stop retrying and surface an observation_exhausted incident.",
    };
  }

  return { stuck: false };
}
