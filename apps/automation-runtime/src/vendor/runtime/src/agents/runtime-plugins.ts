import type { RuntimeConfig } from "../config/config.js";
import { loadRuntimePlugins } from "../plugins/loader.js";
import { resolveUserPath } from "../utils.js";

export function ensureRuntimePluginsLoaded(params: {
  config?: RuntimeConfig;
  workspaceDir?: string | null;
}): void {
  const workspaceDir =
    typeof params.workspaceDir === "string" && params.workspaceDir.trim()
      ? resolveUserPath(params.workspaceDir)
      : undefined;

  loadRuntimePlugins({
    config: params.config,
    workspaceDir,
  });
}
