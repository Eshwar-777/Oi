import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { computeBackoff, sleepWithAbort, type BackoffPolicy } from "./browser-backoff.js";
import { isBrowserMarkdownCapableMessageChannel } from "../browser-message-channel.js";
import { resolveBrowserRuntimeAgentDir } from "../browser-agent-dir.js";
import { hasConfiguredBrowserModelFallbacks } from "../browser-model-fallbacks.js";
import {
  isProfileInCooldown,
  markAuthProfileFailure,
  markAuthProfileUsed,
  resolveProfilesUnavailableReason,
} from "../auth-profiles/usage.js";
import { markAuthProfileGood } from "../auth-profiles/profiles.js";
import type { AuthProfileFailureReason } from "../auth-profiles/types.js";
import {
  CONTEXT_WINDOW_HARD_MIN_TOKENS,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS,
  evaluateContextWindowGuard,
  resolveContextWindowInfo,
} from "../context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import {
  ensureAuthProfileStore,
  getApiKeyForModel,
  resolveAuthProfileOrder,
  type ResolvedProviderAuth,
} from "../model-auth.js";
import { normalizeProviderId } from "../model-selection.js";
import { ensureRuntimeBrowserModelsJson } from "../browser-models-config.js";
import {
  BILLING_ERROR_USER_MESSAGE,
  formatBillingErrorMessage,
  classifyFailoverReason,
  formatAssistantErrorText,
  formatRawAssistantErrorForUi,
  getApiErrorPayloadFingerprint,
  isAuthAssistantError,
  isBillingAssistantError,
  isLikelyContextOverflowError,
  isFailoverAssistantError,
  isFailoverErrorMessage,
  isRawApiErrorPayload,
  normalizeTextForComparison,
  parseImageSizeError,
  parseImageDimensionError,
  isRateLimitAssistantError,
  isTimeoutErrorMessage,
  pickFallbackThinkingLevel,
} from "../pi-embedded-helpers.js";
import {
  extractAssistantText,
  extractAssistantThinking,
  formatReasoningMessage,
} from "../pi-embedded-utils.js";
import { isLikelyMutatingToolName } from "../tool-mutation.js";
import { derivePromptTokens, normalizeUsage, type UsageLike } from "../usage.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import {
  BROWSER_SILENT_REPLY_TOKEN,
  formatBrowserToolAggregate,
  isBrowserSilentReplyText,
  parseBrowserReplyDirectives,
} from "./browser-reply.js";
import { enqueueBrowserCommandInLane } from "./browser-command-queue.js";
import type { ReasoningLevel, ThinkLevel, VerboseLevel } from "./browser-thinking-types.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { resolveModel } from "./model.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";
import type { EmbeddedPiAgentMeta, EmbeddedPiRunResult } from "./types.js";
import { describeUnknownError } from "./utils.js";

type ApiKeyInfo = ResolvedProviderAuth;

type UsageAccumulator = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  lastCacheRead: number;
  lastCacheWrite: number;
  lastInput: number;
};

const OVERLOAD_FAILOVER_BACKOFF_POLICY: BackoffPolicy = {
  initialMs: 250,
  maxMs: 1_500,
  factor: 2,
  jitter: 0.2,
};

const BASE_RUN_RETRY_ITERATIONS = 24;
const RUN_RETRY_ITERATIONS_PER_PROFILE = 8;
const MIN_RUN_RETRY_ITERATIONS = 32;
const MAX_RUN_RETRY_ITERATIONS = 160;
const RECOVERABLE_TOOL_ERROR_KEYWORDS = [
  "required",
  "missing",
  "invalid",
  "must be",
  "must have",
  "needs",
  "requires",
] as const;

type ToolMetaEntry = { toolName: string; meta?: string };
type ToolResultFormat = "markdown" | "plain";
type LastToolError = {
  toolName: string;
  meta?: string;
  error?: string;
  mutatingAction?: boolean;
  actionFingerprint?: string;
};
type ToolErrorWarningPolicy = {
  showWarning: boolean;
  includeDetails: boolean;
};

function isRecoverableToolError(error: string | undefined): boolean {
  const errorLower = (error ?? "").toLowerCase();
  return RECOVERABLE_TOOL_ERROR_KEYWORDS.some((keyword) => errorLower.includes(keyword));
}

function isVerboseToolDetailEnabled(level?: VerboseLevel): boolean {
  return level === "on" || level === "full";
}

function resolveToolErrorWarningPolicy(params: {
  lastToolError: LastToolError;
  hasUserFacingReply: boolean;
  suppressToolErrors: boolean;
  suppressToolErrorWarnings?: boolean;
  verboseLevel?: VerboseLevel;
}): ToolErrorWarningPolicy {
  const includeDetails = isVerboseToolDetailEnabled(params.verboseLevel);
  if (params.suppressToolErrorWarnings) {
    return { showWarning: false, includeDetails };
  }
  const normalizedToolName = params.lastToolError.toolName.trim().toLowerCase();
  if ((normalizedToolName === "exec" || normalizedToolName === "bash") && !includeDetails) {
    return { showWarning: false, includeDetails };
  }
  if (normalizedToolName === "sessions_send") {
    return { showWarning: false, includeDetails };
  }
  const isMutatingToolError =
    params.lastToolError.mutatingAction ?? isLikelyMutatingToolName(params.lastToolError.toolName);
  if (isMutatingToolError) {
    return { showWarning: true, includeDetails };
  }
  if (params.suppressToolErrors) {
    return { showWarning: false, includeDetails };
  }
  return {
    showWarning: !params.hasUserFacingReply && !isRecoverableToolError(params.lastToolError.error),
    includeDetails,
  };
}

