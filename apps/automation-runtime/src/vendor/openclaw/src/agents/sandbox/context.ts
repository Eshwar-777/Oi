import path from "node:path";
import fs from "node:fs/promises";
import type { OpenClawConfig } from "../../config/types.js";
import { resolveBrowserSandboxConfigForAgent } from "../browser-sandbox-config.js";
import { resolveBrowserSandboxRuntimeStatus } from "../browser-sandbox-runtime-status.js";
import { resolveBrowserDefaultAgentWorkspaceDir } from "../browser-workspace-config.js";
import { resolveSandboxScopeKey, resolveSandboxWorkspaceDir } from "./shared.js";
import type { SandboxContext, SandboxDockerConfig, SandboxWorkspaceInfo } from "./types.js";

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

async function ensureSandboxWorkspaceLayout(params: {
  cfg: ReturnType<typeof resolveBrowserSandboxConfigForAgent>;
  rawSessionKey: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<{
  agentWorkspaceDir: string;
  scopeKey: string;
  sandboxWorkspaceDir: string;
  workspaceDir: string;
}> {
  const { cfg, rawSessionKey } = params;

  const agentWorkspaceDir = resolveBrowserUserPath(
    params.workspaceDir?.trim() || resolveBrowserDefaultAgentWorkspaceDir(params.config),
  );
  const workspaceRoot = resolveBrowserUserPath(cfg.workspaceRoot);
  const scopeKey = resolveSandboxScopeKey(cfg.scope, rawSessionKey);
  const sandboxWorkspaceDir =
    cfg.scope === "shared" ? workspaceRoot : resolveSandboxWorkspaceDir(workspaceRoot, scopeKey);
  const workspaceDir = cfg.workspaceAccess === "rw" ? agentWorkspaceDir : sandboxWorkspaceDir;

  if (workspaceDir === sandboxWorkspaceDir) {
    const { ensureSandboxWorkspace } = await import("./workspace.js");
    await ensureSandboxWorkspace(
      sandboxWorkspaceDir,
      agentWorkspaceDir,
      params.config?.agents?.defaults?.skipBootstrap,
    );
  } else {
    await fs.mkdir(workspaceDir, { recursive: true });
  }

  return { agentWorkspaceDir, scopeKey, sandboxWorkspaceDir, workspaceDir };
}

export async function resolveSandboxDockerUser(params: {
  docker: SandboxDockerConfig;
  workspaceDir: string;
  stat?: (workspaceDir: string) => Promise<{ uid: number; gid: number }>;
}): Promise<SandboxDockerConfig> {
  const configuredUser = params.docker.user?.trim();
  if (configuredUser) {
    return params.docker;
  }
  const stat = params.stat ?? ((workspaceDir: string) => fs.stat(workspaceDir));
  try {
    const workspaceStat = await stat(params.workspaceDir);
    const uid = Number.isInteger(workspaceStat.uid) ? workspaceStat.uid : null;
    const gid = Number.isInteger(workspaceStat.gid) ? workspaceStat.gid : null;
    if (uid === null || gid === null || uid < 0 || gid < 0) {
      return params.docker;
    }
    return { ...params.docker, user: `${uid}:${gid}` };
  } catch {
    return params.docker;
  }
}

function resolveSandboxSession(params: { config?: OpenClawConfig; sessionKey?: string }) {
  const rawSessionKey = params.sessionKey?.trim();
  if (!rawSessionKey) {
    return null;
  }

  const runtime = resolveBrowserSandboxRuntimeStatus({
    cfg: params.config,
    sessionKey: rawSessionKey,
  });
  if (!runtime.sandboxed) {
    return null;
  }

  const cfg = resolveBrowserSandboxConfigForAgent(params.config, runtime.agentId);
  return { rawSessionKey, runtime, cfg };
}

export async function resolveSandboxContext(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxContext | null> {
  const resolved = resolveSandboxSession(params);
  if (!resolved) {
    return null;
  }
  const { rawSessionKey, cfg } = resolved;
  const { maybePruneSandboxes } = await import("./prune.js");

  await maybePruneSandboxes(cfg);

  const { agentWorkspaceDir, scopeKey, workspaceDir } = await ensureSandboxWorkspaceLayout({
    cfg,
    rawSessionKey,
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  const docker = await resolveSandboxDockerUser({
    docker: cfg.docker,
    workspaceDir,
  });
  const resolvedCfg = docker === cfg.docker ? cfg : { ...cfg, docker };

  const { ensureSandboxContainer } = await import("./docker.js");
  const containerName = await ensureSandboxContainer({
    sessionKey: rawSessionKey,
    workspaceDir,
    agentWorkspaceDir,
    cfg: resolvedCfg,
  });

  const { DEFAULT_BROWSER_EVALUATE_ENABLED } = await import("../../browser/constants.js");
  const evaluateEnabled =
    params.config?.browser?.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED;

  const bridgeAuth = cfg.browser.enabled
    ? await (async () => {
        const [{ ensureBrowserControlAuth, resolveBrowserControlAuth }, { loadBrowserConfig }] =
          await Promise.all([
            import("../../browser/control-auth.js"),
            import("../../config/browser-config.js"),
          ]);
        // Sandbox browser bridge server runs on a loopback TCP port; always wire up
        // the same auth that loopback browser clients will send (token/password).
        const cfgForAuth = params.config ?? loadBrowserConfig();
        let browserAuth = resolveBrowserControlAuth(cfgForAuth);
        try {
          const ensured = await ensureBrowserControlAuth({ cfg: cfgForAuth });
          browserAuth = ensured.auth;
        } catch (error) {
          const message = error instanceof Error ? error.message : JSON.stringify(error);
          const { defaultRuntime } = await import("../../runtime.js");
          defaultRuntime.error?.(`Sandbox browser auth ensure failed: ${message}`);
        }
        return browserAuth;
      })()
    : undefined;
  const { ensureSandboxBrowser } = await import("./browser.js");
  const browser = await ensureSandboxBrowser({
    scopeKey,
    workspaceDir,
    agentWorkspaceDir,
    cfg: resolvedCfg,
    evaluateEnabled,
    bridgeAuth,
  });

  const sandboxContext: SandboxContext = {
    enabled: true,
    sessionKey: rawSessionKey,
    workspaceDir,
    agentWorkspaceDir,
    workspaceAccess: resolvedCfg.workspaceAccess,
    containerName,
    containerWorkdir: resolvedCfg.docker.workdir,
    docker: resolvedCfg.docker,
    tools: resolvedCfg.tools,
    browserAllowHostControl: resolvedCfg.browser.allowHostControl,
    browser: browser ?? undefined,
  };

  const { createSandboxFsBridge } = await import("./fs-bridge.js");
  sandboxContext.fsBridge = createSandboxFsBridge({ sandbox: sandboxContext });

  return sandboxContext;
}

export async function ensureSandboxWorkspaceForSession(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxWorkspaceInfo | null> {
  const resolved = resolveSandboxSession(params);
  if (!resolved) {
    return null;
  }
  const { rawSessionKey, cfg } = resolved;

  const { workspaceDir } = await ensureSandboxWorkspaceLayout({
    cfg,
    rawSessionKey,
    config: params.config,
    workspaceDir: params.workspaceDir,
  });

  return {
    workspaceDir,
    containerWorkdir: cfg.docker.workdir,
  };
}
