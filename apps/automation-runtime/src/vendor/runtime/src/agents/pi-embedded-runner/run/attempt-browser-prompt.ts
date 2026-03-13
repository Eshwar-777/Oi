import os from "node:os";
import { getMachineDisplayName } from "../../../infra/machine-name.js";
import { resolveBrowserSandboxRuntimeStatus } from "../../browser-sandbox-runtime-status.js";
import { resolveDefaultModelForAgent } from "../../model-selection.js";
import { buildSystemPromptParams } from "../../system-prompt-params.js";
import { buildSystemPromptReport } from "../../system-prompt-report.js";
import { buildModelAliasLines } from "../model.js";
import { isBrowserReasoningTagProvider } from "../browser-provider-utils.js";
import {
  buildEmbeddedSystemPrompt,
  createSystemPromptOverride,
} from "../system-prompt.js";

type EmbeddedRunAttemptParams = import("./types.js").EmbeddedRunAttemptParams;

export async function buildBrowserOnlyPromptArtifacts(params: {
  attempt: EmbeddedRunAttemptParams;
  sessionAgentId: string;
  sandboxSessionKey: string;
  effectiveWorkspace: string;
  sandbox: import("../../sandbox/types.js").SandboxContext | null;
  skillsPrompt: string;
  tools: unknown[];
}) {
  const machineName = await getMachineDisplayName();
  const reasoningTagHint = isBrowserReasoningTagProvider(
    params.attempt.provider,
  );
  const defaultModelRef = resolveDefaultModelForAgent({
    cfg: params.attempt.config ?? {},
    agentId: params.sessionAgentId,
  });
  const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
  const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
    config: params.attempt.config,
    agentId: params.sessionAgentId,
    workspaceDir: params.effectiveWorkspace,
    cwd: process.cwd(),
    runtime: {
      host: machineName,
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
      model: `${params.attempt.provider}/${params.attempt.modelId}`,
      defaultModel: defaultModelLabel,
      shell: process.env.SHELL ?? "unknown",
      channel: undefined,
      capabilities: undefined,
      channelActions: undefined,
    },
  });

  const appendPrompt = buildEmbeddedSystemPrompt({
    workspaceDir: params.effectiveWorkspace,
    defaultThinkLevel: params.attempt.thinkLevel,
    reasoningLevel: params.attempt.reasoningLevel ?? "off",
    extraSystemPrompt: params.attempt.extraSystemPrompt,
    ownerNumbers: params.attempt.ownerNumbers,
    ownerDisplay: undefined,
    ownerDisplaySecret: undefined,
    reasoningTagHint,
    heartbeatPrompt: undefined,
    skillsPrompt: params.skillsPrompt,
    docsPath: undefined,
    ttsHint: undefined,
    workspaceNotes: undefined,
    reactionGuidance: undefined,
    promptMode: "full",
    acpEnabled: params.attempt.config?.acp?.enabled !== false,
    runtimeInfo,
    messageToolHints: undefined,
    sandboxInfo: {
      enabled: Boolean(params.sandbox?.enabled),
      mode: params.sandbox?.enabled ? "sandboxed" : "host",
      browserBridgeUrl: params.sandbox?.browser?.bridgeUrl,
      fsBridgeUrl: params.sandbox?.fsBridge?.url,
      shellEscalated: params.attempt.bashElevated === true,
    },
    tools: params.tools,
    modelAliasLines: buildModelAliasLines(params.attempt.config),
    userTimezone,
    userTime,
    userTimeFormat,
    contextFiles: [],
    bootstrapTruncationWarningLines: [],
    memoryCitationsMode: params.attempt.config?.memory?.citations,
  });

  const systemPromptReport = buildSystemPromptReport({
    source: "run",
    generatedAt: Date.now(),
    sessionId: params.attempt.sessionId,
    sessionKey: params.attempt.sessionKey,
    provider: params.attempt.provider,
    model: params.attempt.modelId,
    workspaceDir: params.effectiveWorkspace,
    bootstrapMaxChars: 0,
    bootstrapTotalMaxChars: 0,
    bootstrapTruncation: undefined,
    sandbox: (() => {
      const runtime = resolveBrowserSandboxRuntimeStatus({
        cfg: params.attempt.config,
        sessionKey: params.sandboxSessionKey,
      });
      return { mode: runtime.mode, sandboxed: runtime.sandboxed };
    })(),
    systemPrompt: appendPrompt,
    bootstrapFiles: [],
    injectedFiles: [],
    skillsPrompt: params.skillsPrompt,
    tools: params.tools,
  });

  return {
    systemPromptText: createSystemPromptOverride(appendPrompt)(),
    systemPromptReport,
  };
}
