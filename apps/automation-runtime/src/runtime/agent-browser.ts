import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeEvent } from "../contracts/events.js";
import type { BrowserExecutionStep, AutomationRuntimeRunRequest } from "../contracts/run.js";
import { loadRuntimeConfig } from "./config.js";
import {
  executePreparedEmbeddedOpenClawRun,
  prepareEmbeddedOpenClawRetryRun,
  prepareEmbeddedOpenClawRun,
  restartEmbeddedBrowserBridgeDaemons,
} from "./embedded-openclaw-runner.js";

export type AgentBrowserBatchResult = {
  success: boolean;
  rows: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  error?: string;
};

type EmitEvent = (type: RuntimeEvent["type"], payload: Record<string, unknown>) => void;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(MODULE_DIR, "..", "..");
const AGENT_BROWSER_SKILL_PATH = path.resolve(
  PACKAGE_ROOT,
  "..",
  "..",
  "node_modules",
  "agent-browser",
  "skills",
  "agent-browser",
  "SKILL.md",
);
const AGENT_BROWSER_COMMANDS_PATH = path.resolve(
  PACKAGE_ROOT,
  "..",
  "..",
  "node_modules",
  "agent-browser",
  "skills",
  "agent-browser",
  "references",
  "commands.md",
);
const AGENT_BROWSER_REFS_PATH = path.resolve(
  PACKAGE_ROOT,
  "..",
  "..",
  "node_modules",
  "agent-browser",
  "skills",
  "agent-browser",
  "references",
  "snapshot-refs.md",
);

let browserGuidanceCache: string | null = null;

type BrowserObservationMemory = {
  capturedAt: string;
  url?: string;
  title?: string;
  targetId?: string;
  format?: string;
  snapshotText?: string;
  refCount?: number;
};

type BrowserActionMemory = {
  capturedAt: string;
  operation?: string;
  mutating: boolean;
};

export type LoopState = {
  lastBrowserObservation?: BrowserObservationMemory;
  lastBrowserAction?: BrowserActionMemory;
  browserObservationsByTarget?: Record<string, BrowserObservationMemory>;
  activeBrowserTargetId?: string;
  browserTimeoutRecoveryCount?: number;
  terminalIncident?: {
    code?: string;
    reason?: string;
    replannable?: boolean;
    phase?: string;
  };
};

