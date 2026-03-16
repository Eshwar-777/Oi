import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptPath,
} from "./paths.js";
import type { SessionEntry } from "./types.js";
import { updateBrowserSessionStore } from "../../commands/agent/browser-session-store.js";

export async function resolveBrowserSessionTranscriptFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  agentId: string;
  threadId?: string | number;
}): Promise<{ sessionFile: string; sessionEntry: SessionEntry | undefined }> {
  const sessionPathOpts = resolveSessionFilePathOptions({
    agentId: params.agentId,
    storePath: params.storePath,
  });
  let sessionFile = resolveSessionFilePath(params.sessionId, params.sessionEntry, sessionPathOpts);
  let sessionEntry = params.sessionEntry;

  if (params.sessionStore && params.storePath) {
    const fallbackSessionFile = !sessionEntry?.sessionFile
      ? resolveSessionTranscriptPath(params.sessionId, params.agentId, params.threadId)
      : undefined;
    const baseEntry =
      sessionEntry ??
      params.sessionStore[params.sessionKey] ?? {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      };
    const entryForResolve =
      !baseEntry.sessionFile && fallbackSessionFile
        ? { ...baseEntry, sessionFile: fallbackSessionFile }
        : baseEntry;
    sessionFile = resolveSessionFilePath(params.sessionId, entryForResolve, {
      agentId: sessionPathOpts?.agentId,
      sessionsDir: sessionPathOpts?.sessionsDir,
    });
    const persistedEntry: SessionEntry = {
      ...baseEntry,
      sessionId: params.sessionId,
      updatedAt: Date.now(),
      sessionFile,
    };
    if (
      baseEntry.sessionId !== params.sessionId ||
      baseEntry.sessionFile !== sessionFile
    ) {
      params.sessionStore[params.sessionKey] = persistedEntry;
      await updateBrowserSessionStore(params.storePath, (store) => {
        store[params.sessionKey] = {
          ...store[params.sessionKey],
          ...persistedEntry,
        };
      });
      sessionEntry = persistedEntry;
    } else {
      params.sessionStore[params.sessionKey] = persistedEntry;
      sessionEntry = persistedEntry;
    }
  }

  return {
    sessionFile,
    sessionEntry,
  };
}
