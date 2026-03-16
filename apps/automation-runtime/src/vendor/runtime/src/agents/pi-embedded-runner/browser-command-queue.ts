const LANE_QUEUES = new Map<string, Promise<unknown>>();

export async function enqueueBrowserCommandInLane<T>(
  lane: string,
  task: () => Promise<T> | T,
  _opts?: Record<string, unknown>,
): Promise<T> {
  const laneKey = String(lane || "default").trim() || "default";
  const previous = LANE_QUEUES.get(laneKey) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = previous.finally(() => gate);
  LANE_QUEUES.set(laneKey, pending);
  try {
    await previous.catch(() => undefined);
    return await task();
  } finally {
    release();
    if (LANE_QUEUES.get(laneKey) === pending) {
      LANE_QUEUES.delete(laneKey);
    }
  }
}
