import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createBrowserSubsystemLogger } from "./browser-subsystem-logger.js";
import { formatAssistantErrorText } from "./pi-embedded-helpers.js";
import {
  extractAssistantText,
  extractAssistantThinking,
  formatReasoningMessage,
  inferToolMetaFromArgs,
  isAssistantMessage,
  promoteThinkingTagsToBlocks,
} from "./pi-embedded-utils.js";
import { buildToolMutationState, isSameToolMutationAction } from "./tool-mutation.js";
import { normalizeToolName } from "./tool-policy.js";
import { truncateUtf16Safe } from "../utils.js";
import { hasNonzeroUsage, makeZeroUsageSnapshot, normalizeUsage, type UsageLike } from "./usage.js";

type EmbeddedSessionLike = {
  subscribe: (listener: (event: AgentEvent & Record<string, unknown>) => void) => () => void;
  abortCompaction: () => void;
  isCompacting?: boolean;
  messages?: AgentMessage[];
  sessionFile?: string;
  sessionId?: string;
};

type BrowserSubscribeParams = {
  session: EmbeddedSessionLike;
  runId: string;
  config?: unknown;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  onAgentEvent?: (event: { stream: string; data: Record<string, unknown> }) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onReasoningStream?: (event: { text: string }) => void | Promise<void>;
  onReasoningEnd?: () => void | Promise<void>;
};

type ToolMetaEntry = {
  toolName: string;
  meta?: string;
};

type LastToolError = {
  toolName: string;
  meta?: string;
  error?: string;
  mutatingAction?: boolean;
  actionFingerprint?: string;
};

type ToolStartRecord = {
  toolName: string;
  args: unknown;
  meta?: string;
  mutatingAction?: boolean;
  actionFingerprint?: string;
};

type BrowserMessagingToolSend = {
  tool: string;
  provider: string;
  accountId?: string;
  to?: string;
  threadId?: string;
};

const log = createBrowserSubsystemLogger("agent/browser-embedded");
const TOOL_RESULT_MAX_CHARS = 8000;
const TOOL_ERROR_MAX_CHARS = 400;

function truncateToolText(text: string): string {
  if (text.length <= TOOL_RESULT_MAX_CHARS) {
    return text;
  }
  return `${truncateUtf16Safe(text, TOOL_RESULT_MAX_CHARS)}\n…(truncated)…`;
}

function normalizeToolErrorText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  const firstLine = trimmed.split(/\r?\n/)[0]?.trim() ?? "";
  if (!firstLine) {
    return undefined;
  }
  return firstLine.length > TOOL_ERROR_MAX_CHARS
    ? `${truncateUtf16Safe(firstLine, TOOL_ERROR_MAX_CHARS)}…`
    : firstLine;
}

function isErrorLikeStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (
    normalized === "0" ||
    normalized === "ok" ||
    normalized === "success" ||
    normalized === "completed" ||
    normalized === "running"
  ) {
    return false;
  }
  return /error|fail|timeout|timed[_\s-]?out|denied|cancel|invalid|forbidden/.test(normalized);
}

function readErrorCandidate(value: unknown): string | undefined {
  if (typeof value === "string") {
    return normalizeToolErrorText(value);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string") {
    return normalizeToolErrorText(record.message);
  }
  if (typeof record.error === "string") {
    return normalizeToolErrorText(record.error);
  }
  return undefined;
}

function extractErrorField(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct =
    readErrorCandidate(record.error) ??
    readErrorCandidate(record.message) ??
    readErrorCandidate(record.reason);
  if (direct) {
    return direct;
  }
  const status = typeof record.status === "string" ? record.status.trim() : "";
  if (!status || !isErrorLikeStatus(status)) {
    return undefined;
  }
  return normalizeToolErrorText(status);
}

function sanitizeToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : null;
  if (!content) {
    return record;
  }
  const sanitized = content.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const entry = item as Record<string, unknown>;
    const type = typeof entry.type === "string" ? entry.type : undefined;
    if (type === "text" && typeof entry.text === "string") {
      return { ...entry, text: truncateToolText(entry.text) };
    }
    if (type === "image") {
      const data = typeof entry.data === "string" ? entry.data : undefined;
      const bytes = data ? data.length : undefined;
      const cleaned = { ...entry };
      delete cleaned.data;
      return { ...cleaned, bytes, omitted: true };
    }
    return entry;
  });
  return { ...record, content: sanitized };
}

function extractToolResultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : null;
  if (!content) {
    return undefined;
  }
  const texts = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const entry = item as Record<string, unknown>;
      return typeof entry.text === "string" ? entry.text.trim() : undefined;
    })
    .filter((value): value is string => Boolean(value));
  if (texts.length === 0) {
    return undefined;
  }
  return texts.join("\n");
}

function isToolResultError(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") {
    return false;
  }
  const status = (details as { status?: unknown }).status;
  if (typeof status !== "string") {
    return false;
  }
  const normalized = status.trim().toLowerCase();
  return normalized === "error" || normalized === "timeout";
}

function extractToolErrorMessage(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const fromDetails = extractErrorField(record.details);
  if (fromDetails) {
    return fromDetails;
  }
  const fromRoot = extractErrorField(record);
  if (fromRoot) {
    return fromRoot;
  }
  const text = extractToolResultText(result);
  if (!text) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    const fromJson = extractErrorField(parsed);
    if (fromJson) {
      return fromJson;
    }
  } catch {
    // Fall through to first-line text fallback.
  }
  return normalizeToolErrorText(text);
}

function isMessagingTool(toolName: string): boolean {
  return toolName === "sessions_send" || toolName === "message";
}

function isMessagingToolSendAction(toolName: string, args: Record<string, unknown>): boolean {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  if (toolName === "sessions_send") {
    return true;
  }
  if (toolName === "message") {
    return action === "send" || action === "thread-reply";
  }
  return false;
}

function extractMessagingToolSend(
  toolName: string,
  args: Record<string, unknown>,
): BrowserMessagingToolSend | undefined {
  const action = typeof args.action === "string" ? args.action.trim() : "";
  const accountIdRaw = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
  const accountId = accountIdRaw ? accountIdRaw : undefined;
  if (toolName === "message") {
    if (action !== "send" && action !== "thread-reply") {
      return undefined;
    }
    const target =
      typeof args.to === "string" ? args.to.trim() : typeof args.target === "string" ? args.target.trim() : "";
    if (!target) {
      return undefined;
    }
    const providerRaw = typeof args.provider === "string" ? args.provider.trim() : "";
    const channelRaw = typeof args.channel === "string" ? args.channel.trim() : "";
    const provider = (providerRaw || channelRaw || "message").toLowerCase();
    return {
      tool: toolName,
      provider,
      accountId,
      to: target,
      threadId: typeof args.threadId === "string" ? args.threadId.trim() || undefined : undefined,
    };
  }
  if (toolName === "sessions_send") {
    return {
      tool: toolName,
      provider: "sessions_send",
      accountId,
      to:
        typeof args.to === "string"
          ? args.to.trim() || undefined
          : typeof args.target === "string"
            ? args.target.trim() || undefined
            : undefined,
      threadId: typeof args.threadId === "string" ? args.threadId.trim() || undefined : undefined,
    };
  }
  return undefined;
}

function extendExecMeta(toolName: string, args: unknown, meta?: string): string | undefined {
  const normalized = toolName.trim().toLowerCase();
  if (normalized !== "exec" && normalized !== "bash") {
    return meta;
  }
  if (!args || typeof args !== "object") {
    return meta;
  }
  const record = args as Record<string, unknown>;
  const flags: string[] = [];
  if (record.pty === true) {
    flags.push("pty");
  }
  if (record.elevated === true) {
    flags.push("elevated");
  }
  if (flags.length === 0) {
    return meta;
  }
  const suffix = flags.join(" · ");
  return meta ? `${meta} · ${suffix}` : suffix;
}

function queueCallback<T extends unknown[]>(
  callback: ((...args: T) => void | Promise<void>) | undefined,
  ...args: T
): void {
  if (!callback) {
    return;
  }
  void Promise.resolve()
    .then(() => callback(...args))
    .catch((err) => {
      log.warn(`browser subscribe callback failed: ${String(err)}`);
    });
}

