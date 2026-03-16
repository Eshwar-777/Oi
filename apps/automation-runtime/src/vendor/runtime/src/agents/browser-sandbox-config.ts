import type { RuntimeConfig } from "../config/types.js";
import { resolveBrowserAgentConfig } from "./browser-agent-config.js";
import { resolveBrowserSandboxToolPolicyForAgent } from "./browser-sandbox-tool-policy.js";
import {
  DEFAULT_SANDBOX_BROWSER_AUTOSTART_TIMEOUT_MS,
  DEFAULT_SANDBOX_BROWSER_CDP_PORT,
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_BROWSER_NETWORK,
  DEFAULT_SANDBOX_BROWSER_NOVNC_PORT,
  DEFAULT_SANDBOX_BROWSER_PREFIX,
  DEFAULT_SANDBOX_BROWSER_VNC_PORT,
  DEFAULT_SANDBOX_CONTAINER_PREFIX,
  DEFAULT_SANDBOX_IDLE_HOURS,
  DEFAULT_SANDBOX_IMAGE,
  DEFAULT_SANDBOX_MAX_AGE_DAYS,
  DEFAULT_SANDBOX_WORKDIR,
  DEFAULT_SANDBOX_WORKSPACE_ROOT,
} from "./sandbox/constants.js";

type SandboxScope = "agent" | "session" | "shared";

function resolveSandboxScope(params: {
  scope?: SandboxScope;
  perSession?: boolean;
}): SandboxScope {
  if (params.scope) {
    return params.scope;
  }
  if (typeof params.perSession === "boolean") {
    return params.perSession ? "session" : "shared";
  }
  return "agent";
}

