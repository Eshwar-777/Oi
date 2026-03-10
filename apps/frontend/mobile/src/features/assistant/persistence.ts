import * as FileSystem from "expo-file-system/legacy";

const STORAGE_FILE = `${FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? ""}oi-mobile-assistant-state.json`;
const MAX_PERSIST_BYTES = 200_000;
const MAX_MESSAGES = 120;
const MAX_SCHEDULES = 40;
const MAX_RUN_SUMMARIES = 40;
const MAX_MESSAGE_TEXT = 4_000;
const MAX_REASON_TEXT = 2_000;

function truncateText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return value;
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength);
}

function fitPersistedValue<T>(value: T): T {
  if (!value || typeof value !== "object") return value;

  const root = { ...(value as Record<string, unknown>) };

  if (Array.isArray(root.messages)) {
    root.messages = root.messages.slice(-MAX_MESSAGES).map((message) =>
      message && typeof message === "object"
        ? {
            ...message,
            text: truncateText((message as { text?: unknown }).text, MAX_MESSAGE_TEXT),
          }
        : message,
    );
  }

  if (Array.isArray(root.schedules)) {
    root.schedules = root.schedules.slice(0, MAX_SCHEDULES);
  }

  if (typeof root.runReason === "string") {
    root.runReason = truncateText(root.runReason, MAX_REASON_TEXT);
  }

  if (root.runEventSummaries && typeof root.runEventSummaries === "object") {
    const entries = Object.entries(root.runEventSummaries as Record<string, unknown>)
      .sort(([, left], [, right]) => {
        const leftTime = Date.parse(String((left as { updatedAt?: unknown })?.updatedAt ?? "")) || 0;
        const rightTime = Date.parse(String((right as { updatedAt?: unknown })?.updatedAt ?? "")) || 0;
        return rightTime - leftTime;
      })
      .slice(0, MAX_RUN_SUMMARIES);
    root.runEventSummaries = Object.fromEntries(entries);

    if (root.runStatesById && typeof root.runStatesById === "object") {
      const activeRunId = String((root.activeRun as { run_id?: unknown } | null)?.run_id ?? "");
      const runDetailId = String((root.runDetail as { run?: { run_id?: unknown } } | null)?.run?.run_id ?? "");
      const keepIds = new Set([
        ...entries.map(([runId]) => runId),
        ...(activeRunId ? [activeRunId] : []),
        ...(runDetailId ? [runDetailId] : []),
      ]);
      root.runStatesById = Object.fromEntries(
        Object.entries(root.runStatesById as Record<string, unknown>).filter(([runId]) => keepIds.has(runId)),
      );
    }
  }

  let serialized = JSON.stringify(root);
  if (serialized.length <= MAX_PERSIST_BYTES) {
    return root as T;
  }

  root.runDetail = null;
  serialized = JSON.stringify(root);
  if (serialized.length <= MAX_PERSIST_BYTES) {
    return root as T;
  }

  if (Array.isArray(root.messages)) {
    root.messages = root.messages.slice(-40);
  }
  if (root.runEventSummaries && typeof root.runEventSummaries === "object") {
    root.runEventSummaries = {};
  }
  if (root.runStatesById && typeof root.runStatesById === "object") {
    root.runStatesById = {};
  }
  serialized = JSON.stringify(root);
  if (serialized.length <= MAX_PERSIST_BYTES) {
    return root as T;
  }

  root.messages = [];
  root.schedules = [];
  return root as T;
}

export async function loadPersistedJson<T>(fallback: T): Promise<T> {
  if (!STORAGE_FILE) return fallback;
  try {
    const info = await FileSystem.getInfoAsync(STORAGE_FILE);
    if (!info.exists) return fallback;
    const raw = await FileSystem.readAsStringAsync(STORAGE_FILE);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function savePersistedJson<T>(value: T): Promise<void> {
  if (!STORAGE_FILE) return;
  try {
    await FileSystem.writeAsStringAsync(STORAGE_FILE, JSON.stringify(fitPersistedValue(value)));
  } catch {
    // Ignore persistence failures to keep the chat usable.
  }
}