function recordAssistantUsage(usageTotals: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}, usageLike: unknown): void {
  const usage = normalizeUsage((usageLike ?? undefined) as UsageLike | undefined);
  if (!hasNonzeroUsage(usage)) {
    return;
  }
  usageTotals.input += usage.input ?? 0;
  usageTotals.output += usage.output ?? 0;
  usageTotals.cacheRead += usage.cacheRead ?? 0;
  usageTotals.cacheWrite += usage.cacheWrite ?? 0;
  const usageTotal =
    usage.total ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  usageTotals.total += usageTotal;
}

function snapshotUsageTotals(usageTotals: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}) {
  const hasUsage =
    usageTotals.input > 0 ||
    usageTotals.output > 0 ||
    usageTotals.cacheRead > 0 ||
    usageTotals.cacheWrite > 0 ||
    usageTotals.total > 0;
  if (!hasUsage) {
    return undefined;
  }
  const derivedTotal =
    usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite;
  return {
    input: usageTotals.input || undefined,
    output: usageTotals.output || undefined,
    cacheRead: usageTotals.cacheRead || undefined,
    cacheWrite: usageTotals.cacheWrite || undefined,
    total: usageTotals.total || derivedTotal || undefined,
  };
}

function clearStaleAssistantUsageOnSessionMessages(session: EmbeddedSessionLike): void {
  const messages = session.messages;
  if (!Array.isArray(messages)) {
    return;
  }
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const candidate = message as { role?: unknown; usage?: unknown };
    if (candidate.role !== "assistant") {
      continue;
    }
    candidate.usage = makeZeroUsageSnapshot();
  }
}

function emitLifecycleEvent(
  params: BrowserSubscribeParams,
  data: Record<string, unknown>,
): void {
  emitAgentEvent({
    runId: params.runId,
    stream: "lifecycle",
    data,
  });
  queueCallback(params.onAgentEvent, {
    stream: "lifecycle",
    data,
  });
}

function emitAssistantEvent(
  params: BrowserSubscribeParams,
  data: Record<string, unknown>,
): void {
  emitAgentEvent({
    runId: params.runId,
    stream: "assistant",
    data,
  });
  queueCallback(params.onAgentEvent, {
    stream: "assistant",
    data,
  });
}

function emitToolEvent(params: BrowserSubscribeParams, data: Record<string, unknown>): void {
  emitAgentEvent({
    runId: params.runId,
    stream: "tool",
    data,
  });
  queueCallback(params.onAgentEvent, {
    stream: "tool",
    data,
  });
}

