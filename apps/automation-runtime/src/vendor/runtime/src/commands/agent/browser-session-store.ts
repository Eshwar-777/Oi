import fs from "node:fs";
import { acquireSessionWriteLock } from "../../agents/session-write-lock.js";
import { writeTextAtomic } from "../../infra/json-files.js";
import type { SessionEntry } from "../../config/sessions/types.js";

function isSessionStoreRecord(value: unknown): value is Record<string, SessionEntry> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function loadBrowserSessionStore(storePath: string): Record<string, SessionEntry> {
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const parsed = JSON.parse(raw);
    return isSessionStoreRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function updateBrowserSessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
): Promise<T> {
  const lock = await acquireSessionWriteLock({
    sessionFile: storePath,
    timeoutMs: 10_000,
    allowReentrant: true,
  });
  try {
    const store = loadBrowserSessionStore(storePath);
    const result = await mutator(store);
    await writeTextAtomic(storePath, JSON.stringify(store, null, 2), {
      mode: 0o600,
      appendTrailingNewline: true,
    });
    return result;
  } finally {
    await lock.release();
  }
}
