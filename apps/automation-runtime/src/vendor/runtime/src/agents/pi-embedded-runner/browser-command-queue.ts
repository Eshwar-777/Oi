type QueueEntry<T> = {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  warnAfterMs: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
};

type LaneState = {
  active: boolean;
  queue: QueueEntry<unknown>[];
};

const lanes = new Map<string, LaneState>();

function getLaneState(lane: string): LaneState {
  const existing = lanes.get(lane);
  if (existing) {
    return existing;
  }
  const created: LaneState = { active: false, queue: [] };
  lanes.set(lane, created);
  return created;
}

function drainLane(lane: string): void {
  const state = getLaneState(lane);
  if (state.active) {
    return;
  }
  const next = state.queue.shift();
  if (!next) {
    return;
  }
  state.active = true;
  const waitedMs = Date.now() - next.enqueuedAt;
  if (waitedMs >= next.warnAfterMs) {
    next.onWait?.(waitedMs, state.queue.length);
  }
  void next
    .task()
    .then((value) => next.resolve(value))
    .catch((error) => next.reject(error))
    .finally(() => {
      state.active = false;
      drainLane(lane);
    });
}

export function enqueueBrowserCommandInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
  },
): Promise<T> {
  const cleaned = lane.trim() || "main";
  const state = getLaneState(cleaned);
  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      task,
      resolve,
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs: opts?.warnAfterMs ?? 2_000,
      onWait: opts?.onWait,
    });
    drainLane(cleaned);
  });
}
