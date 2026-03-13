import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

function resolvePreferredRuntimeTmpDir(): string {
  const explicit = process.env.RUNTIME_TMP_DIR?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(os.tmpdir(), "runtime");
}

function buildMediaLocalRoots(stateDir: string): string[] {
  const resolvedStateDir = path.resolve(stateDir);
  return [
    resolvePreferredRuntimeTmpDir(),
    path.join(resolvedStateDir, "media"),
    path.join(resolvedStateDir, "agents"),
    path.join(resolvedStateDir, "workspace"),
    path.join(resolvedStateDir, "sandboxes"),
  ];
}

export function getDefaultMediaLocalRoots(): readonly string[] {
  return buildMediaLocalRoots(resolveStateDir());
}

export function getAgentScopedMediaLocalRoots(): readonly string[] {
  return getDefaultMediaLocalRoots();
}
