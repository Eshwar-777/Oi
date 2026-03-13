import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

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

export function resolveBrowserRuntimeAgentDir(): string {
  const override =
    process.env.RUNTIME_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) {
    return resolveBrowserUserPath(override);
  }
  return path.join(resolveStateDir(), "agents", "main", "agent");
}

export function ensureBrowserRuntimeAgentEnv(): string {
  const dir = resolveBrowserRuntimeAgentDir();
  if (!process.env.RUNTIME_AGENT_DIR) {
    process.env.RUNTIME_AGENT_DIR = dir;
  }
  if (!process.env.PI_CODING_AGENT_DIR) {
    process.env.PI_CODING_AGENT_DIR = dir;
  }
  return dir;
}