function buildBrowserRunPayloads(params: {
  assistantTexts: string[];
  toolMetas: ToolMetaEntry[];
  lastAssistant: AssistantMessage | undefined;
  lastToolError?: LastToolError;
  config?: RunEmbeddedPiAgentParams["config"];
  sessionKey: string;
  provider?: string;
  model?: string;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  toolResultFormat?: ToolResultFormat;
  suppressToolErrorWarnings?: boolean;
  inlineToolResultsAllowed: boolean;
  didSendViaMessagingTool?: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
}): Array<{
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  isError?: boolean;
  isReasoning?: boolean;
  audioAsVoice?: boolean;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
}> {
  const replyItems: Array<{
    text: string;
    media?: string[];
    isError?: boolean;
    isReasoning?: boolean;
    audioAsVoice?: boolean;
    replyToId?: string;
    replyToTag?: boolean;
    replyToCurrent?: boolean;
  }> = [];

  const useMarkdown = params.toolResultFormat === "markdown";
  const suppressAssistantArtifacts = params.didSendDeterministicApprovalPrompt === true;
  const lastAssistantErrored = params.lastAssistant?.stopReason === "error";
  const errorText = params.lastAssistant
    ? suppressAssistantArtifacts
      ? undefined
      : formatAssistantErrorText(params.lastAssistant, {
          cfg: params.config,
          sessionKey: params.sessionKey,
          provider: params.provider,
          model: params.model,
        })
    : undefined;
  const rawErrorMessage = lastAssistantErrored
    ? params.lastAssistant?.errorMessage?.trim() || undefined
    : undefined;
  const rawErrorFingerprint = rawErrorMessage
    ? getApiErrorPayloadFingerprint(rawErrorMessage)
    : null;
  const formattedRawErrorMessage = rawErrorMessage
    ? formatRawAssistantErrorForUi(rawErrorMessage)
    : null;
  const normalizedFormattedRawErrorMessage = formattedRawErrorMessage
    ? normalizeTextForComparison(formattedRawErrorMessage)
    : null;
  const normalizedRawErrorText = rawErrorMessage
    ? normalizeTextForComparison(rawErrorMessage)
    : null;
  const normalizedErrorText = errorText ? normalizeTextForComparison(errorText) : null;
  const normalizedGenericBillingErrorText = normalizeTextForComparison(BILLING_ERROR_USER_MESSAGE);
  const genericErrorText = "The AI service returned an error. Please try again.";
  if (errorText) {
    replyItems.push({ text: errorText, isError: true });
  }

  const inlineToolResults =
    params.inlineToolResultsAllowed && params.verboseLevel !== "off" && params.toolMetas.length > 0;
  if (inlineToolResults) {
    for (const { toolName, meta } of params.toolMetas) {
      const agg = formatBrowserToolAggregate(toolName, meta ? [meta] : [], {
        markdown: useMarkdown,
      });
      const {
        text: cleanedText,
        mediaUrls,
        audioAsVoice,
        replyToId,
        replyToTag,
        replyToCurrent,
      } = parseBrowserReplyDirectives(agg);
      if (cleanedText) {
        replyItems.push({
          text: cleanedText,
          media: mediaUrls,
          audioAsVoice,
          replyToId,
          replyToTag,
          replyToCurrent,
        });
      }
    }
  }

  const reasoningText = suppressAssistantArtifacts
    ? ""
    : params.lastAssistant && params.reasoningLevel === "on"
      ? formatReasoningMessage(extractAssistantThinking(params.lastAssistant))
      : "";
  if (reasoningText) {
    replyItems.push({ text: reasoningText, isReasoning: true });
  }

  const fallbackAnswerText = params.lastAssistant ? extractAssistantText(params.lastAssistant) : "";
  const shouldSuppressRawErrorText = (text: string) => {
    if (!lastAssistantErrored) {
      return false;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }
    if (errorText) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalizedErrorText && normalized === normalizedErrorText) {
        return true;
      }
      if (trimmed === genericErrorText) {
        return true;
      }
      if (
        normalized &&
        normalizedGenericBillingErrorText &&
        normalized === normalizedGenericBillingErrorText
      ) {
        return true;
      }
    }
    if (rawErrorMessage && trimmed === rawErrorMessage) {
      return true;
    }
    if (formattedRawErrorMessage && trimmed === formattedRawErrorMessage) {
      return true;
    }
    if (normalizedRawErrorText) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalized === normalizedRawErrorText) {
        return true;
      }
    }
    if (normalizedFormattedRawErrorMessage) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalized === normalizedFormattedRawErrorMessage) {
        return true;
      }
    }
    if (rawErrorFingerprint) {
      const fingerprint = getApiErrorPayloadFingerprint(trimmed);
      if (fingerprint && fingerprint === rawErrorFingerprint) {
        return true;
      }
    }
    return isRawApiErrorPayload(trimmed);
  };
  const answerTexts = suppressAssistantArtifacts
    ? []
    : (params.assistantTexts.length
        ? params.assistantTexts
        : fallbackAnswerText
          ? [fallbackAnswerText]
          : []
      ).filter((text) => !shouldSuppressRawErrorText(text));

  let hasUserFacingAssistantReply = false;
  for (const text of answerTexts) {
    const {
      text: cleanedText,
      mediaUrls,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    } = parseBrowserReplyDirectives(text);
    if (!cleanedText && (!mediaUrls || mediaUrls.length === 0) && !audioAsVoice) {
      continue;
    }
    replyItems.push({
      text: cleanedText,
      media: mediaUrls,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    });
    hasUserFacingAssistantReply = true;
  }

  if (params.lastToolError) {
    const warningPolicy = resolveToolErrorWarningPolicy({
      lastToolError: params.lastToolError,
      hasUserFacingReply: hasUserFacingAssistantReply,
      suppressToolErrors: Boolean(params.config?.messages?.suppressToolErrors),
      suppressToolErrorWarnings: params.suppressToolErrorWarnings,
      verboseLevel: params.verboseLevel,
    });
    if (warningPolicy.showWarning) {
      const toolSummary = formatBrowserToolAggregate(
        params.lastToolError.toolName,
        params.lastToolError.meta ? [params.lastToolError.meta] : undefined,
        { markdown: useMarkdown },
      );
      const errorSuffix =
        warningPolicy.includeDetails && params.lastToolError.error
          ? `: ${params.lastToolError.error}`
          : "";
      const warningText = `⚠️ ${toolSummary} failed${errorSuffix}`;
      const normalizedWarning = normalizeTextForComparison(warningText);
      const duplicateWarning = normalizedWarning
        ? replyItems.some((item) => {
            if (!item.text) {
              return false;
            }
            const normalizedExisting = normalizeTextForComparison(item.text);
            return normalizedExisting.length > 0 && normalizedExisting === normalizedWarning;
          })
        : false;
      if (!duplicateWarning) {
        replyItems.push({
          text: warningText,
          isError: true,
        });
      }
    }
  }

  const hasAudioAsVoiceTag = replyItems.some((item) => item.audioAsVoice);
  return replyItems
    .map((item) => ({
      text: item.text?.trim() ? item.text.trim() : undefined,
      mediaUrls: item.media?.length ? item.media : undefined,
      mediaUrl: item.media?.[0],
      isError: item.isError,
      replyToId: item.replyToId,
      replyToTag: item.replyToTag,
      replyToCurrent: item.replyToCurrent,
      audioAsVoice: item.audioAsVoice || Boolean(hasAudioAsVoiceTag && item.media?.length),
    }))
    .filter((p) => {
      if (!p.text && !p.mediaUrl && (!p.mediaUrls || p.mediaUrls.length === 0)) {
        return false;
      }
      if (p.text && isBrowserSilentReplyText(p.text, BROWSER_SILENT_REPLY_TOKEN)) {
        return false;
      }
      return true;
    });
}