export function resolveBrowserSandboxConfigForAgent(cfg?: RuntimeConfig, agentId?: string) {
  const globalSandbox = cfg?.agents?.defaults?.sandbox;
  const agentSandbox = cfg && agentId ? resolveBrowserAgentConfig(cfg, agentId)?.sandbox : undefined;
  const scope = resolveSandboxScope({
    scope: agentSandbox?.scope ?? globalSandbox?.scope,
    perSession: agentSandbox?.perSession ?? globalSandbox?.perSession,
  });
  const toolPolicy = resolveBrowserSandboxToolPolicyForAgent(cfg, agentId);
  const globalDocker = globalSandbox?.docker;
  const agentDocker = scope === "shared" ? undefined : agentSandbox?.docker;
  const globalBrowser = globalSandbox?.browser;
  const agentBrowser = scope === "shared" ? undefined : agentSandbox?.browser;
  const globalPrune = globalSandbox?.prune;
  const agentPrune = scope === "shared" ? undefined : agentSandbox?.prune;
  const binds = [...(globalDocker?.binds ?? []), ...(agentDocker?.binds ?? [])];
  const browserBinds = [...(globalBrowser?.binds ?? []), ...(agentBrowser?.binds ?? [])];

  return {
    mode: agentSandbox?.mode ?? globalSandbox?.mode ?? "off",
    scope,
    workspaceAccess: agentSandbox?.workspaceAccess ?? globalSandbox?.workspaceAccess ?? "none",
    workspaceRoot:
      agentSandbox?.workspaceRoot ?? globalSandbox?.workspaceRoot ?? DEFAULT_SANDBOX_WORKSPACE_ROOT,
    docker: {
      image: agentDocker?.image ?? globalDocker?.image ?? DEFAULT_SANDBOX_IMAGE,
      containerPrefix:
        agentDocker?.containerPrefix ??
        globalDocker?.containerPrefix ??
        DEFAULT_SANDBOX_CONTAINER_PREFIX,
      workdir: agentDocker?.workdir ?? globalDocker?.workdir ?? DEFAULT_SANDBOX_WORKDIR,
      readOnlyRoot: agentDocker?.readOnlyRoot ?? globalDocker?.readOnlyRoot ?? true,
      tmpfs: agentDocker?.tmpfs ?? globalDocker?.tmpfs ?? ["/tmp", "/var/tmp", "/run"],
      network: agentDocker?.network ?? globalDocker?.network ?? "none",
      user: agentDocker?.user ?? globalDocker?.user,
      capDrop: agentDocker?.capDrop ?? globalDocker?.capDrop ?? ["ALL"],
      env: agentDocker?.env
        ? { ...(globalDocker?.env ?? { LANG: "C.UTF-8" }), ...agentDocker.env }
        : (globalDocker?.env ?? { LANG: "C.UTF-8" }),
      setupCommand: agentDocker?.setupCommand ?? globalDocker?.setupCommand,
      pidsLimit: agentDocker?.pidsLimit ?? globalDocker?.pidsLimit,
      memory: agentDocker?.memory ?? globalDocker?.memory,
      memorySwap: agentDocker?.memorySwap ?? globalDocker?.memorySwap,
      cpus: agentDocker?.cpus ?? globalDocker?.cpus,
      ulimits: agentDocker?.ulimits
        ? { ...globalDocker?.ulimits, ...agentDocker.ulimits }
        : globalDocker?.ulimits,
      seccompProfile: agentDocker?.seccompProfile ?? globalDocker?.seccompProfile,
      apparmorProfile: agentDocker?.apparmorProfile ?? globalDocker?.apparmorProfile,
      dns: agentDocker?.dns ?? globalDocker?.dns,
      extraHosts: agentDocker?.extraHosts ?? globalDocker?.extraHosts,
      binds: binds.length > 0 ? binds : undefined,
      dangerouslyAllowReservedContainerTargets:
        agentDocker?.dangerouslyAllowReservedContainerTargets ??
        globalDocker?.dangerouslyAllowReservedContainerTargets,
      dangerouslyAllowExternalBindSources:
        agentDocker?.dangerouslyAllowExternalBindSources ??
        globalDocker?.dangerouslyAllowExternalBindSources,
      dangerouslyAllowContainerNamespaceJoin:
        agentDocker?.dangerouslyAllowContainerNamespaceJoin ??
        globalDocker?.dangerouslyAllowContainerNamespaceJoin,
    },
    browser: {
      enabled: agentBrowser?.enabled ?? globalBrowser?.enabled ?? false,
      image: agentBrowser?.image ?? globalBrowser?.image ?? DEFAULT_SANDBOX_BROWSER_IMAGE,
      containerPrefix:
        agentBrowser?.containerPrefix ??
        globalBrowser?.containerPrefix ??
        DEFAULT_SANDBOX_BROWSER_PREFIX,
      network: agentBrowser?.network ?? globalBrowser?.network ?? DEFAULT_SANDBOX_BROWSER_NETWORK,
      cdpPort: agentBrowser?.cdpPort ?? globalBrowser?.cdpPort ?? DEFAULT_SANDBOX_BROWSER_CDP_PORT,
      cdpSourceRange: agentBrowser?.cdpSourceRange ?? globalBrowser?.cdpSourceRange,
      vncPort: agentBrowser?.vncPort ?? globalBrowser?.vncPort ?? DEFAULT_SANDBOX_BROWSER_VNC_PORT,
      noVncPort:
        agentBrowser?.noVncPort ?? globalBrowser?.noVncPort ?? DEFAULT_SANDBOX_BROWSER_NOVNC_PORT,
      headless: agentBrowser?.headless ?? globalBrowser?.headless ?? false,
      enableNoVnc: agentBrowser?.enableNoVnc ?? globalBrowser?.enableNoVnc ?? true,
      allowHostControl: agentBrowser?.allowHostControl ?? globalBrowser?.allowHostControl ?? false,
      autoStart: agentBrowser?.autoStart ?? globalBrowser?.autoStart ?? true,
      autoStartTimeoutMs:
        agentBrowser?.autoStartTimeoutMs ??
        globalBrowser?.autoStartTimeoutMs ??
        DEFAULT_SANDBOX_BROWSER_AUTOSTART_TIMEOUT_MS,
      binds:
        globalBrowser?.binds !== undefined || agentBrowser?.binds !== undefined
          ? browserBinds
          : undefined,
    },
    tools: {
      allow: toolPolicy.allow,
      deny: toolPolicy.deny,
    },
    prune: {
      idleHours: agentPrune?.idleHours ?? globalPrune?.idleHours ?? DEFAULT_SANDBOX_IDLE_HOURS,
      maxAgeDays: agentPrune?.maxAgeDays ?? globalPrune?.maxAgeDays ?? DEFAULT_SANDBOX_MAX_AGE_DAYS,
    },
  };
}

export function resolveBrowserSandboxBrowserDockerCreateConfig(params: {
  docker: ReturnType<typeof resolveBrowserSandboxConfigForAgent>["docker"];
  browser: ReturnType<typeof resolveBrowserSandboxConfigForAgent>["browser"];
}) {
  const browserNetwork = params.browser.network.trim();
  const base = {
    ...params.docker,
    network: browserNetwork || DEFAULT_SANDBOX_BROWSER_NETWORK,
    image: params.browser.image,
  };
  return params.browser.binds !== undefined ? { ...base, binds: params.browser.binds } : base;
}
