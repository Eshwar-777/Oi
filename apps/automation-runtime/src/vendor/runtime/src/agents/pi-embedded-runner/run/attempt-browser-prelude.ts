import fs from "node:fs/promises";
import { resolveUserPath } from "../../../utils.js";
import { resolveBrowserSessionAgentIds } from "../../browser-session-agent.js";
import { resolveBrowserEffectiveToolFsWorkspaceOnly } from "../../browser-tool-fs-policy.js";
import { createRuntimeBrowserOnlyTools } from "../../runtime-browser-tools.js";
import { resolveSandboxContext } from "../../sandbox/context.js";
import { supportsModelTools } from "../../model-tool-support.js";
import { sanitizeToolsForGoogle } from "../google.js";
import { collectAllowedToolNames } from "../tool-name-allowlist.js";
import { resolveBrowserCoreSkillsPrompt } from "../../browser-core-skills-prompt.js";

type EmbeddedRunAttemptParams = import("./types.js").EmbeddedRunAttemptParams;

function resolveBrowserAttemptFsWorkspaceOnly(params: {
  config?: import("../../../config/types.js").RuntimeConfig;
  sessionAgentId: string;
}): boolean {
  return resolveBrowserEffectiveToolFsWorkspaceOnly({
    cfg: params.config,
    agentId: params.sessionAgentId,
  });
}

export async function prepareBrowserOnlyAttemptPrelude(
  params: EmbeddedRunAttemptParams,
  runAbortSignal: AbortSignal,
) {
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  await fs.mkdir(resolvedWorkspace, { recursive: true });

  const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;
  await fs.mkdir(effectiveWorkspace, { recursive: true });

  const { defaultAgentId, sessionAgentId } = resolveBrowserSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
    agentId: params.agentId,
  });
  const effectiveFsWorkspaceOnly = resolveBrowserAttemptFsWorkspaceOnly({
    config: params.config,
    sessionAgentId,
  });
  const toolsEnabled = supportsModelTools(params.model);
  const rawTools = params.disableTools
    ? []
    : createRuntimeBrowserOnlyTools({
        sandboxBrowserBridgeUrl: sandbox?.browser?.bridgeUrl,
        allowHostBrowserControl: sandbox ? sandbox.browserAllowHostControl : true,
        agentSessionKey: sandboxSessionKey,
        messageProvider: params.messageChannel ?? params.messageProvider,
      });
  const tools = sanitizeToolsForGoogle({
    tools: toolsEnabled ? rawTools : [],
    provider: params.provider,
  });
  const clientTools = toolsEnabled ? params.clientTools : undefined;
  const allowedToolNames = collectAllowedToolNames({
    tools,
    clientTools,
  });

  return {
    resolvedWorkspace,
    sandboxSessionKey,
    sandbox,
    effectiveWorkspace,
    skillsPrompt: resolveBrowserCoreSkillsPrompt(),
    defaultAgentId,
    sessionAgentId,
    effectiveFsWorkspaceOnly,
    tools,
    clientTools,
    allowedToolNames,
  };
}