const createUsageAccumulator = (): UsageAccumulator => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  lastCacheRead: 0,
  lastCacheWrite: 0,
  lastInput: 0,
});

function resolveMaxRunRetryIterations(profileCandidateCount: number): number {
  const scaled =
    BASE_RUN_RETRY_ITERATIONS +
    Math.max(1, profileCandidateCount) * RUN_RETRY_ITERATIONS_PER_PROFILE;
  return Math.min(MAX_RUN_RETRY_ITERATIONS, Math.max(MIN_RUN_RETRY_ITERATIONS, scaled));
}

const hasUsageValues = (
  usage: ReturnType<typeof normalizeUsage>,
): usage is NonNullable<ReturnType<typeof normalizeUsage>> =>
  !!usage &&
  [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.total].some(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );

const mergeUsageIntoAccumulator = (
  target: UsageAccumulator,
  usage: ReturnType<typeof normalizeUsage>,
) => {
  if (!hasUsageValues(usage)) {
    return;
  }
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  target.total +=
    usage.total ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  target.lastCacheRead = usage.cacheRead ?? 0;
  target.lastCacheWrite = usage.cacheWrite ?? 0;
  target.lastInput = usage.input ?? 0;
};

const toNormalizedUsage = (usage: UsageAccumulator) => {
  const hasUsage =
    usage.input > 0 ||
    usage.output > 0 ||
    usage.cacheRead > 0 ||
    usage.cacheWrite > 0 ||
    usage.total > 0;
  if (!hasUsage) {
    return undefined;
  }
  const lastPromptTokens = usage.lastInput + usage.lastCacheRead + usage.lastCacheWrite;
  return {
    input: usage.lastInput || undefined,
    output: usage.output || undefined,
    cacheRead: usage.lastCacheRead || undefined,
    cacheWrite: usage.lastCacheWrite || undefined,
    total: lastPromptTokens + usage.output || undefined,
  };
};

function resolveActiveErrorContext(params: {
  lastAssistant: { provider?: string; model?: string } | undefined;
  provider: string;
  model: string;
}): { provider: string; model: string } {
  return {
    provider: params.lastAssistant?.provider ?? params.provider,
    model: params.lastAssistant?.model ?? params.model,
  };
}

