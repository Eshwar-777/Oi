import fs from "node:fs";
import path from "node:path";
import { saveJsonFile } from "../../infra/json-file.js";
import { resolveBrowserOpenClawAgentDir } from "../browser-agent-dir.js";
import { AUTH_PROFILE_FILENAME, AUTH_STORE_VERSION, LEGACY_AUTH_FILENAME } from "./constants.js";
import type { AuthProfileStore } from "./types.js";

function resolveBrowserUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home) {
      return path.resolve(path.join(home, trimmed.slice(1)));
    }
  }
  return path.resolve(trimmed);
}

export function resolveAuthStorePath(agentDir?: string): string {
  const resolved = resolveBrowserUserPath(agentDir ?? resolveBrowserOpenClawAgentDir());
  return path.join(resolved, AUTH_PROFILE_FILENAME);
}

export function resolveLegacyAuthStorePath(agentDir?: string): string {
  const resolved = resolveBrowserUserPath(agentDir ?? resolveBrowserOpenClawAgentDir());
  return path.join(resolved, LEGACY_AUTH_FILENAME);
}

export function resolveAuthStorePathForDisplay(agentDir?: string): string {
  const pathname = resolveAuthStorePath(agentDir);
  return pathname.startsWith("~") ? pathname : resolveBrowserUserPath(pathname);
}

export function ensureAuthStoreFile(pathname: string) {
  if (fs.existsSync(pathname)) {
    return;
  }
  const payload: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  saveJsonFile(pathname, payload);
}
