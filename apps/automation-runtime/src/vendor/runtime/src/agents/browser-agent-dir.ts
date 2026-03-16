import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export function resolveBrowserRuntimeAgentDir(): string {
  const stateDir = resolveStateDir(process.env, os.homedir);
  return path.join(stateDir, "agents", "main");
}