function buildErrorAgentMeta(params: {
  sessionId: string;
  provider: string;
  model: string;
  usageAccumulator: UsageAccumulator;
  lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
  lastAssistant?: { usage?: unknown } | null;
  lastTurnTotal?: number;
}): EmbeddedPiAgentMeta {
  const usage = toNormalizedUsage(params.usageAccumulator);
  if (usage && params.lastTurnTotal && params.lastTurnTotal > 0) {
    usage.total = params.lastTurnTotal;
  }
  const lastCallUsage = params.lastAssistant
    ? normalizeUsage(params.lastAssistant.usage as UsageLike)
    : undefined;
  const promptTokens = derivePromptTokens(params.lastRunPromptUsage);
  return {
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.model,
    ...(usage ? { usage } : {}),
    ...(lastCallUsage ? { lastCallUsage } : {}),
    ...(promptTokens ? { promptTokens } : {}),
  };
}

function logBrowserFailoverDecision(params: {
  stage: "prompt" | "assistant";
  decision: "rotate_profile" | "fallback_model" | "surface_error";
  runId?: string;
  provider: string;
  model: string;
  reason?: string | null;
}) {
  log.warn(
    `browser run failover decision: runId=${params.runId ?? "-"} stage=${params.stage} ` +
      `decision=${params.decision} reason=${params.reason ?? "none"} ` +
      `provider=${params.provider}/${params.model}`,
  );
}