export function createLoopStateForRun(): LoopState {
  return {
    browserTimeoutRecoveryCount: 0,
    browserObservationsByTarget: {},
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeModelRef(request: AutomationRuntimeRunRequest): string | undefined {
  const explicitProvider = String(request.model?.provider || "").trim();
  const explicitModel = String(request.model?.name || "").trim();
  if (!explicitProvider && !explicitModel) {
    return undefined;
  }
  const config = loadRuntimeConfig();
  const provider = explicitProvider || (config.googleGenAiUseVertexAi ? "google-vertex" : "google");
  const modelName = explicitModel;
  if (!modelName) {
    return undefined;
  }
  if (modelName.includes("/")) {
    return modelName;
  }
  return `${provider}/${modelName}`;
}

function extractVisibleText(payloads: Array<Record<string, unknown>>): string {
  return payloads
    .map((payload) => String(payload.text || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

async function loadBrowserGuidance(): Promise<string> {
  if (browserGuidanceCache) {
    return browserGuidanceCache;
  }
  const [skill, commands, refs] = await Promise.all([
    fs.readFile(AGENT_BROWSER_SKILL_PATH, "utf8"),
    fs.readFile(AGENT_BROWSER_COMMANDS_PATH, "utf8"),
    fs.readFile(AGENT_BROWSER_REFS_PATH, "utf8"),
  ]);
  const compact = [
    "# agent-browser upstream guidance",
    skill.split("## Essential Commands")[0].trim(),
    "## Essential command excerpts",
    commands.split("## Get Information")[0].trim(),
    "## Snapshot and refs excerpts",
    refs.split("## Troubleshooting")[0].trim(),
  ].join("\n\n");
  browserGuidanceCache = compact;
  return compact;
}

function looksLikeCapabilityRefusal(result: AgentBrowserBatchResult): boolean {
  const text = String(result.error || result.metadata.text || "").toLowerCase();
  if (!text) {
    return false;
  }
  return (
    text.includes("cannot directly send emails") ||
    text.includes("can't directly send emails") ||
    text.includes("cannot directly send messages") ||
    text.includes("can't directly send messages") ||
    text.includes("my capabilities are limited") ||
    text.includes("there isn't a tool for sending emails")
  );
}

async function buildBrowserFirstPrompt(request: AutomationRuntimeRunRequest): Promise<string> {
  const guidance = await loadBrowserGuidance();
  return [
    guidance,
    "",
    "## Execution directive",
    "This is a browser UI automation task in an already attached browser session.",
    "Use the browser tool as the primary tool.",
    "Do not answer with generic capability limitations when the task can be completed through the browser UI.",
    "Follow the upstream agent-browser workflow strictly: open or focus page, snapshot, act by ref, re-snapshot after UI changes.",
    "If the current UI already exposes the target form, draft, modal, drawer, popup, or editor, continue from that foreground surface instead of restarting the flow.",
    "Prefer observing the active foreground surface before taking action in dynamic multi-step forms.",
    "When a visible dialog, composer, drawer, popup, sheet, or editor is already open, do not start with a broad body snapshot. Start with a scoped snapshot of that active surface first.",
    "Do not use broad selectors such as body, button, div[role='button'], or generic role-button containers as scoped snapshot selectors when a foreground surface is already visible.",
    "Only switch into a frame if the latest snapshot explicitly showed the relevant interactive controls inside that frame. Do not probe arbitrary iframe refs when the target is still discoverable from the main document.",
    "If multiple similar surfaces are visible, prefer the most recently focused or frontmost visible surface and continue inside it.",
    "When using the browser tool, valid top-level actions are browser tool actions such as open, snapshot, navigate, and act.",
    "For interactive UI steps, use action=\"act\" and provide a request object with a concrete act kind such as click, type, press, select, fill, or hover.",
    "For click, type, select, fill, and drag, always use refs from the latest snapshot. Do not use visible labels or free-text descriptions as stand-ins for refs.",
    "After any mutating UI action such as click, type, press, select, fill, close, or drag, take a fresh snapshot before attempting the next ref-based action.",
    "In dynamic forms, dialogs, drawers, popups, sheets, and editors, never emit multiple mutating browser actions in a single assistant turn. Perform one mutating action, wait for the tool result, then re-snapshot before the next mutating action.",
    "",
    "## User task",
    request.text.trim(),
  ].join("\n");
}

function stringifyLogArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function mapPayloadsToRows(payloads: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return payloads.map((payload, index) => ({
    index,
    text: payload.text ?? null,
    mediaUrl: payload.mediaUrl ?? null,
    mediaUrls: Array.isArray(payload.mediaUrls) ? payload.mediaUrls : [],
  }));
}

function snippet(value: string | undefined, limit = 1500): string | undefined {
  const text = String(value || "").trim();
  if (!text) {
    return undefined;
  }
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function countRefs(value: unknown): number | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return Object.keys(record).length;
}

function findObservationCandidate(value: unknown, depth = 0): BrowserObservationMemory | null {
  if (depth > 4) {
    return null;
  }
  const record = asRecord(value);
  if (!record) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findObservationCandidate(item, depth + 1);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  const snapshotText = snippet(
    typeof record.snapshot === "string"
      ? record.snapshot
      : typeof record.text === "string"
        ? record.text
        : undefined,
  );
  const url =
    typeof record.url === "string"
      ? record.url
      : typeof record.origin === "string"
        ? record.origin
        : undefined;
  const title = typeof record.title === "string" ? record.title : undefined;
  const targetId =
    typeof record.targetId === "string"
      ? record.targetId
      : typeof record.pageId === "string"
        ? record.pageId
        : undefined;
  const format = typeof record.format === "string" ? record.format : undefined;
  const refCount =
    typeof record.refs === "object" && record.refs
      ? countRefs(record.refs)
      : typeof record.labelsCount === "number"
        ? record.labelsCount
        : undefined;

  if (snapshotText || format || targetId || url || refCount) {
    return {
      capturedAt: nowIso(),
      url,
      title,
      targetId,
      format,
      snapshotText,
      refCount,
    };
  }

  for (const nested of Object.values(record)) {
    const found = findObservationCandidate(nested, depth + 1);
    if (found) {
      return found;
    }
  }
  return null;
}

function observationsShareTarget(
  current: BrowserObservationMemory | undefined,
  candidate: BrowserObservationMemory,
): boolean {
  if (!current) {
    return true;
  }
  if (current.targetId && candidate.targetId) {
    return current.targetId === candidate.targetId;
  }
  if (current.targetId && !candidate.targetId) {
    const urlConflicts =
      Boolean(current.url && candidate.url) && current.url !== candidate.url;
    const titleConflicts =
      Boolean(current.title && candidate.title) && current.title !== candidate.title;
    return !(urlConflicts && titleConflicts);
  }
  if (!current.targetId && candidate.targetId) {
    return true;
  }
  return true;
}

function mergeObservationMemory(
  current: BrowserObservationMemory | undefined,
  candidate: BrowserObservationMemory,
): BrowserObservationMemory {
  if (!current || !observationsShareTarget(current, candidate)) {
    return candidate;
  }
  return {
    capturedAt: candidate.capturedAt,
    targetId: candidate.targetId || current.targetId,
    url: candidate.url || current.url,
    title: candidate.title || current.title,
    format: candidate.format || current.format,
    snapshotText: candidate.snapshotText || current.snapshotText,
    refCount:
      typeof candidate.refCount === "number" ? candidate.refCount : current.refCount,
  };
}

function observationSpecificityScore(observation: BrowserObservationMemory | undefined): number {
  if (!observation) {
    return -1;
  }
  const refCount = typeof observation.refCount === "number" ? observation.refCount : 999;
  let score = 0;
  // Lower ref counts are generally more scoped/foreground-specific than broad page snapshots.
  score += Math.max(0, 200 - Math.min(refCount, 200));
  if (observation.targetId) {
    score += 10;
  }
  if (observation.format === "aria") {
    score += 5;
  }
  if (observation.snapshotText && observation.snapshotText.length > 0) {
    score += 5;
  }
  return score;
}

function shouldReplaceObservationMemory(
  current: BrowserObservationMemory | undefined,
  candidate: BrowserObservationMemory,
  lastAction: BrowserActionMemory | undefined,
): boolean {
  if (!current) {
    return true;
  }
  if (!observationsShareTarget(current, candidate)) {
    return true;
  }
  const currentScore = observationSpecificityScore(current);
  const candidateScore = observationSpecificityScore(candidate);
  if (candidateScore >= currentScore) {
    return true;
  }
  if (
    lastAction?.mutating &&
    typeof current.refCount === "number" &&
    typeof candidate.refCount === "number" &&
    current.refCount <= 25 &&
    candidate.refCount >= current.refCount * 3
  ) {
    return false;
  }
  return true;
}

function classifyBrowserOperationFromEventPayload(payload: Record<string, unknown>): string | undefined {
  const meta = typeof payload.meta === "string" ? payload.meta.trim().toLowerCase() : "";
  if (meta) {
    const kindMatch = /^kind\s+([a-z]+)/.exec(meta);
    if (kindMatch?.[1]) {
      return `act:${kindMatch[1]}`;
    }
    if (meta === "snapshot") {
      return "snapshot";
    }
  }
  const resultRecord = asRecord(payload.result);
  const partialRecord = asRecord(payload.partialResult);
  const candidate =
    (resultRecord && typeof resultRecord.kind === "string" ? resultRecord.kind : "") ||
    (partialRecord && typeof partialRecord.kind === "string" ? partialRecord.kind : "");
  return candidate ? String(candidate).trim().toLowerCase() : undefined;
}

function isMutatingBrowserOperation(operation: string | undefined): boolean {
  return new Set([
    "open",
    "upload",
    "dialog",
    "click",
    "type",
    "press",
    "hover",
    "drag",
    "select",
    "fill",
    "act:click",
    "act:type",
    "act:press",
    "act:hover",
    "act:drag",
    "act:select",
    "act:fill",
  ]).has(String(operation || "").trim().toLowerCase());
}

function rememberBrowserRuntimeEvent(
  loopState: LoopState,
  type: RuntimeEvent["type"],
  payload: Record<string, unknown>,
): void {
  if (type === "run.runtime_incident") {
    loopState.terminalIncident = {
      code: typeof payload.code === "string" ? payload.code : undefined,
      reason: typeof payload.reason === "string" ? payload.reason : undefined,
      replannable:
        typeof payload.replannable === "boolean" ? payload.replannable : undefined,
      phase: typeof payload.phase === "string" ? payload.phase : undefined,
    };
    return;
  }
  if (type === "run.browser.snapshot" || type === "run.tool.finished") {
    const toolName = type === "run.tool.finished" ? String(payload.toolName || "") : "browser";
    if (toolName && toolName !== "browser") {
      return;
    }
    const observation =
      findObservationCandidate(payload.result) ||
      findObservationCandidate(payload.partialResult) ||
      findObservationCandidate(payload);
    if (observation) {
      const currentObservation = observation.targetId
        ? loopState.browserObservationsByTarget?.[observation.targetId]
        : loopState.lastBrowserObservation;
      if (
        shouldReplaceObservationMemory(
          currentObservation,
          observation,
          loopState.lastBrowserAction,
        )
      ) {
        const mergedObservation = mergeObservationMemory(currentObservation, observation);
        if (mergedObservation.targetId) {
          const observationsByTarget = {
            ...(loopState.browserObservationsByTarget || {}),
            [mergedObservation.targetId]: mergedObservation,
          };
          loopState.browserObservationsByTarget = observationsByTarget;
          loopState.activeBrowserTargetId = mergedObservation.targetId;
        }
        loopState.lastBrowserObservation = mergedObservation;
      }
    }
    const operation = classifyBrowserOperationFromEventPayload(payload);
    if (operation === "snapshot") {
      return;
    }
    if (operation) {
      loopState.lastBrowserAction = {
        capturedAt: nowIso(),
        operation,
        mutating: isMutatingBrowserOperation(operation),
      };
    }
  }
  if (type === "run.browser.action") {
    const operation = classifyBrowserOperationFromEventPayload(payload);
    const actionObservation =
      findObservationCandidate(payload.result) ||
      findObservationCandidate(payload.partialResult) ||
      findObservationCandidate(payload);
    if (actionObservation?.targetId) {
      loopState.activeBrowserTargetId = actionObservation.targetId;
    }
    if (operation) {
      loopState.lastBrowserAction = {
        capturedAt: nowIso(),
        operation,
        mutating: isMutatingBrowserOperation(operation),
      };
    }
  }
}

export const __testOnly = {
  findObservationCandidate,
  rememberBrowserRuntimeEvent,
};

function buildBrowserTimeoutRecoveryPrompt(
  request: AutomationRuntimeRunRequest,
  loopState: LoopState,
  attempt: number,
): string {
  const observation = loopState.lastBrowserObservation;
  const action = loopState.lastBrowserAction;
  const contextLines = [
    "The previous browser-tool attempt timed out during a dynamic UI flow.",
    "Recover generically from the current live browser state.",
    "Do not restart the workflow from the beginning.",
    "Start with a fresh snapshot of the current foreground surface, then continue from there.",
    "If a dialog, composer, drawer, popup, sheet, or active form is already open, observe that surface first and continue inside it.",
    "Treat any previous refs as stale unless re-seen in the fresh snapshot.",
    "Do not use broad selectors such as body, button, div[role='button'], or generic role-button containers for recovery while a foreground surface is already visible.",
    "If the last good observation came from a foreground surface, stay anchored to that same surface before broadening to the full page.",
    "Only switch into a frame if the last good observation explicitly showed the relevant interactive controls inside that frame. Do not recover by probing arbitrary iframe refs after a timeout; recover in the main document first.",
    "Do not retry the same mutating ref actions in one batch. Perform one mutating action, inspect the result, then re-snapshot before continuing.",
  ];
  if (attempt >= 2) {
    contextLines.push(
      "If a fresh foreground snapshot still cannot produce stable refs, take a labeled browser screenshot of the current viewport as a visual recovery aid.",
    );
    contextLines.push(
      "Use the labeled screenshot only to identify the single active foreground target or surface, then take another fresh snapshot of that same surface before acting.",
    );
    contextLines.push(
      "Prefer visual identification only for isolated click targets. For typing or filling fields, always re-establish a fresh snapshot and refs before entering text.",
    );
  }
  if (action?.operation) {
    contextLines.push(`Last browser action: ${action.operation}`);
  }
  if (observation?.url) {
    contextLines.push(`Last observed URL: ${observation.url}`);
  }
  if (observation?.title) {
    contextLines.push(`Last observed title: ${observation.title}`);
  }
  if (observation?.targetId) {
    contextLines.push(`Last observed targetId: ${observation.targetId}`);
  }
  if (observation?.format) {
    contextLines.push(`Last observation format: ${observation.format}`);
  }
  if (typeof observation?.refCount === "number") {
    contextLines.push(`Last observation ref count: ${observation.refCount}`);
  }
  if (observation?.snapshotText) {
    contextLines.push("Last observation excerpt:");
    contextLines.push(observation.snapshotText);
  }
  return [
    request.text.trim(),
    "",
    "## Recovery context",
    ...contextLines,
  ].join("\n");
}

function extractResultText(result: AgentBrowserBatchResult): string {
  const text = [
    result.error || "",
    String(result.metadata.text || ""),
    ...result.rows.map((row) => String(row.text || "")),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return text;
}

function shouldRecoverBrowserChannel(result: AgentBrowserBatchResult): boolean {
  const text = extractResultText(result);
  if (!text) {
    return false;
  }
  return (
    text.includes("browser tool timed out") ||
    text.includes("browser tool is currently unavailable") ||
    text.includes("browser proxy timed out") ||
    text.includes("restart the openclaw gateway") ||
    text.includes("openclaw gateway restart")
  );
}

function shouldRecoverModelTimeout(result: AgentBrowserBatchResult): boolean {
  const text = extractResultText(result);
  if (!text) {
    return false;
  }
  return (
    text.includes("llm request timed out") ||
    text.includes("request timed out before a response was generated") ||
    text.includes("connection reset by peer") ||
    text.includes("timed out") && text.includes("request")
  );
}

type TransientModelFailureKind = "rate_limit" | "overloaded" | "timeout";

function classifyTransientModelFailure(
  result: AgentBrowserBatchResult,
): TransientModelFailureKind | null {
  const text = extractResultText(result);
  if (!text) {
    return null;
  }
  if (
    text.includes("api rate limit reached") ||
    text.includes("llm request rate limited") ||
    (text.includes("rate limit") && text.includes("try again later"))
  ) {
    return "rate_limit";
  }
  if (
    text.includes("temporarily overloaded") ||
    text.includes("service is temporarily overloaded") ||
    text.includes("temporarily unavailable")
  ) {
    return "overloaded";
  }
  if (shouldRecoverModelTimeout(result)) {
    return "timeout";
  }
  return null;
}

function transientFailureTerminalCode(kind: TransientModelFailureKind): string {
  switch (kind) {
    case "rate_limit":
      return "MODEL_RATE_LIMIT";
    case "overloaded":
      return "MODEL_OVERLOADED";
    case "timeout":
      return "MODEL_TIMEOUT";
  }
}

function transientFailureLogMessage(kind: TransientModelFailureKind): string {
  switch (kind) {
    case "rate_limit":
      return "Detected model rate limiting from OpenClaw. Backing off briefly and retrying once with a fresh embedded session.";
    case "overloaded":
      return "Detected temporary model overload from OpenClaw. Backing off briefly and retrying once with a fresh embedded session.";
    case "timeout":
      return "Detected model/network timeout from OpenClaw. Retrying once with a fresh embedded session.";
  }
}

function transientFailureBackoffMs(kind: TransientModelFailureKind): number {
  switch (kind) {
    case "rate_limit":
      return 4000;
    case "overloaded":
      return 2500;
    case "timeout":
      return 1200;
  }
}

function withTransientFailureMetadata(
  result: AgentBrowserBatchResult,
  kind: TransientModelFailureKind,
): AgentBrowserBatchResult {
  return {
    ...result,
    success: false,
    metadata: {
      ...result.metadata,
      terminalCode: transientFailureTerminalCode(kind),
      transientFailure: {
        kind,
        retrySuggested: true,
      },
    },
  };
}

function hasTerminalIncident(loopState: LoopState): boolean {
  const incident = loopState.terminalIncident;
  if (!incident) {
    return false;
  }
  const phase = String(incident.phase || "").trim().toLowerCase();
  if (phase === "error") {
    return true;
  }
  return incident.replannable === false;
}

function terminalIncidentResult(
  request: AutomationRuntimeRunRequest,
  loopState: LoopState,
  result: AgentBrowserBatchResult,
): AgentBrowserBatchResult {
  const incident = loopState.terminalIncident;
  const code = String(
    incident?.code ||
      result.metadata.terminalCode ||
      (result.metadata.meta &&
      typeof result.metadata.meta === "object" &&
      "terminalCode" in result.metadata.meta
        ? (result.metadata.meta as Record<string, unknown>).terminalCode
        : "") ||
      "EXECUTION_FAILED",
  ).trim();
  const reason = String(
    incident?.reason ||
      result.error ||
      "Node automation runtime execution failed.",
  ).trim();
  return {
    success: false,
    rows: result.rows,
    metadata: {
      ...result.metadata,
      terminalCode: code || "EXECUTION_FAILED",
      terminalIncident: {
        code: incident?.code || code || "EXECUTION_FAILED",
        reason,
        replannable: incident?.replannable ?? false,
        phase: incident?.phase || "error",
        runId: request.runId,
      },
    },
    error: reason,
  };
}

export async function executePromptBrowserRun(params: {
  request: AutomationRuntimeRunRequest;
  loopState: LoopState;
  emit: EmitEvent;
  signal?: AbortSignal;
}): Promise<AgentBrowserBatchResult> {
  const { request, emit } = params;
  const modelRef = normalizeModelRef(request);
  let prepared = await prepareEmbeddedOpenClawRun({ request, emit, modelRef });

  const emitAndRemember: EmitEvent = (type, payload) => {
    rememberBrowserRuntimeEvent(params.loopState, type, payload);
    emit(type, payload);
  };

  const initialResult = await executePreparedEmbeddedOpenClawRun({
    prepared,
    emit: emitAndRemember,
    signal: params.signal,
  });
  if (hasTerminalIncident(params.loopState)) {
    return terminalIncidentResult(request, params.loopState, initialResult);
  }
  if (shouldRecoverBrowserChannel(initialResult)) {
    const recoveryCount = Number(params.loopState.browserTimeoutRecoveryCount || 0);
    if (recoveryCount >= 2) {
      emit("run.log", {
        level: "warn",
        source: "runtime",
        message:
          "Browser channel timeout recurred after recovery. Not retrying again in this run.",
        createdAt: nowIso(),
      });
      return initialResult;
    }
    params.loopState.browserTimeoutRecoveryCount = recoveryCount + 1;
    emit("run.log", {
      level: "warn",
      source: "runtime",
      message:
        recoveryCount === 0
          ? "Detected browser channel timeout/unavailability from OpenClaw. Restarting browser daemon and retrying from the last good observation."
          : "Browser channel timed out again after foreground-snapshot recovery. Restarting browser daemon and retrying once more with labeled-screenshot guidance.",
      createdAt: nowIso(),
    });
    await restartEmbeddedBrowserBridgeDaemons();
    const recovered = await executePreparedEmbeddedOpenClawRun({
      prepared,
      request: {
        ...request,
        text: buildBrowserTimeoutRecoveryPrompt(
          request,
          params.loopState,
          params.loopState.browserTimeoutRecoveryCount || 1,
        ),
      },
      emit: emitAndRemember,
      signal: params.signal,
    });
    if (hasTerminalIncident(params.loopState)) {
      return terminalIncidentResult(request, params.loopState, recovered);
    }
    return recovered;
  }
  const transientFailure = classifyTransientModelFailure(initialResult);
  if (transientFailure) {
    emit("run.log", {
      level: "warn",
      source: "runtime",
      message: transientFailureLogMessage(transientFailure),
      createdAt: nowIso(),
    });
    const retryBackoffMs = transientFailureBackoffMs(transientFailure);
    if (retryBackoffMs > 0) {
      await sleep(retryBackoffMs);
    }
    prepared = await prepareEmbeddedOpenClawRetryRun({ prepared, emit });
    const retried = await executePreparedEmbeddedOpenClawRun({
      prepared,
      emit: emitAndRemember,
      signal: params.signal,
    });
    if (hasTerminalIncident(params.loopState)) {
      return terminalIncidentResult(request, params.loopState, retried);
    }
    const persistentTransientFailure = classifyTransientModelFailure(retried);
    if (persistentTransientFailure) {
      return withTransientFailureMetadata(retried, persistentTransientFailure);
    }
    return retried;
  }
  if (looksLikeCapabilityRefusal(initialResult)) {
    params.emit("run.log", {
      level: "info",
      source: "runtime",
      message:
        "OpenClaw returned a generic capability refusal; retrying once with upstream agent-browser guidance injected into the prompt.",
      createdAt: nowIso(),
    });
    const browserFirstPrompt = await buildBrowserFirstPrompt(request);
    const retried = await executePreparedEmbeddedOpenClawRun({
      prepared,
      request: { ...request, text: browserFirstPrompt },
      emit: emitAndRemember,
      signal: params.signal,
    });
    if (hasTerminalIncident(params.loopState)) {
      return terminalIncidentResult(request, params.loopState, retried);
    }
    return retried;
  }
  return initialResult;
}

export async function executeAgentBrowserSteps(params: {
  cdpUrl: string;
  runId: string;
  steps: BrowserExecutionStep[];
  loopState: LoopState;
  emit: EmitEvent;
}): Promise<AgentBrowserBatchResult> {
  const stepPrompt = [
    "Execute the task using the browser based on the following intended steps.",
    "Treat them as hints, not as an authoritative plan.",
    "",
    ...params.steps.map((step, index) => {
      const command = String(step.command || step.action || "unknown").trim();
      const description = String(step.description || "").trim();
      return `${index + 1}. ${command}${description ? ` - ${description}` : ""}`;
    }),
  ].join("\n");
  return await executePromptBrowserRun({
    request: {
      runId: params.runId,
      sessionId: params.runId,
      text: stepPrompt,
      browser: { mode: "cdp", cdpUrl: params.cdpUrl },
      context: { userId: "system" },
    },
    loopState: params.loopState,
    emit: params.emit,
  });
}