export function subscribeEmbeddedBrowserSession(params: BrowserSubscribeParams) {
  const assistantTexts: string[] = [];
  const toolMetas: ToolMetaEntry[] = [];
  const toolStarts = new Map<string, ToolStartRecord>();
  const messagingToolSentTexts: string[] = [];
  const messagingToolSentTargets: BrowserMessagingToolSend[] = [];
  const messagingToolSentMediaUrls: string[] = [];
  const pendingMessagingTexts = new Map<string, string>();
  const pendingMessagingTargets = new Map<string, BrowserMessagingToolSend>();
  const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let lastAssistant: AgentMessage | undefined;
  let lastAssistantPartialText = "";
  let lastReasoningText = "";
  let lastToolError: LastToolError | undefined;
  let compactionCount = 0;
  let compactionInFlight = false;
  let pendingCompactionRetry = 0;
  let compactionRetryResolve: (() => void) | undefined;
  let compactionRetryReject: ((reason?: unknown) => void) | undefined;
  let compactionRetryPromise: Promise<void> | null = null;
  let successfulCronAdds = 0;
  let unsubscribed = false;

  const ensureCompactionPromise = () => {
    if (!compactionRetryPromise) {
      compactionRetryPromise = new Promise<void>((resolve, reject) => {
        compactionRetryResolve = resolve;
        compactionRetryReject = reject;
      });
      compactionRetryPromise.catch((err) => {
        log.debug(`browser compaction promise rejected: ${String(err)}`);
      });
    }
  };

  const resetForCompactionRetry = () => {
    assistantTexts.length = 0;
    toolMetas.length = 0;
    toolStarts.clear();
    pendingMessagingTexts.clear();
    pendingMessagingTargets.clear();
    messagingToolSentTexts.length = 0;
    messagingToolSentTargets.length = 0;
    messagingToolSentMediaUrls.length = 0;
    lastAssistantPartialText = "";
    lastReasoningText = "";
    lastToolError = undefined;
    successfulCronAdds = 0;
  };

  const resolveCompactionRetry = () => {
    if (pendingCompactionRetry <= 0) {
      return;
    }
    pendingCompactionRetry -= 1;
    if (pendingCompactionRetry === 0 && !compactionInFlight) {
      compactionRetryResolve?.();
      compactionRetryResolve = undefined;
      compactionRetryReject = undefined;
      compactionRetryPromise = null;
    }
  };

  const maybeResolveCompactionWait = () => {
    if (pendingCompactionRetry === 0 && !compactionInFlight) {
      compactionRetryResolve?.();
      compactionRetryResolve = undefined;
      compactionRetryReject = undefined;
      compactionRetryPromise = null;
    }
  };

  const noteAssistantPartial = (msg: AgentMessage) => {
    if (!isAssistantMessage(msg)) {
      return;
    }
    const text = extractAssistantText(msg).trim();
    if (!text) {
      return;
    }
    const delta =
      lastAssistantPartialText && text.startsWith(lastAssistantPartialText)
        ? text.slice(lastAssistantPartialText.length)
        : text;
    if (!delta) {
      return;
    }
    lastAssistantPartialText = text;
    emitAssistantEvent(params, {
      text,
      delta,
    });
  };

  const noteAssistantReasoning = (msg: AgentMessage) => {
    if (!params.onReasoningStream || !isAssistantMessage(msg)) {
      return;
    }
    const reasoning = formatReasoningMessage(extractAssistantThinking(msg));
    if (!reasoning || reasoning === lastReasoningText) {
      return;
    }
    lastReasoningText = reasoning;
    queueCallback(params.onReasoningStream, { text: reasoning });
  };

  const sessionUnsubscribe = params.session.subscribe((evt) => {
    switch (evt.type) {
      case "agent_start": {
        log.debug(`browser embedded run start: runId=${params.runId}`);
        emitLifecycleEvent(params, {
          phase: "start",
          startedAt: Date.now(),
        });
        return;
      }
      case "agent_end": {
        const isError = isAssistantMessage(lastAssistant) && lastAssistant.stopReason === "error";
        if (isError && lastAssistant) {
          const friendlyError = formatAssistantErrorText(lastAssistant, {
            cfg: params.config as never,
            sessionKey: params.sessionKey,
            provider: lastAssistant.provider,
            model: lastAssistant.model,
          });
          emitLifecycleEvent(params, {
            phase: "error",
            error: (friendlyError || lastAssistant.errorMessage || "LLM request failed.").trim(),
            endedAt: Date.now(),
          });
        } else {
          emitLifecycleEvent(params, {
            phase: "end",
            endedAt: Date.now(),
          });
        }
        queueCallback(params.onReasoningEnd);
        if (pendingCompactionRetry > 0) {
          resolveCompactionRetry();
        } else {
          maybeResolveCompactionWait();
        }
        return;
      }
      case "auto_compaction_start": {
        compactionInFlight = true;
        ensureCompactionPromise();
        emitAgentEvent({
          runId: params.runId,
          stream: "compaction",
          data: { phase: "start" },
        });
        queueCallback(params.onAgentEvent, {
          stream: "compaction",
          data: { phase: "start" },
        });
        return;
      }
      case "auto_compaction_end": {
        compactionInFlight = false;
        const willRetry = Boolean(evt.willRetry);
        const hasResult = evt.result != null;
        const wasAborted = Boolean(evt.aborted);
        if (hasResult && !wasAborted) {
          compactionCount += 1;
        }
        if (willRetry) {
          pendingCompactionRetry += 1;
          ensureCompactionPromise();
          resetForCompactionRetry();
        } else {
          maybeResolveCompactionWait();
          clearStaleAssistantUsageOnSessionMessages(params.session);
        }
        emitAgentEvent({
          runId: params.runId,
          stream: "compaction",
          data: { phase: "end", willRetry },
        });
        queueCallback(params.onAgentEvent, {
          stream: "compaction",
          data: { phase: "end", willRetry },
        });
        return;
      }
      case "message_start": {
        const message = evt.message as AgentMessage | undefined;
        if (!isAssistantMessage(message)) {
          return;
        }
        lastAssistantPartialText = "";
        lastReasoningText = "";
        queueCallback(params.onAssistantMessageStart);
        return;
      }
      case "message_update": {
        const message = evt.message as AgentMessage | undefined;
        if (!isAssistantMessage(message)) {
          return;
        }
        lastAssistant = message;
        noteAssistantReasoning(message);
        const assistantEvent =
          evt.assistantMessageEvent && typeof evt.assistantMessageEvent === "object"
            ? (evt.assistantMessageEvent as Record<string, unknown>)
            : null;
        const eventType = typeof assistantEvent?.type === "string" ? assistantEvent.type : "";
        if (eventType === "text_start" || eventType === "text_delta" || eventType === "text_end") {
          noteAssistantPartial(message);
        }
        if (eventType === "thinking_end") {
          queueCallback(params.onReasoningEnd);
        }
        return;
      }
      case "message_end": {
        const message = evt.message as AgentMessage | undefined;
        if (!isAssistantMessage(message)) {
          return;
        }
        lastAssistant = message;
        recordAssistantUsage(usageTotals, (message as { usage?: unknown }).usage);
        promoteThinkingTagsToBlocks(message);
        noteAssistantReasoning(message);
        const text = extractAssistantText(message).trim();
        if (text && assistantTexts.at(-1) !== text) {
          assistantTexts.push(text);
        }
        if (text && lastAssistantPartialText !== text) {
          const delta =
            lastAssistantPartialText && text.startsWith(lastAssistantPartialText)
              ? text.slice(lastAssistantPartialText.length)
              : text;
          emitAssistantEvent(params, {
            text,
            delta,
          });
          lastAssistantPartialText = text;
        }
        queueCallback(params.onReasoningEnd);
        return;
      }
      case "tool_execution_start": {
        const toolName = normalizeToolName(String(evt.toolName ?? ""));
        const toolCallId = String(evt.toolCallId ?? "");
        const args = evt.args;
        const meta = extendExecMeta(toolName, args, inferToolMetaFromArgs(toolName, args));
        const mutation = buildToolMutationState(toolName, args, meta);
        toolStarts.set(toolCallId, {
          toolName,
          args,
          meta,
          mutatingAction: mutation.mutatingAction,
          actionFingerprint: mutation.actionFingerprint,
        });
        emitToolEvent(params, {
          phase: "start",
          name: toolName,
          toolCallId,
          args: args as Record<string, unknown>,
        });

        if (isMessagingTool(toolName) && args && typeof args === "object") {
          const argsRecord = args as Record<string, unknown>;
          if (isMessagingToolSendAction(toolName, argsRecord)) {
            const target = extractMessagingToolSend(toolName, argsRecord);
            if (target) {
              pendingMessagingTargets.set(toolCallId, target);
            }
            const text = (argsRecord.content as string) ?? (argsRecord.message as string);
            if (typeof text === "string" && text.trim()) {
              pendingMessagingTexts.set(toolCallId, text);
            }
          }
        }
        return;
      }
      case "tool_execution_update": {
        const toolName = normalizeToolName(String(evt.toolName ?? ""));
        const toolCallId = String(evt.toolCallId ?? "");
        emitToolEvent(params, {
          phase: "update",
          name: toolName,
          toolCallId,
          partialResult: sanitizeToolResult(evt.partialResult),
        });
        return;
      }
      case "tool_execution_end": {
        const toolName = normalizeToolName(String(evt.toolName ?? ""));
        const toolCallId = String(evt.toolCallId ?? "");
        const start = toolStarts.get(toolCallId);
        toolStarts.delete(toolCallId);
        const isError = Boolean(evt.isError) || isToolResultError(evt.result);
        const sanitizedResult = sanitizeToolResult(evt.result);
        toolMetas.push({ toolName, meta: start?.meta });
        if (isError) {
          lastToolError = {
            toolName,
            meta: start?.meta,
            error: extractToolErrorMessage(sanitizedResult),
            mutatingAction: start?.mutatingAction,
            actionFingerprint: start?.actionFingerprint,
          };
        } else if (lastToolError) {
          const sameMutation = isSameToolMutationAction(lastToolError, {
            toolName,
            meta: start?.meta,
            actionFingerprint: start?.actionFingerprint,
          });
          if (!lastToolError.mutatingAction || sameMutation) {
            lastToolError = undefined;
          }
        }

        const pendingText = pendingMessagingTexts.get(toolCallId);
        if (pendingText) {
          pendingMessagingTexts.delete(toolCallId);
          if (!isError) {
            messagingToolSentTexts.push(pendingText);
          }
        }
        const pendingTarget = pendingMessagingTargets.get(toolCallId);
        if (pendingTarget) {
          pendingMessagingTargets.delete(toolCallId);
          if (!isError) {
            messagingToolSentTargets.push(pendingTarget);
          }
        }
        if (!isError && toolName === "cron") {
          const action =
            start?.args && typeof start.args === "object"
              ? (start.args as Record<string, unknown>).action
              : undefined;
          if (typeof action === "string" && action.trim().toLowerCase() === "add") {
            successfulCronAdds += 1;
          }
        }
        emitToolEvent(params, {
          phase: "result",
          name: toolName,
          toolCallId,
          meta: start?.meta,
          isError,
          result: sanitizedResult,
        });
        return;
      }
      default:
        return;
    }
  });

  const unsubscribe = () => {
    if (unsubscribed) {
      return;
    }
    unsubscribed = true;
    if (compactionRetryPromise) {
      const reject = compactionRetryReject;
      compactionRetryResolve = undefined;
      compactionRetryReject = undefined;
      compactionRetryPromise = null;
      const abortErr = new Error("Unsubscribed during compaction");
      abortErr.name = "AbortError";
      reject?.(abortErr);
    }
    if (params.session.isCompacting) {
      try {
        params.session.abortCompaction();
      } catch (err) {
        log.warn(`browser subscribe compaction abort failed: ${String(err)}`);
      }
    }
    sessionUnsubscribe();
  };

  return {
    assistantTexts,
    toolMetas,
    unsubscribe,
    isCompacting: () => compactionInFlight || pendingCompactionRetry > 0,
    isCompactionInFlight: () => compactionInFlight,
    getMessagingToolSentTexts: () => messagingToolSentTexts.slice(),
    getMessagingToolSentMediaUrls: () => messagingToolSentMediaUrls.slice(),
    getMessagingToolSentTargets: () => messagingToolSentTargets.slice(),
    getSuccessfulCronAdds: () => successfulCronAdds,
    didSendViaMessagingTool: () => messagingToolSentTexts.length > 0,
    getLastToolError: () => (lastToolError ? { ...lastToolError } : undefined),
    getUsageTotals: () => snapshotUsageTotals(usageTotals),
    getCompactionCount: () => compactionCount,
    waitForCompactionRetry: () => {
      if (unsubscribed) {
        const err = new Error("Unsubscribed during compaction wait");
        err.name = "AbortError";
        return Promise.reject(err);
      }
      if (compactionInFlight || pendingCompactionRetry > 0) {
        ensureCompactionPromise();
        return compactionRetryPromise ?? Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        queueMicrotask(() => {
          if (unsubscribed) {
            const err = new Error("Unsubscribed during compaction wait");
            err.name = "AbortError";
            reject(err);
            return;
          }
          if (compactionInFlight || pendingCompactionRetry > 0) {
            ensureCompactionPromise();
            void (compactionRetryPromise ?? Promise.resolve()).then(resolve, reject);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