export async function runEmbeddedBrowserPiAgent(
  params: RunEmbeddedPiAgentParams & { browserOnlyTools?: boolean },
): Promise<EmbeddedPiRunResult> {
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const enqueueGlobal =
    params.enqueue ?? ((task, opts) => enqueueBrowserCommandInLane(globalLane, task, opts));
  const enqueueSession =
    params.enqueue ?? ((task, opts) => enqueueBrowserCommandInLane(sessionLane, task, opts));
  const channelHint = params.messageChannel ?? params.messageProvider;
  const resolvedToolResultFormat =
    params.toolResultFormat ??
    (channelHint
      ? isBrowserMarkdownCapableMessageChannel(channelHint)
        ? "markdown"
        : "plain"
      : "markdown");
  const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;

  return enqueueSession(() =>
    enqueueGlobal(async () => {
      const started = Date.now();
      const workspaceResolution = resolveRunWorkspaceDir({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        config: params.config,
      });
      const resolvedWorkspace = workspaceResolution.workspaceDir;
      const redactedSessionId = redactRunIdentifier(params.sessionId);
      const redactedSessionKey = redactRunIdentifier(params.sessionKey);
      const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
      if (workspaceResolution.usedFallback) {
        log.warn(
          `[workspace-fallback] caller=runEmbeddedBrowserPiAgent reason=${workspaceResolution.fallbackReason} ` +
            `run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} ` +
            `agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
        );
      }

      const prevCwd = process.cwd();
      let provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      let modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      const agentDir = params.agentDir ?? resolveBrowserRuntimeAgentDir();
      const fallbackConfigured = hasConfiguredBrowserModelFallbacks({
        cfg: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      });
      await ensureRuntimeBrowserModelsJson(params.config, agentDir);

      const { model, error, authStorage, modelRegistry } = resolveModel(
        provider,
        modelId,
        agentDir,
        params.config,
      );
      if (!model) {
        throw new FailoverError(error ?? `Unknown model: ${provider}/${modelId}`, {
          reason: "model_not_found",
          provider,
          model: modelId,
        });
      }

      const ctxInfo = resolveContextWindowInfo({
        cfg: params.config,
        provider,
        modelId,
        modelContextWindow: model.contextWindow,
        defaultTokens: DEFAULT_CONTEXT_TOKENS,
      });
      const effectiveModel =
        ctxInfo.tokens < (model.contextWindow ?? Infinity)
          ? { ...model, contextWindow: ctxInfo.tokens }
          : model;
      const ctxGuard = evaluateContextWindowGuard({
        info: ctxInfo,
        warnBelowTokens: CONTEXT_WINDOW_WARN_BELOW_TOKENS,
        hardMinTokens: CONTEXT_WINDOW_HARD_MIN_TOKENS,
      });
      if (ctxGuard.shouldWarn) {
        log.warn(
          `low context window: ${provider}/${modelId} ctx=${ctxGuard.tokens} ` +
            `(warn<${CONTEXT_WINDOW_WARN_BELOW_TOKENS}) source=${ctxGuard.source}`,
        );
      }
      if (ctxGuard.shouldBlock) {
        throw new FailoverError(
          `Model context window too small (${ctxGuard.tokens} tokens). Minimum is ${CONTEXT_WINDOW_HARD_MIN_TOKENS}.`,
          { reason: "unknown", provider, model: modelId },
        );
      }

      const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
      const preferredProfileId = params.authProfileId?.trim();
      let lockedProfileId = params.authProfileIdSource === "user" ? preferredProfileId : undefined;
      if (lockedProfileId) {
        const lockedProfile = authStore.profiles[lockedProfileId];
        if (
          !lockedProfile ||
          normalizeProviderId(lockedProfile.provider) !== normalizeProviderId(provider)
        ) {
          lockedProfileId = undefined;
        }
      }
      const profileOrder = resolveAuthProfileOrder({
        cfg: params.config,
        store: authStore,
        provider,
        preferredProfile: preferredProfileId,
      });
      if (lockedProfileId && !profileOrder.includes(lockedProfileId)) {
        throw new Error(`Auth profile "${lockedProfileId}" is not configured for ${provider}.`);
      }
      const profileCandidates = lockedProfileId
        ? [lockedProfileId]
        : profileOrder.length > 0
          ? profileOrder
          : [undefined];
      let profileIndex = 0;
      const initialThinkLevel = params.thinkLevel ?? "off";
      let thinkLevel = initialThinkLevel;
      const attemptedThinking = new Set<ThinkLevel>();
      let apiKeyInfo: ApiKeyInfo | null = null;
      let lastProfileId: string | undefined;

      const resolveAuthProfileFailoverReason = (options: {
        allInCooldown: boolean;
        message: string;
        profileIds?: Array<string | undefined>;
      }) => {
        if (options.allInCooldown) {
          const profileIds = (options.profileIds ?? profileCandidates).filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          );
          return (
            resolveProfilesUnavailableReason({
              store: authStore,
              profileIds,
            }) ?? "rate_limit"
          );
        }
        return classifyFailoverReason(options.message) ?? "auth";
      };

      const throwAuthProfileFailover = (options: {
        allInCooldown: boolean;
        message?: string;
        error?: unknown;
      }): never => {
        const fallbackMessage = `No available auth profile for ${provider} (all in cooldown or unavailable).`;
        const message =
          options.message?.trim() ||
          (options.error ? describeUnknownError(options.error).trim() : "") ||
          fallbackMessage;
        const reason = resolveAuthProfileFailoverReason({
          allInCooldown: options.allInCooldown,
          message,
          profileIds: profileCandidates,
        });
        if (fallbackConfigured) {
          throw new FailoverError(message, {
            reason,
            provider,
            model: modelId,
            status: resolveFailoverStatus(reason),
            cause: options.error,
          });
        }
        if (options.error instanceof Error) {
          throw options.error;
        }
        throw new Error(message);
      };

      const resolveApiKeyForCandidate = async (candidate?: string) =>
        getApiKeyForModel({
          model,
          cfg: params.config,
          profileId: candidate,
          store: authStore,
          agentDir,
        });

      const applyApiKeyInfo = async (candidate?: string): Promise<void> => {
        apiKeyInfo = await resolveApiKeyForCandidate(candidate);
        const resolvedProfileId = apiKeyInfo.profileId ?? candidate;
        if (!apiKeyInfo.apiKey) {
          lastProfileId = resolvedProfileId;
          return;
        }
        authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
        lastProfileId = apiKeyInfo.profileId;
      };

      const advanceAuthProfile = async (): Promise<boolean> => {
        if (lockedProfileId) {
          return false;
        }
        let nextIndex = profileIndex + 1;
        while (nextIndex < profileCandidates.length) {
          const candidate = profileCandidates[nextIndex];
          if (candidate && isProfileInCooldown(authStore, candidate)) {
            nextIndex += 1;
            continue;
          }
          try {
            await applyApiKeyInfo(candidate);
            profileIndex = nextIndex;
            thinkLevel = initialThinkLevel;
            attemptedThinking.clear();
            return true;
          } catch {
            nextIndex += 1;
          }
        }
        return false;
      };

      try {
        while (profileIndex < profileCandidates.length) {
          const candidate = profileCandidates[profileIndex];
          if (candidate && candidate !== lockedProfileId && isProfileInCooldown(authStore, candidate)) {
            profileIndex += 1;
            continue;
          }
          await applyApiKeyInfo(profileCandidates[profileIndex]);
          break;
        }
        if (profileIndex >= profileCandidates.length) {
          throwAuthProfileFailover({ allInCooldown: true });
        }
      } catch (err) {
        if (err instanceof FailoverError) {
          throw err;
        }
        if (profileCandidates[profileIndex] === lockedProfileId) {
          throwAuthProfileFailover({ allInCooldown: false, error: err });
        }
        const advanced = await advanceAuthProfile();
        if (!advanced) {
          throwAuthProfileFailover({ allInCooldown: false, error: err });
        }
      }

      const maybeBackoffBeforeOverloadFailover = async (reason: string | null) => {
        if (reason !== "overloaded") {
          return;
        }
        const delayMs = computeBackoff(OVERLOAD_FAILOVER_BACKOFF_POLICY, 1);
        try {
          await sleepWithAbort(delayMs, params.abortSignal);
        } catch (err) {
          if (params.abortSignal?.aborted) {
            const abortErr = new Error("Operation aborted", { cause: err });
            abortErr.name = "AbortError";
            throw abortErr;
          }
          throw err;
        }
      };

      const maybeMarkAuthProfileFailure = async (failure: {
        profileId?: string;
        reason?: AuthProfileFailureReason | null;
      }) => {
        const { profileId, reason } = failure;
        if (!profileId || !reason || reason === "timeout") {
          return;
        }
        await markAuthProfileFailure({
          store: authStore,
          profileId,
          reason,
          cfg: params.config,
          agentDir,
          runId: params.runId,
        });
      };

      const resolveAuthProfileFailureReason = (reason: string | null): AuthProfileFailureReason | null =>
        !reason || reason === "timeout" ? null : (reason as AuthProfileFailureReason);

      const { runEmbeddedBrowserAttempt } = await import("./run/browser-attempt.js");

      try {
        let lastTurnTotal: number | undefined;
        const MAX_RUN_LOOP_ITERATIONS = resolveMaxRunRetryIterations(profileCandidates.length);
        const usageAccumulator = createUsageAccumulator();
        let lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
        let runLoopIterations = 0;

        while (true) {
          if (runLoopIterations >= MAX_RUN_LOOP_ITERATIONS) {
            return {
              payloads: [
                {
                  text:
                    "Request failed after repeated internal retries. Please try again, or use /new to start a fresh session.",
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta: buildErrorAgentMeta({
                  sessionId: params.sessionId,
                  provider,
                  model: model.id,
                  usageAccumulator,
                  lastRunPromptUsage,
                  lastTurnTotal,
                }),
                error: { kind: "retry_limit", message: "Exceeded retry limit." },
              },
            };
          }

          runLoopIterations += 1;
          attemptedThinking.add(thinkLevel);
          await fs.mkdir(resolvedWorkspace, { recursive: true });
          const prompt = params.prompt;

          const attempt = await runEmbeddedBrowserAttempt({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            trigger: params.trigger,
            memoryFlushWritePath: params.memoryFlushWritePath,
            messageChannel: params.messageChannel,
            messageProvider: params.messageProvider,
            agentAccountId: params.agentAccountId,
            messageTo: params.messageTo,
            messageThreadId: params.messageThreadId,
            groupId: params.groupId,
            groupChannel: params.groupChannel,
            groupSpace: params.groupSpace,
            spawnedBy: params.spawnedBy,
            senderId: params.senderId,
            senderName: params.senderName,
            senderUsername: params.senderUsername,
            senderE164: params.senderE164,
            senderIsOwner: params.senderIsOwner,
            currentChannelId: params.currentChannelId,
            currentThreadTs: params.currentThreadTs,
            currentMessageId: params.currentMessageId,
            replyToMode: params.replyToMode,
            hasRepliedRef: params.hasRepliedRef,
            sessionFile: params.sessionFile,
            workspaceDir: resolvedWorkspace,
            agentDir,
            config: params.config,
            contextEngine: undefined,
            contextTokenBudget: ctxInfo.tokens,
            skillsSnapshot: params.skillsSnapshot,
            prompt,
            images: params.images,
            disableTools: params.disableTools,
            provider,
            modelId,
            model: effectiveModel,
            authProfileId: lastProfileId,
            authProfileIdSource: lockedProfileId ? "user" : "auto",
            authStorage,
            modelRegistry,
            agentId: workspaceResolution.agentId,
            legacyBeforeAgentStartResult: undefined,
            thinkLevel,
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            toolResultFormat: resolvedToolResultFormat,
            execOverrides: params.execOverrides,
            bashElevated: params.bashElevated,
            timeoutMs: params.timeoutMs,
            runId: params.runId,
            abortSignal: params.abortSignal,
            shouldEmitToolResult: params.shouldEmitToolResult,
            shouldEmitToolOutput: params.shouldEmitToolOutput,
            onPartialReply: params.onPartialReply,
            onAssistantMessageStart: params.onAssistantMessageStart,
            onBlockReply: params.onBlockReply,
            onBlockReplyFlush: params.onBlockReplyFlush,
            blockReplyBreak: params.blockReplyBreak,
            blockReplyChunking: params.blockReplyChunking,
            onReasoningStream: params.onReasoningStream,
            onReasoningEnd: params.onReasoningEnd,
            onToolResult: params.onToolResult,
            onAgentEvent: params.onAgentEvent,
            extraSystemPrompt: params.extraSystemPrompt,
            inputProvenance: params.inputProvenance,
            streamParams: params.streamParams,
            ownerNumbers: params.ownerNumbers,
            enforceFinalTag: params.enforceFinalTag,
            browserOnlyTools: true,
          } as Parameters<typeof runEmbeddedBrowserAttempt>[0]);

          const { aborted, promptError, timedOut, timedOutDuringCompaction, sessionIdUsed, lastAssistant } =
            attempt;
          const lastAssistantUsage = normalizeUsage(lastAssistant?.usage as UsageLike);
          const attemptUsage = attempt.attemptUsage ?? lastAssistantUsage;
          mergeUsageIntoAccumulator(usageAccumulator, attemptUsage);
          lastRunPromptUsage = lastAssistantUsage ?? attemptUsage;
          lastTurnTotal = lastAssistantUsage?.total ?? attemptUsage?.total;

          const activeErrorContext = resolveActiveErrorContext({
            lastAssistant,
            provider,
            model: modelId,
          });
          const formattedAssistantErrorText = lastAssistant
            ? formatAssistantErrorText(lastAssistant, {
                cfg: params.config,
                sessionKey: params.sessionKey ?? params.sessionId,
                provider: activeErrorContext.provider,
                model: activeErrorContext.model,
              })
            : undefined;
          const assistantErrorText =
            lastAssistant?.stopReason === "error"
              ? lastAssistant.errorMessage?.trim() || formattedAssistantErrorText
              : undefined;

          const contextOverflowError = !aborted
            ? (() => {
                if (promptError) {
                  const errorText = describeUnknownError(promptError);
                  if (isLikelyContextOverflowError(errorText)) {
                    return errorText;
                  }
                  return null;
                }
                if (assistantErrorText && isLikelyContextOverflowError(assistantErrorText)) {
                  return assistantErrorText;
                }
                return null;
              })()
            : null;

          if (contextOverflowError) {
            return {
              payloads: [
                {
                  text:
                    "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.",
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta: buildErrorAgentMeta({
                  sessionId: sessionIdUsed,
                  provider,
                  model: model.id,
                  usageAccumulator,
                  lastRunPromptUsage,
                  lastAssistant,
                  lastTurnTotal,
                }),
                systemPromptReport: attempt.systemPromptReport,
                error: { kind: "context_overflow", message: contextOverflowError },
              },
            };
          }

          if (promptError && !aborted) {
            const errorText = describeUnknownError(promptError);
            if (/incorrect role information|roles must alternate/i.test(errorText)) {
              return {
                payloads: [
                  {
                    text:
                      "Message ordering conflict - please try again. If this persists, use /new to start a fresh session.",
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta: buildErrorAgentMeta({
                    sessionId: sessionIdUsed,
                    provider,
                    model: model.id,
                    usageAccumulator,
                    lastRunPromptUsage,
                    lastAssistant,
                    lastTurnTotal,
                  }),
                  systemPromptReport: attempt.systemPromptReport,
                  error: { kind: "role_ordering", message: errorText },
                },
              };
            }
            const imageSizeError = parseImageSizeError(errorText);
            if (imageSizeError) {
              const maxMb = imageSizeError.maxMb;
              const maxMbLabel =
                typeof maxMb === "number" && Number.isFinite(maxMb) ? `${maxMb}` : null;
              const maxBytesHint = maxMbLabel ? ` (max ${maxMbLabel}MB)` : "";
              return {
                payloads: [
                  {
                    text:
                      `Image too large for the model${maxBytesHint}. ` +
                      "Please compress or resize the image and try again.",
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta: buildErrorAgentMeta({
                    sessionId: sessionIdUsed,
                    provider,
                    model: model.id,
                    usageAccumulator,
                    lastRunPromptUsage,
                    lastAssistant,
                    lastTurnTotal,
                  }),
                  systemPromptReport: attempt.systemPromptReport,
                  error: { kind: "image_size", message: errorText },
                },
              };
            }
            const promptFailoverReason = classifyFailoverReason(errorText);
            const promptProfileFailureReason =
              resolveAuthProfileFailureReason(promptFailoverReason);
            await maybeMarkAuthProfileFailure({
              profileId: lastProfileId,
              reason: promptProfileFailureReason,
            });
            const promptFailoverFailure = isFailoverErrorMessage(errorText);
            if (
              promptFailoverFailure &&
              promptFailoverReason !== "timeout" &&
              (await advanceAuthProfile())
            ) {
              logBrowserFailoverDecision({
                stage: "prompt",
                decision: "rotate_profile",
                runId: params.runId,
                provider,
                model: modelId,
                reason: promptFailoverReason,
              });
              await maybeBackoffBeforeOverloadFailover(promptFailoverReason);
              continue;
            }
            const fallbackThinking = pickFallbackThinkingLevel({
              message: errorText,
              attempted: attemptedThinking,
            });
            if (fallbackThinking) {
              thinkLevel = fallbackThinking;
              continue;
            }
            if (fallbackConfigured && promptFailoverFailure) {
              const status = resolveFailoverStatus(promptFailoverReason ?? "unknown");
              logBrowserFailoverDecision({
                stage: "prompt",
                decision: "fallback_model",
                runId: params.runId,
                provider,
                model: modelId,
                reason: promptFailoverReason,
              });
              await maybeBackoffBeforeOverloadFailover(promptFailoverReason);
              throw new FailoverError(errorText, {
                reason: promptFailoverReason ?? "unknown",
                provider,
                model: modelId,
                profileId: lastProfileId,
                status,
              });
            }
            if (promptFailoverFailure || promptFailoverReason) {
              logBrowserFailoverDecision({
                stage: "prompt",
                decision: "surface_error",
                runId: params.runId,
                provider,
                model: modelId,
                reason: promptFailoverReason,
              });
            }
            throw promptError;
          }

          const fallbackThinking = pickFallbackThinkingLevel({
            message: lastAssistant?.errorMessage,
            attempted: attemptedThinking,
          });
          if (fallbackThinking && !aborted) {
            thinkLevel = fallbackThinking;
            continue;
          }

          const authFailure = isAuthAssistantError(lastAssistant);
          const rateLimitFailure = isRateLimitAssistantError(lastAssistant);
          const billingFailure = isBillingAssistantError(lastAssistant);
          const failoverFailure = isFailoverAssistantError(lastAssistant);
          const assistantFailoverReason = classifyFailoverReason(lastAssistant?.errorMessage ?? "");
          const assistantProfileFailureReason =
            resolveAuthProfileFailureReason(assistantFailoverReason);
          const imageDimensionError = parseImageDimensionError(lastAssistant?.errorMessage ?? "");

          if (imageDimensionError && lastProfileId) {
            const details = [
              imageDimensionError.messageIndex !== undefined
                ? `message=${imageDimensionError.messageIndex}`
                : null,
              imageDimensionError.contentIndex !== undefined
                ? `content=${imageDimensionError.contentIndex}`
                : null,
              imageDimensionError.maxDimensionPx !== undefined
                ? `limit=${imageDimensionError.maxDimensionPx}px`
                : null,
            ]
              .filter(Boolean)
              .join(" ");
            log.warn(
              `Profile ${lastProfileId} rejected image payload${details ? ` (${details})` : ""}.`,
            );
          }

          const shouldRotate =
            (!aborted && failoverFailure) || (timedOut && !timedOutDuringCompaction);
          if (shouldRotate) {
            if (lastProfileId) {
              const reason = timedOut ? "timeout" : assistantProfileFailureReason;
              await maybeMarkAuthProfileFailure({
                profileId: lastProfileId,
                reason,
              });
              if (timedOut && !isProbeSession) {
                log.warn(`Profile ${lastProfileId} timed out. Trying next account...`);
              }
            }

            const rotated = await advanceAuthProfile();
            if (rotated) {
              logBrowserFailoverDecision({
                stage: "assistant",
                decision: "rotate_profile",
                runId: params.runId,
                provider: activeErrorContext.provider,
                model: activeErrorContext.model,
                reason: assistantFailoverReason,
              });
              await maybeBackoffBeforeOverloadFailover(assistantFailoverReason);
              continue;
            }

            if (fallbackConfigured) {
              await maybeBackoffBeforeOverloadFailover(assistantFailoverReason);
              const message =
                (lastAssistant
                  ? formatAssistantErrorText(lastAssistant, {
                      cfg: params.config,
                      sessionKey: params.sessionKey ?? params.sessionId,
                      provider: activeErrorContext.provider,
                      model: activeErrorContext.model,
                    })
                  : undefined) ||
                lastAssistant?.errorMessage?.trim() ||
                (timedOut
                  ? "LLM request timed out."
                  : rateLimitFailure
                    ? "LLM request rate limited."
                    : billingFailure
                      ? formatBillingErrorMessage(
                          activeErrorContext.provider,
                          activeErrorContext.model,
                        )
                      : authFailure
                        ? "LLM request unauthorized."
                        : "LLM request failed.");
              const status =
                resolveFailoverStatus(assistantFailoverReason ?? "unknown") ??
                (isTimeoutErrorMessage(message) ? 408 : undefined);
              logBrowserFailoverDecision({
                stage: "assistant",
                decision: "fallback_model",
                runId: params.runId,
                provider: activeErrorContext.provider,
                model: activeErrorContext.model,
                reason: assistantFailoverReason,
              });
              throw new FailoverError(message, {
                reason: assistantFailoverReason ?? "unknown",
                provider: activeErrorContext.provider,
                model: activeErrorContext.model,
                profileId: lastProfileId,
                status,
              });
            }
            logBrowserFailoverDecision({
              stage: "assistant",
              decision: "surface_error",
              runId: params.runId,
              provider: activeErrorContext.provider,
              model: activeErrorContext.model,
              reason: assistantFailoverReason,
            });
          }

          const usage = toNormalizedUsage(usageAccumulator);
          if (usage && lastTurnTotal && lastTurnTotal > 0) {
            usage.total = lastTurnTotal;
          }
          const lastCallUsage = normalizeUsage(lastAssistant?.usage as UsageLike);
          const promptTokens = derivePromptTokens(lastRunPromptUsage);
          const agentMeta: EmbeddedPiAgentMeta = {
            sessionId: sessionIdUsed,
            provider: lastAssistant?.provider ?? provider,
            model: lastAssistant?.model ?? model.id,
            usage,
            lastCallUsage: lastCallUsage ?? undefined,
            promptTokens,
          };

          const payloads = buildBrowserRunPayloads({
            assistantTexts: attempt.assistantTexts,
            toolMetas: attempt.toolMetas,
            lastAssistant: attempt.lastAssistant,
            lastToolError: attempt.lastToolError,
            config: params.config,
            sessionKey: params.sessionKey ?? params.sessionId,
            provider: activeErrorContext.provider,
            model: activeErrorContext.model,
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            toolResultFormat: resolvedToolResultFormat,
            suppressToolErrorWarnings: params.suppressToolErrorWarnings,
            inlineToolResultsAllowed: false,
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
          });

          if (timedOut && !timedOutDuringCompaction && payloads.length === 0) {
            return {
              payloads: [
                {
                  text:
                    "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta,
                aborted,
                systemPromptReport: attempt.systemPromptReport,
              },
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              successfulCronAdds: attempt.successfulCronAdds,
            };
          }

          if (lastProfileId) {
            await markAuthProfileGood({
              store: authStore,
              provider,
              profileId: lastProfileId,
              agentDir: params.agentDir,
            });
            await markAuthProfileUsed({
              store: authStore,
              profileId: lastProfileId,
              agentDir: params.agentDir,
            });
          }

          return {
            payloads: payloads.length ? payloads : undefined,
            meta: {
              durationMs: Date.now() - started,
              agentMeta,
              aborted,
              systemPromptReport: attempt.systemPromptReport,
              stopReason: attempt.clientToolCall
                ? "tool_calls"
                : (lastAssistant?.stopReason as string | undefined),
              pendingToolCalls: attempt.clientToolCall
                ? [
                    {
                      id: randomBytes(5).toString("hex").slice(0, 9),
                      name: attempt.clientToolCall.name,
                      arguments: JSON.stringify(attempt.clientToolCall.params),
                    },
                  ]
                : undefined,
            },
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
            messagingToolSentTexts: attempt.messagingToolSentTexts,
            messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
            messagingToolSentTargets: attempt.messagingToolSentTargets,
            successfulCronAdds: attempt.successfulCronAdds,
          };
        }
      } finally {
        process.chdir(prevCwd);
      }
    }),
  );
}
