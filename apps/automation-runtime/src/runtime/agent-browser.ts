import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeEvent } from "../contracts/events.js";
import type { BrowserExecutionStep, AutomationRuntimeRunRequest } from "../contracts/run.js";
import { loadRuntimeConfig } from "./config.js";
import {
  executePreparedEmbeddedRuntimeRun,
  prepareEmbeddedRuntimeRetryRun,
  prepareEmbeddedRuntimeRun,
  restartEmbeddedBrowserBridgeDaemons,
} from "./embedded-runtime-runner.js";

export type AgentBrowserBatchResult = {
  success: boolean;
  rows: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  error?: string;
};

type EmitEvent = (type: RuntimeEvent["type"], payload: Record<string, unknown>) => void;

export type PromptBrowserRunHooks = {
  runJsonCommand?: (args: string[]) => Promise<Record<string, unknown>>;
  planNextAction?: (context: {
    request: AutomationRuntimeRunRequest;
    snapshot: Record<string, unknown>;
    loopState: LoopState;
  }) => Promise<Record<string, unknown> | null>;
  prepareRun?: typeof prepareEmbeddedRuntimeRun;
  prepareRetryRun?: typeof prepareEmbeddedRuntimeRetryRun;
  executePreparedRun?: typeof executePreparedEmbeddedRuntimeRun;
};

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
  refs?: Array<{
    ref: string;
    role?: string;
    name?: string;
  }>;
};

type BrowserActionMemory = {
  capturedAt: string;
  operation?: string;
  mutating: boolean;
  target?: string;
  value?: string;
};

type ObservationRecoveryPlan = {
  snapshotRequest: Record<string, unknown>;
  retryGuidance?: string;
  retryContract?: Record<string, unknown>;
  reason?: string;
  recoveredObservation?: Record<string, unknown>;
};

type ToolErrorRecovery = {
  toolName: string;
  meta?: string;
  error?: string;
  mutatingAction?: boolean;
  actionFingerprint?: string;
};

export type LoopState = {
  lastBrowserObservation?: BrowserObservationMemory;
  lastBrowserAction?: BrowserActionMemory;
  browserObservationsByTarget?: Record<string, BrowserObservationMemory>;
  activeBrowserTargetId?: string;
  browserTimeoutRecoveryCount?: number;
  browserObservationRecoveryCount?: number;
  browserToolErrorRecoveryCount?: number;
  pendingObservationRecovery?: ObservationRecoveryPlan;
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
    browserObservationRecoveryCount: 0,
    browserToolErrorRecoveryCount: 0,
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
  const structuredEntities = asRecord(request.goalHints?.entities) || {};
  const executionContract = asRecord(request.goalHints?.executionContract) || {};
  const structuredHints = {
    app: typeof request.goalHints?.app === "string" ? request.goalHints?.app : undefined,
    entities: structuredEntities,
    requiredInputs: Array.isArray(executionContract.required_inputs)
      ? executionContract.required_inputs
      : undefined,
    targetEntities: asRecord(executionContract.target_entities) || undefined,
  };
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
    "When a visible surface contains multiple editable controls, progress one unresolved control at a time. Re-snapshot after each field change before choosing the next control.",
    "Do not re-enter the same value into the same control unless the fresh snapshot still shows that control as unresolved.",
    "Once a foreground form or editor is open, stay anchored to that surface and advance field-by-field instead of revisiting earlier controls.",
    "When structured task values are available, map each value to the most semantically matching visible control from the latest snapshot and apply them one at a time.",
    "If structured task values are available but the current page is still a listing, inbox, results view, or home surface rather than an editor or form, first open the create, compose, new, reply, or equivalent entry surface using a visible control by ref. Do not type those task values into mailbox search, page search, result filters, or unrelated helper inputs.",
    "Never substitute a generic action such as \"fill the current form\" or \"click the current page control\" when the latest snapshot already exposes concrete refs for the relevant controls.",
    "On ref-rich form or editor surfaces, prefer named destination fields over auxiliary search fields, suggestion listboxes, formatting controls, or helper widgets.",
    "Do not type into a searchbox, listbox, or suggestion field unless the task is actually searching or filtering within the current surface.",
    "If the snapshot exposes multiple editable refs, choose the control whose visible name best matches the next structured value to apply.",
    "If the snapshot exposes multiple editable refs, do not use a generic fill action. Use one concrete type or select action on a single named field ref, then re-snapshot.",
    "On listing, catalog, or search-result surfaces, if a needed filter or result control is not yet visible, first capture a scoped interactive snapshot of the filter rail, sidebar, complementary region, or results container.",
    "Once a concrete ref exists on a catalog or results surface, prefer scrollIntoView(ref), click(ref), or select(ref) instead of generic page scrolling.",
    "",
    "## Structured task hints",
    "```json",
    JSON.stringify(structuredHints, null, 2),
    "```",
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

function extractObservationRefs(
  value: unknown,
): Array<{ ref: string; role?: string; name?: string }> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const refs = asRecord(record.refs);
  if (!refs) {
    return undefined;
  }
  const entries = Object.entries(refs)
    .map(([ref, meta]) => {
      const metaRecord = asRecord(meta);
      return {
        ref,
        role: typeof metaRecord?.role === "string" ? metaRecord.role.trim() : undefined,
        name: typeof metaRecord?.name === "string" ? metaRecord.name.trim() : undefined,
      };
    })
    .filter((entry) => entry.ref);
  return entries.length ? entries.slice(0, 50) : undefined;
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
  const refs = extractObservationRefs(record);

  if (snapshotText || format || targetId || url || refCount || refs?.length) {
    return {
      capturedAt: nowIso(),
      url,
      title,
      targetId,
      format,
      snapshotText,
      refCount,
      refs,
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
    refs: candidate.refs?.length ? candidate.refs : current.refs,
  };
}

function observationClickableNamedRefCount(
  observation: BrowserObservationMemory | undefined,
): number {
  const clickableRoles = new Set([
    "link",
    "button",
    "checkbox",
    "radio",
    "option",
    "menuitem",
    "switch",
    "tab",
  ]);
  return (observation?.refs || []).filter((entry) => {
    const role = String(entry.role || "").trim().toLowerCase();
    const name = String(entry.name || "").trim();
    return clickableRoles.has(role) && Boolean(name);
  }).length;
}

function observationLooksLikeWeakFocusedSubsurface(
  observation: BrowserObservationMemory | undefined,
): boolean {
  if (!observation) {
    return false;
  }
  const refCount = typeof observation.refCount === "number" ? observation.refCount : 0;
  const refs = observation.refs || [];
  if (refCount > 2 || refs.length > 2) {
    return false;
  }
  const editableRoles = new Set(["textbox", "searchbox", "combobox", "input", "textarea"]);
  return refs.length > 0 && refs.every((entry) => editableRoles.has(String(entry.role || "").trim().toLowerCase()));
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
  const currentUrl = String(current.url || "").trim();
  const candidateUrl = String(candidate.url || "").trim();
  const sameUrl = Boolean(currentUrl && candidateUrl && currentUrl === candidateUrl);
  const currentClickableRefs = observationClickableNamedRefCount(current);
  const candidateClickableRefs = observationClickableNamedRefCount(candidate);
  if (
    sameUrl &&
    urlLooksLikeSearchResults(currentUrl) &&
    currentClickableRefs >= 3 &&
    candidateClickableRefs === 0 &&
    observationLooksLikeWeakFocusedSubsurface(candidate)
  ) {
    return false;
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

function extractBrowserActionTargetFromPayload(payload: Record<string, unknown>): string | undefined {
  const directTarget = typeof payload.target === "string" ? payload.target.trim() : "";
  if (directTarget) {
    return directTarget;
  }
  const directRef = typeof payload.ref === "string" ? payload.ref.trim() : "";
  if (directRef) {
    return directRef;
  }
  const resultRecord = asRecord(payload.result);
  const partialRecord = asRecord(payload.partialResult);
  for (const candidate of [resultRecord, partialRecord]) {
    if (!candidate) {
      continue;
    }
    const target = typeof candidate.target === "string" ? candidate.target.trim() : "";
    if (target) {
      return target;
    }
    const ref = typeof candidate.ref === "string" ? candidate.ref.trim() : "";
    if (ref) {
      return ref;
    }
  }
  return undefined;
}

function extractBrowserActionValueFromPayload(payload: Record<string, unknown>): string | undefined {
  const directValue = typeof payload.value === "string" ? payload.value : undefined;
  if (directValue && directValue.trim()) {
    return directValue.trim();
  }
  const resultRecord = asRecord(payload.result);
  const partialRecord = asRecord(payload.partialResult);
  for (const candidate of [resultRecord, partialRecord]) {
    if (!candidate) {
      continue;
    }
    const value = typeof candidate.value === "string" ? candidate.value : undefined;
    if (value && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
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

function hasFreshObservationAfterLastMutation(loopState: LoopState): boolean {
  const lastAction = loopState.lastBrowserAction;
  if (!lastAction?.mutating) {
    return true;
  }
  const lastObservation = loopState.lastBrowserObservation;
  if (!lastObservation?.capturedAt) {
    return false;
  }
  const actionTime = Date.parse(lastAction.capturedAt);
  const observationTime = Date.parse(lastObservation.capturedAt);
  if (Number.isNaN(actionTime) || Number.isNaN(observationTime)) {
    return false;
  }
  return observationTime > actionTime;
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
    const recoveryPlan = extractObservationRecoveryPlan(payload);
    if (recoveryPlan) {
      loopState.pendingObservationRecovery = recoveryPlan;
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
        if ((mergedObservation.refCount || 0) > 0) {
          loopState.pendingObservationRecovery = undefined;
        }
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
        target: extractBrowserActionTargetFromPayload(payload),
        value: extractBrowserActionValueFromPayload(payload),
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
        target: extractBrowserActionTargetFromPayload(payload),
        value: extractBrowserActionValueFromPayload(payload),
      };
    }
  }
}

export const __testOnly = {
  buildToolErrorRecoveryPrompt,
  buildObservationRecoveryPrompt,
  currentExecutionStepContract,
  currentStepActionMismatchResult,
  extractObservationRecoveryPlan,
  extractLastToolError,
  findObservationCandidate,
  hasFreshObservationAfterLastMutation,
  shouldReplaceObservationMemory,
  runtimeBrowserOperations,
  shouldRecoverFromToolError,
  rememberBrowserRuntimeEvent,
  withTargetedRecoveryContract,
};

function extractObservationRecoveryPlan(payload: Record<string, unknown>): ObservationRecoveryPlan | null {
  const candidates = [
    asRecord(asRecord(payload.result)?.details),
    asRecord(payload.result),
    asRecord(asRecord(payload.partialResult)?.details),
    asRecord(payload.partialResult),
    asRecord(payload),
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (candidate.recoverable !== true || candidate.requiresObservation !== true) {
      continue;
    }
    const snapshotRequest = asRecord(candidate.snapshotRequest);
    if (!snapshotRequest) {
      continue;
    }
    return {
      snapshotRequest,
      retryGuidance: typeof candidate.retryGuidance === "string" ? candidate.retryGuidance : undefined,
      retryContract: asRecord(candidate.retryContract) || undefined,
      reason: typeof candidate.reason === "string" ? candidate.reason : undefined,
      recoveredObservation: asRecord(candidate.recoveredObservation) || undefined,
    };
  }
  return null;
}

function extractLastToolError(result: AgentBrowserBatchResult): ToolErrorRecovery | null {
  const metadata = asRecord(result.metadata);
  const meta = asRecord(metadata?.meta);
  const candidate = asRecord(meta?.lastToolError) || asRecord(metadata?.lastToolError);
  if (!candidate) {
    return null;
  }
  const toolName = String(candidate.toolName || "").trim();
  if (!toolName) {
    return null;
  }
  return {
    toolName,
    meta: typeof candidate.meta === "string" ? candidate.meta : undefined,
    error: typeof candidate.error === "string" ? candidate.error : undefined,
    mutatingAction:
      typeof candidate.mutatingAction === "boolean" ? candidate.mutatingAction : undefined,
    actionFingerprint:
      typeof candidate.actionFingerprint === "string" ? candidate.actionFingerprint : undefined,
  };
}

function actResultError(result: Record<string, unknown> | null | undefined): {
  recoverable: boolean;
  reason: string;
  snapshotRequest?: Record<string, unknown>;
  retryContract?: Record<string, unknown>;
  recoveredObservation?: Record<string, unknown>;
} | null {
  const record = asRecord(result);
  if (!record) {
    return null;
  }
  const candidate = asRecord(record.details) || record;
  if (!candidate || candidate.ok !== false) {
    return null;
  }
  const reason =
    typeof candidate.reason === "string"
      ? candidate.reason
      : typeof candidate.error === "string"
        ? candidate.error
        : typeof candidate.message === "string"
          ? candidate.message
          : "The browser action was rejected by the runtime tool contract.";
  return {
    recoverable: candidate.recoverable === true || candidate.requiresObservation === true,
    reason,
    snapshotRequest:
      asRecord(asRecord(candidate.snapshotRequest)?.request) ||
      asRecord(candidate.snapshotRequest) ||
      undefined,
    retryContract: asRecord(candidate.retryContract) || undefined,
    recoveredObservation: asRecord(candidate.recoveredObservation) || undefined,
  };
}

function buildSnapshotCommandFromRecoveryRequest(snapshotRequest: Record<string, unknown>): string[] {
  const request = asRecord(snapshotRequest.request) || snapshotRequest;
  return buildSnapshotCommandFromSequenceItem(request);
}

function shouldRecoverFromToolError(
  result: AgentBrowserBatchResult,
  loopState: LoopState,
): ToolErrorRecovery | null {
  if (result.success) {
    return null;
  }
  const lastToolError = extractLastToolError(result);
  if (!lastToolError) {
    return null;
  }
  if (lastToolError.mutatingAction === false) {
    return null;
  }
  if (!loopState.lastBrowserObservation?.refCount || loopState.lastBrowserObservation.refCount <= 0) {
    return null;
  }
  const normalizedError = String(lastToolError.error || "").trim().toLowerCase();
  if (!normalizedError) {
    return lastToolError;
  }
  if (
    normalizedError.includes("ref-rich") ||
    normalizedError.includes("same-value") ||
    normalizedError.includes("same value") ||
    normalizedError.includes("concrete editable") ||
    normalizedError.includes("concrete ref") ||
    normalizedError.includes("current form") ||
    normalizedError.includes("current page control")
  ) {
    return lastToolError;
  }
  return null;
}

function buildObservationRecoveryPrompt(
  request: AutomationRuntimeRunRequest,
  loopState: LoopState,
  recovery: ObservationRecoveryPlan,
): string {
  const observation = loopState.lastBrowserObservation;
  const action = loopState.lastBrowserAction;
  const contextLines = [
    "The last browser attempt produced a recoverable observation failure.",
    "Retry from the current live page state using the scoped observation contract below.",
    "Do not use generic page-level clicks, scrolls, or vague controls until a fresh scoped snapshot produces refs.",
    "On listing, catalog, or search-result surfaces, prefer a scoped snapshot of the filter rail, sidebar, complementary region, or results container before acting again.",
    "If the desired filter or result control is off-screen after that observation, use scrollIntoView on the concrete ref instead of generic page scrolling.",
    "After the scoped snapshot succeeds, continue only with concrete ref-based actions from that new observation.",
    "If the fresh scoped observation exposes multiple editable controls, update one unresolved control, re-snapshot, and only then move to the next control.",
  ];
  if (recovery.reason) {
    contextLines.push(`Recovery reason: ${recovery.reason}`);
  }
  if (recovery.retryGuidance) {
    contextLines.push(`Recovery guidance: ${recovery.retryGuidance}`);
  }
  if (observation?.url) {
    contextLines.push(`Last observed URL: ${observation.url}`);
  }
  if (observation?.title) {
    contextLines.push(`Last observed title: ${observation.title}`);
  }
  if (typeof observation?.refCount === "number") {
    contextLines.push(`Last observed ref count: ${observation.refCount}`);
  }
  if (action?.operation) {
    contextLines.push(`Last browser action: ${action.operation}`);
  }
  if (action?.target) {
    contextLines.push(`Last browser action target: ${action.target}`);
  }
  if (action?.value) {
    contextLines.push(`Last browser action value: ${action.value}`);
  }
  return [
    request.text.trim(),
    "",
    "## Scoped observation recovery",
    ...contextLines,
    "",
    "### Snapshot request",
    "```json",
    JSON.stringify(recovery.snapshotRequest, null, 2),
    "```",
    ...(recovery.retryContract
      ? [
          "",
          "### Retry contract",
          "```json",
          JSON.stringify(recovery.retryContract, null, 2),
          "```",
        ]
      : []),
  ].join("\n");
}

function buildToolErrorRecoveryPrompt(
  request: AutomationRuntimeRunRequest,
  loopState: LoopState,
  toolError: ToolErrorRecovery,
): string {
  const observation = loopState.lastBrowserObservation;
  const action = loopState.lastBrowserAction;
  const contextLines = [
    "The last browser tool action failed on the current live UI surface.",
    "Recover from the current page state without restarting the workflow.",
    "Start with one fresh snapshot of the current foreground surface before the next mutating action.",
    "Then choose exactly one concrete ref that semantically matches the next unresolved destination control.",
    "Do not use generic form-fill or current-page-control actions on this retry.",
    "Do not re-enter the same value into the same control unless the fresh snapshot still shows that control unresolved.",
  ];
  if (toolError.error) {
    contextLines.push(`Last tool failure: ${toolError.error}`);
  }
  if (toolError.meta) {
    contextLines.push(`Last tool summary: ${toolError.meta}`);
  }
  if (observation?.url) {
    contextLines.push(`Last observed URL: ${observation.url}`);
  }
  if (observation?.title) {
    contextLines.push(`Last observed title: ${observation.title}`);
  }
  if (typeof observation?.refCount === "number") {
    contextLines.push(`Last observed ref count: ${observation.refCount}`);
  }
  if (action?.operation) {
    contextLines.push(`Last browser action: ${action.operation}`);
  }
  if (action?.target) {
    contextLines.push(`Last browser action target: ${action.target}`);
  }
  if (action?.value) {
    contextLines.push(`Last browser action value: ${action.value}`);
  }
  const catalogTargets = suggestCatalogTargets(request, observation);
  if (catalogTargets.length) {
    contextLines.push(
      "The last generic catalog action already failed. Do not issue another generic page scroll, broad snapshot, browser evaluate, or vague page-control click now.",
    );
    contextLines.push("Use these visible ref-backed catalog controls for the next retry:");
    for (const target of catalogTargets) {
      contextLines.push(
        `- ${target.key}: ${target.action} ref ${target.ref}${target.name ? ` (${target.name})` : ""}${
          target.value ? ` => ${target.value}` : ""
        }`,
      );
    }
    const firstTarget = catalogTargets[0];
    contextLines.push(
      `Next required action: use ${firstTarget.action} on ref ${firstTarget.ref}${
        firstTarget.name ? ` (${firstTarget.name})` : ""
      }. If it is not visible enough to interact, use scrollIntoView on that same ref first, then ${
        firstTarget.action
      } it. After that single action, take a fresh snapshot before doing anything else.`,
    );
    contextLines.push(
      "Do not use another generic scroll, generic page control click, or browser evaluate before completing that exact next ref-backed action.",
    );
  } else if (extractCatalogTargetEntries(request).length) {
    contextLines.push(
      "The current results snapshot does not yet expose the needed filter controls as usable refs.",
    );
    contextLines.push(
      "Next required action: take one scoped interactive snapshot using the first selector from this ordered list that returns usable refs: aside, [role='complementary'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter'], [role='search'], form, [role='main'], main.",
    );
    contextLines.push(
      "Call the browser tool with action=\"snapshot\", interactive=true, compact=true, refs=\"aria\", and one of those selectors. Do not use generic page scrolling, browser evaluate, or vague page-control clicks before that scoped snapshot.",
    );
  }
  const structuredTargets = suggestStructuredFieldTargets(request, observation);
  if (structuredTargets.length) {
    contextLines.push("Use these visible ref-backed controls for the next retry:");
    for (const target of structuredTargets) {
      contextLines.push(
        `- ${target.key}: ref ${target.ref}${target.name ? ` (${target.name})` : ""}${
          target.value ? ` => ${target.value}` : ""
        }`,
      );
    }
    contextLines.push(
      "Apply them in that order, one control at a time. After each successful field update, capture a fresh snapshot before moving to the next control.",
    );
    const firstTarget = structuredTargets[0];
    contextLines.push(
      `Next required action: use type on ref ${firstTarget.ref}${
        firstTarget.name ? ` (${firstTarget.name})` : ""
      } with value "${firstTarget.value}". After that single action, take a fresh snapshot before doing anything else.`,
    );
    contextLines.push(
      "Do not click any auxiliary controls, helper fields, listboxes, or links before completing that exact next required action.",
    );
  } else {
    const primaryCompletionTarget = suggestPrimaryCompletionTarget(request, observation);
    if (primaryCompletionTarget) {
      contextLines.push("The required field values are already on the active form; advance using the visible primary completion control.");
      contextLines.push(
        `Next required action: use click on ref ${primaryCompletionTarget.ref}${
          primaryCompletionTarget.name ? ` (${primaryCompletionTarget.name})` : ""
        }, then take a fresh snapshot before doing anything else.`,
      );
      contextLines.push(
        "Do not return to earlier fields, helper controls, or generic page actions before completing that exact next click.",
      );
    }
  }
  return [
    request.text.trim(),
    "",
    "## Tool error recovery",
    ...contextLines,
  ].join("\n");
}

function extractStructuredFieldEntries(
  request: AutomationRuntimeRunRequest,
): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = [];
  const pushEntries = (source: Record<string, unknown> | null) => {
    if (!source) {
      return;
    }
    for (const [key, rawValue] of Object.entries(source)) {
      const value =
        typeof rawValue === "string"
          ? rawValue.trim()
          : typeof rawValue === "number" || typeof rawValue === "boolean"
            ? String(rawValue)
            : "";
      if (!value) {
        continue;
      }
      if (["app", "application", "site", "url", "website"].includes(key.toLowerCase())) {
        continue;
      }
      entries.push({ key, value });
    }
  };
  pushEntries(asRecord(request.goalHints?.entities));
  const contract = asRecord(request.goalHints?.executionContract);
  pushEntries(asRecord(contract?.target_entities));
  return entries;
}

function fieldKeyTokens(key: string): string[] {
  const normalized = key.trim().toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const synonyms = new Set(tokens);
  if (tokens.includes("recipient") || tokens.includes("to")) {
    ["recipient", "recipients", "to", "email", "address"].forEach((token) => synonyms.add(token));
  }
  if (tokens.includes("subject") || tokens.includes("title")) {
    ["subject", "title"].forEach((token) => synonyms.add(token));
  }
  if (
    tokens.includes("body") ||
    tokens.includes("message") ||
    tokens.includes("content") ||
    tokens.includes("description")
  ) {
    ["body", "message", "content", "text", "details", "description"].forEach((token) =>
      synonyms.add(token),
    );
  }
  return Array.from(synonyms);
}

function isEditableObservationRef(
  refEntry: { ref: string; role?: string; name?: string } | undefined,
): boolean {
  const role = String(refEntry?.role || "").trim().toLowerCase();
  return new Set(["textbox", "searchbox", "combobox", "input", "textarea"]).has(role);
}

function isCatalogActionableObservationRef(
  refEntry: { ref: string; role?: string; name?: string } | undefined,
): boolean {
  const role = String(refEntry?.role || "").trim().toLowerCase();
  const name = String(refEntry?.name || "").trim().toLowerCase();
  if (!new Set(["link", "button", "checkbox", "radio", "option", "menuitem", "tab", "switch"]).has(role)) {
    return false;
  }
  if (role !== "link") {
    return true;
  }
  if (!name) {
    return false;
  }
  if (
    name.includes("sizes:") ||
    name.includes("rs.") ||
    name.includes("% off") ||
    name.includes("only few left") ||
    name.length > 64
  ) {
    return false;
  }
  return true;
}

function completionActionTokens(request: AutomationRuntimeRunRequest): string[] {
  const normalized = String(request.text || "").trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const tokens = new Set<string>();
  if (normalized.includes("send")) {
    tokens.add("send");
  }
  if (normalized.includes("submit")) {
    tokens.add("submit");
  }
  if (normalized.includes("post")) {
    tokens.add("post");
  }
  if (normalized.includes("save")) {
    tokens.add("save");
  }
  if (normalized.includes("confirm")) {
    tokens.add("confirm");
  }
  if (normalized.includes("continue")) {
    tokens.add("continue");
  }
  if (normalized.includes("next")) {
    tokens.add("next");
  }
  return Array.from(tokens);
}

function suggestPrimaryCompletionTarget(
  request: AutomationRuntimeRunRequest,
  observation: BrowserObservationMemory | undefined,
): { ref: string; name?: string; action: "click" } | null {
  const tokens = completionActionTokens(request);
  const refs = observation?.refs || [];
  if (!tokens.length || !refs.length) {
    return null;
  }
  const match = refs
    .map((refEntry) => {
      const role = String(refEntry.role || "").trim().toLowerCase();
      if (!new Set(["button", "link", "menuitem", "tab"]).has(role)) {
        return null;
      }
      const name = String(refEntry.name || "").trim().toLowerCase();
      if (!name) {
        return null;
      }
      let score = 0;
      for (const token of tokens) {
        if (name.includes(token)) {
          score += 3;
        }
      }
      if (role === "button") {
        score += 1;
      }
      return score > 0 ? { refEntry, score } : null;
    })
    .filter((candidate): candidate is { refEntry: { ref: string; role?: string; name?: string }; score: number } => Boolean(candidate))
    .sort((left, right) => right.score - left.score)[0];
  if (!match) {
    return null;
  }
  return {
    ref: match.refEntry.ref,
    name: match.refEntry.name,
    action: "click",
  };
}

function normalizeCatalogValue(value: string): string[] {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const synonyms = new Set(tokens);
  if (tokens.includes("under")) {
    ["under", "below", "max", "upto", "up", "to"].forEach((token) => synonyms.add(token));
  }
  if (tokens.includes("rating") || tokens.includes("star") || tokens.includes("stars")) {
    ["rating", "ratings", "star", "stars"].forEach((token) => synonyms.add(token));
  }
  if (tokens.includes("price") || /\d/.test(normalized)) {
    ["price", "rs", "inr"].forEach((token) => synonyms.add(token));
  }
  return Array.from(synonyms);
}

function extractCatalogTargetsFromPrompt(
  prompt: string,
): Array<{ key: string; value: string; preferredAction: "click" | "select" }> {
  const text = String(prompt || "").trim().toLowerCase();
  if (!text) {
    return [];
  }
  const entries: Array<{ key: string; value: string; preferredAction: "click" | "select" }> = [];
  const seen = new Set<string>();
  const push = (key: "size" | "price" | "rating" | "brand" | "color", value: string, preferredAction: "click" | "select") => {
    const normalizedValue = String(value || "").trim();
    if (!normalizedValue) {
      return;
    }
    const dedupeKey = `${key}:${normalizedValue.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    entries.push({ key, value: normalizedValue, preferredAction });
  };

  const sizeMatch = text.match(/\bsize\s+([a-z0-9]+)\b/i);
  if (sizeMatch) {
    push("size", sizeMatch[1], "click");
  }

  const underPriceMatch = text.match(/\b(?:price\s+)?(?:under|below|less than|upto|up to|max(?:imum)?)\s*(?:rs\.?\s*|inr\s*)?(\d[\d,]*)\b/i);
  if (underPriceMatch) {
    const amount = underPriceMatch[1].replace(/,/g, "");
    push("price", `under ${amount}`, "select");
  }

  const ratingMatch = text.match(/\b(\d(?:\.\d)?)\s*(?:stars?|star)\s*(?:and above|or above|\+|plus)?\b/i);
  if (ratingMatch) {
    const threshold = ratingMatch[1];
    const suffix = /(and above|or above|\+|plus)/i.test(ratingMatch[0]) ? " and above" : "";
    push("rating", `${threshold} star${Number(threshold) === 1 ? "" : "s"}${suffix}`, "click");
  }

  const colorMatch = text.match(/\b(black|white|blue|red|green|grey|gray|brown|navy|pink|yellow)\b/i);
  if (colorMatch) {
    push("color", colorMatch[1], "click");
  }

  const brandMatch = text.match(/\b(?:brand|from)\s+([a-z][a-z0-9& .-]{1,40})\b/i);
  if (brandMatch) {
    push("brand", brandMatch[1].trim(), "click");
  }

  return entries;
}

function requestedCatalogFilterCount(prompt: string): number {
  const text = String(prompt || "").trim().toLowerCase();
  if (!text) {
    return 0;
  }
  const explicitCount = text.match(/\b(\d+)\s+filters?\b/i);
  if (explicitCount) {
    const count = Number.parseInt(explicitCount[1] || "0", 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  }
  if (/\bapply\b.*\bfilters?\b/i.test(text)) {
    return 1;
  }
  return 0;
}

function extractCatalogTargetEntries(
  request: AutomationRuntimeRunRequest,
): Array<{ key: string; value: string; preferredAction: "click" | "select" }> {
  const entries: Array<{ key: string; value: string; preferredAction: "click" | "select" }> = [];
  const seen = new Set<string>();
  const pushEntry = (key: string, rawValue: unknown) => {
    const rawKey = String(key || "").trim().toLowerCase();
    let normalizedKey = rawKey;
    for (const candidate of ["color", "size", "price", "brand", "rating"]) {
      if (rawKey === candidate || rawKey.includes(candidate)) {
        normalizedKey = candidate;
        break;
      }
    }
    const value =
      typeof rawValue === "string"
        ? rawValue.trim()
        : typeof rawValue === "number" || typeof rawValue === "boolean"
          ? String(rawValue)
          : "";
    if (!normalizedKey || !value) {
      return;
    }
    if (!["color", "size", "price", "brand", "rating"].includes(normalizedKey)) {
      return;
    }
    const dedupeKey = `${normalizedKey}:${value.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    entries.push({
      key: normalizedKey,
      value,
      preferredAction: normalizedKey === "price" ? "select" : "click",
    });
  };

  const contract = asRecord(request.goalHints?.executionContract);
  const stepConstraints = asRecord(asRecord(contract?.current_execution_step)?.target_constraints);
  const filters = asRecord(stepConstraints?.filters);
  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      pushEntry(key, value);
    }
  }
  const predictedPlan = asRecord(contract?.predicted_plan);
  const phases = Array.isArray(predictedPlan?.phases) ? predictedPlan.phases : [];
  for (const phase of phases) {
    const phaseRecord = asRecord(phase);
    const label = String(phaseRecord?.label || "").trim();
    const filterPhraseMatch = /^apply filter:\s*(.+)$/i.exec(label);
    if (!filterPhraseMatch) {
      continue;
    }
    const phrase = filterPhraseMatch[1].trim();
    const normalizedPhrase = phrase.toLowerCase();
    let matched = false;
    for (const candidate of ["rating", "price", "size", "color", "brand"]) {
      const index = normalizedPhrase.indexOf(candidate);
      if (index < 0) {
        continue;
      }
      pushEntry(candidate, phrase.slice(index + candidate.length).trim());
      matched = true;
      break;
    }
    if (!matched) {
      const genericMatch = /^([^:]+?)\s+(.+)$/.exec(phrase);
      if (genericMatch) {
        pushEntry(genericMatch[1], genericMatch[2]);
      }
    }
  }

  for (const source of [asRecord(contract?.target_entities), asRecord(request.goalHints?.entities)]) {
    if (!source) {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      pushEntry(key, value);
    }
  }
  for (const entry of extractCatalogTargetsFromPrompt(request.text)) {
    pushEntry(entry.key, entry.value);
  }
  return entries;
}

function suggestCatalogTargets(
  request: AutomationRuntimeRunRequest,
  observation: BrowserObservationMemory | undefined,
): Array<{ key: string; value: string; ref: string; name?: string; action: "click" | "select" }> {
  const refs = observation?.refs?.filter(isCatalogActionableObservationRef) || [];
  if (!refs.length) {
    return [];
  }
  const targets = extractCatalogTargetEntries(request);
  if (!targets.length) {
    return [];
  }
  const usedRefs = new Set<string>();
  const suggestions: Array<{ key: string; value: string; ref: string; name?: string; action: "click" | "select" }> = [];
  for (const target of targets) {
    const tokens = new Set([target.key, ...normalizeCatalogValue(target.value)]);
    const match = refs
      .filter((refEntry) => !usedRefs.has(refEntry.ref))
      .map((refEntry) => {
        const haystack = `${refEntry.name || ""} ${refEntry.role || ""}`.toLowerCase();
        let score = 0;
        for (const token of tokens) {
          if (token && haystack.includes(token)) {
            score += token === target.key ? 1 : 2;
          }
        }
        if (target.key === "price") {
          for (const digit of target.value.match(/\d+/g) || []) {
            if (haystack.includes(digit)) {
              score += 3;
            }
          }
        }
        if (target.key === "size") {
          const normalizedValue = target.value.trim().toLowerCase();
          if (haystack.includes(`size ${normalizedValue}`) || haystack.includes(` ${normalizedValue} `)) {
            score += 3;
          }
        }
        return { refEntry, score };
      })
      .filter((candidate) => candidate.score > 1)
      .sort((left, right) => right.score - left.score)[0];
    if (!match) {
      continue;
    }
    usedRefs.add(match.refEntry.ref);
    suggestions.push({
      key: target.key,
      value: target.value,
      ref: match.refEntry.ref,
      name: match.refEntry.name,
      action: target.preferredAction,
    });
  }
  return suggestions;
}

function suggestGenericCatalogFilterTargets(
  request: AutomationRuntimeRunRequest,
  observation: BrowserObservationMemory | undefined,
): Array<{ ref: string; name?: string; action: "click" | "select" }> {
  const requestedCount = requestedCatalogFilterCount(request.text);
  if (requestedCount <= 0) {
    return [];
  }
  const refs = observation?.refs || [];
  const preferred = refs.filter((entry) => {
    const role = String(entry.role || "").trim().toLowerCase();
    const name = String(entry.name || "").trim();
    return Boolean(name) && new Set(["checkbox", "radio", "option", "switch"]).has(role);
  });
  const fallback = refs.filter((entry) => {
    const role = String(entry.role || "").trim().toLowerCase();
    const name = String(entry.name || "").trim().toLowerCase();
    if (role !== "button") {
      return false;
    }
    return (
      Boolean(name) &&
      !name.includes("clear") &&
      !name.includes("search") &&
      !name.includes("sort") &&
      !name.includes("wishlist") &&
      !name.includes("bag")
    );
  });
  const candidates = [...preferred, ...fallback];
  return candidates.slice(0, requestedCount).map((entry) => ({
    ref: entry.ref,
    name: entry.name,
    action: String(entry.role || "").trim().toLowerCase() === "option" ? "select" : "click",
  }));
}

function currentExecutionStepRecord(
  request: AutomationRuntimeRunRequest,
): Record<string, unknown> | null {
  const contract = asRecord(request.goalHints?.executionContract);
  const currentStep = asRecord(contract?.current_execution_step);
  return currentStep || null;
}

function currentStepTargetSequence(
  request: AutomationRuntimeRunRequest,
): Array<Record<string, unknown>> {
  const currentStep = currentExecutionStepRecord(request);
  const sequence = Array.isArray(currentStep?.target_sequence) ? currentStep?.target_sequence : [];
  return sequence
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function preferredActionArgsForCurrentStep(
  request: AutomationRuntimeRunRequest,
  snapshot: Record<string, unknown>,
): string[] | null {
  const currentStep = currentExecutionStepRecord(request);
  const kind = String(currentStep?.kind || "").trim().toLowerCase();
  if (!kind) {
    return null;
  }
  const sequence = currentStepTargetSequence(request);
  if (!sequence.length) {
    return null;
  }
  const refs = asRecord(snapshot.refs) || {};
  for (const item of sequence) {
    const ref = String(item.ref || "").trim();
    if (!ref || !refs[ref]) {
      continue;
    }
    const commandRef = ref.startsWith("@") ? ref : `@${ref}`;
    const action = String(item.action || "").trim().toLowerCase();
    if (kind === "filter") {
      if (action === "select") {
        const value = String(item.value || "").trim();
        return value ? ["select", commandRef, value] : ["click", commandRef];
      }
      return ["click", commandRef];
    }
    if (kind === "advance") {
      return ["click", commandRef];
    }
    if (kind === "fill_field") {
      const value = String(item.value || "").trim();
      return value ? ["type", commandRef, value] : null;
    }
  }
  return null;
}

function liveCatalogPreferredActionArgs(
  request: AutomationRuntimeRunRequest,
  snapshot: Record<string, unknown>,
  observation: BrowserObservationMemory | undefined,
): string[] | null {
  const currentStep = currentExecutionStepRecord(request);
  const kind = String(currentStep?.kind || "").trim().toLowerCase();
  const isCatalogStep =
    kind === "filter" ||
    extractCatalogTargetEntries(request).length > 0 ||
    requestedCatalogFilterCount(request.text) > 0;
  if (!isCatalogStep) {
    return null;
  }
  const refs = asRecord(snapshot.refs) || {};
  const explicitTargets = suggestCatalogTargets(request, observation);
  for (const target of explicitTargets) {
    if (!refs[target.ref]) {
      continue;
    }
    const commandRef = target.ref.startsWith("@") ? target.ref : `@${target.ref}`;
    if (target.action === "select") {
      return target.value ? ["select", commandRef, target.value] : ["click", commandRef];
    }
    return ["click", commandRef];
  }
  const genericTargets = suggestGenericCatalogFilterTargets(request, observation);
  for (const target of genericTargets) {
    if (!refs[target.ref]) {
      continue;
    }
    const commandRef = target.ref.startsWith("@") ? target.ref : `@${target.ref}`;
    return [target.action === "select" ? "select" : "click", commandRef];
  }
  return null;
}

function requestLooksLikeSearchFlow(request: AutomationRuntimeRunRequest): boolean {
  const normalized = String(request.text || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("search for") ||
    normalized.includes("look for") ||
    normalized.includes("find ") ||
    normalized.includes("open the first") ||
    normalized.includes("first valid product")
  );
}

function urlLooksLikeSearchResults(url: string | undefined): boolean {
  const raw = String(url || "").trim();
  if (!raw) {
    return false;
  }
  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.includes("search") || pathname.includes("results")) {
      return true;
    }
    return ["q", "query", "search", "keyword", "keywords"].some((key) =>
      parsed.searchParams.has(key),
    );
  } catch {
    const lowered = raw.toLowerCase();
    return (
      lowered.includes("/search") ||
      lowered.includes("/results") ||
      lowered.includes("?q=") ||
      lowered.includes("&q=") ||
      lowered.includes("query=") ||
      lowered.includes("search=") ||
      lowered.includes("keyword=")
    );
  }
}

function observationClickableResultRefs(
  observation: BrowserObservationMemory | undefined,
): Array<{ ref: string; role?: string; name?: string }> {
  const clickableRoles = new Set([
    "link",
    "button",
    "menuitem",
    "option",
    "checkbox",
    "radio",
    "switch",
    "tab",
  ]);
  const editableRoles = new Set(["textbox", "searchbox", "combobox", "input", "textarea"]);
  return (observation?.refs || []).filter((entry) => {
    const role = String(entry.role || "").trim().toLowerCase();
    if (!clickableRoles.has(role) || editableRoles.has(role)) {
      return false;
    }
    return Boolean(String(entry.name || "").trim());
  });
}

function isWeakSearchResultsObservation(
  request: AutomationRuntimeRunRequest,
  snapshot: Record<string, unknown>,
  observation: BrowserObservationMemory | undefined,
): boolean {
  if (!requestLooksLikeSearchFlow(request)) {
    return false;
  }
  const snapshotUrl =
    typeof snapshot.origin === "string"
      ? snapshot.origin
      : typeof snapshot.url === "string"
        ? snapshot.url
        : observation?.url;
  if (!urlLooksLikeSearchResults(snapshotUrl)) {
    return false;
  }
  const refCount = typeof observation?.refCount === "number" ? observation.refCount : 0;
  const clickableResultRefs = observationClickableResultRefs(observation);
  if (clickableResultRefs.length >= 3) {
    return false;
  }
  return refCount <= 2 || clickableResultRefs.length === 0;
}

function buildSearchResultsSnapshotSequence(): Array<Record<string, unknown>> {
  return [
    {
      selector:
        "[role='list'], [role='grid'], [role='feed'], [role='main'] [role='list'], [role='main'] [role='grid'], [aria-label*='results' i], [aria-labelledby*='results' i], [data-testid*='result' i], [data-testid*='results' i], [class*='result' i], [class*='results' i], [class*='product' i], article",
      interactive: true,
      compact: true,
      snapshotFormat: "aria",
      refs: "aria",
    },
    {
      selector:
        "[role='main'], main, [aria-label*='search' i], [aria-labelledby*='search' i], [role='region']",
      interactive: true,
      compact: true,
      snapshotFormat: "aria",
      refs: "aria",
    },
  ];
}

async function applySearchResultsSnapshotSequence(params: {
  request: AutomationRuntimeRunRequest;
  loopState: LoopState;
  currentSnapshot: Record<string, unknown>;
  currentSnapshotText: string;
  emit: EmitEvent;
  runJsonCommand: (args: string[]) => Promise<Record<string, unknown>>;
}): Promise<{
  snapshot: Record<string, unknown>;
  snapshotText: string;
  usedScopedSnapshot: boolean;
}> {
  if (
    !isWeakSearchResultsObservation(
      params.request,
      params.currentSnapshot,
      params.loopState.lastBrowserObservation,
    )
  ) {
    return {
      snapshot: params.currentSnapshot,
      snapshotText: params.currentSnapshotText,
      usedScopedSnapshot: false,
    };
  }

  let bestScopedSnapshot: {
    snapshot: Record<string, unknown>;
    snapshotText: string;
    clickableCount: number;
    refCount: number;
  } | null = null;

  for (const item of buildSearchResultsSnapshotSequence()) {
    const snapshotArgs = buildSnapshotCommandFromSequenceItem(item);
    let scopedSnapshot: Record<string, unknown>;
    try {
      scopedSnapshot = await params.runJsonCommand(snapshotArgs);
    } catch {
      continue;
    }
    const scopedSnapshotText = normalizeSnapshotText(scopedSnapshot);
    params.emit("run.browser.snapshot", {
      result: scopedSnapshot,
      operation: "snapshot",
      createdAt: nowIso(),
    });
    rememberBrowserRuntimeEvent(params.loopState, "run.browser.snapshot", {
      result: scopedSnapshot,
      operation: "snapshot",
    });
    const scopedObservation = params.loopState.lastBrowserObservation;
    const clickableCount = observationClickableResultRefs(scopedObservation).length;
    const refCount = typeof scopedObservation?.refCount === "number" ? scopedObservation.refCount : 0;
    if (
      !bestScopedSnapshot ||
      clickableCount > bestScopedSnapshot.clickableCount ||
      (clickableCount === bestScopedSnapshot.clickableCount && refCount > bestScopedSnapshot.refCount)
    ) {
      bestScopedSnapshot = {
        snapshot: scopedSnapshot,
        snapshotText: scopedSnapshotText,
        clickableCount,
        refCount,
      };
    }
    if (clickableCount >= 3) {
      return {
        snapshot: scopedSnapshot,
        snapshotText: scopedSnapshotText,
        usedScopedSnapshot: true,
      };
    }
  }

  if (bestScopedSnapshot && bestScopedSnapshot.refCount > 0) {
    return {
      snapshot: bestScopedSnapshot.snapshot,
      snapshotText: bestScopedSnapshot.snapshotText,
      usedScopedSnapshot: true,
    };
  }

  return {
    snapshot: params.currentSnapshot,
    snapshotText: params.currentSnapshotText,
    usedScopedSnapshot: false,
  };
}

function buildCatalogSnapshotSequence(): Array<Record<string, unknown>> {
  return [
    {
      selector:
        "fieldset, aside, [role='complementary'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter'], details, summary, [role='group']",
      interactive: true,
      compact: true,
      snapshotFormat: "aria",
      refs: "aria",
    },
    {
      selector: "[role='search'], form, [role='list'], [role='grid'], [role='table'], [role='listbox']",
      interactive: true,
      compact: true,
      snapshotFormat: "aria",
      refs: "aria",
    },
    { selector: "[role='main'], main", interactive: true, compact: true, snapshotFormat: "aria", refs: "aria" },
  ];
}

function catalogSnapshotSelectors(sequence: Array<Record<string, unknown>>): string[] {
  return sequence
    .map((item) => (typeof item.selector === "string" ? item.selector.trim() : ""))
    .filter(Boolean);
}

function buildSnapshotCommandFromSequenceItem(item: Record<string, unknown>): string[] {
  const args = ["snapshot"];
  if (item.interactive !== false) {
    args.push("-i");
  }
  if (item.compact === true) {
    args.push("-c");
  }
  args.push("-d", "8");
  const selector = typeof item.selector === "string" ? item.selector.trim() : "";
  if (selector) {
    args.push("-s", selector);
  }
  return args;
}

async function applyCatalogSnapshotSequence(params: {
  request: AutomationRuntimeRunRequest;
  loopState: LoopState;
  currentSnapshot: Record<string, unknown>;
  currentSnapshotText: string;
  emit: EmitEvent;
  runJsonCommand: (args: string[]) => Promise<Record<string, unknown>>;
}): Promise<{
  snapshot: Record<string, unknown>;
  snapshotText: string;
  usedScopedSnapshot: boolean;
}> {
  const currentStep = currentExecutionStepRecord(params.request);
  if (!currentStep || String(currentStep.kind || "").trim().toLowerCase() !== "filter") {
    return {
      snapshot: params.currentSnapshot,
      snapshotText: params.currentSnapshotText,
      usedScopedSnapshot: false,
    };
  }
  const sequence = Array.isArray(currentStep.snapshot_sequence)
    ? currentStep.snapshot_sequence
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
  if (!sequence.length) {
    return {
      snapshot: params.currentSnapshot,
      snapshotText: params.currentSnapshotText,
      usedScopedSnapshot: false,
    };
  }
  const currentObservation = params.loopState.lastBrowserObservation;
  if (suggestCatalogTargets(params.request, currentObservation).length) {
    return {
      snapshot: params.currentSnapshot,
      snapshotText: params.currentSnapshotText,
      usedScopedSnapshot: false,
    };
  }

  let bestScopedSnapshot: {
    snapshot: Record<string, unknown>;
    snapshotText: string;
    refCount: number;
  } | null = null;

  for (const item of sequence) {
    const snapshotArgs = buildSnapshotCommandFromSequenceItem(item);
    let scopedSnapshot: Record<string, unknown>;
    try {
      scopedSnapshot = await params.runJsonCommand(snapshotArgs);
    } catch {
      continue;
    }
    const scopedSnapshotText = normalizeSnapshotText(scopedSnapshot);
    params.emit("run.browser.snapshot", {
      result: scopedSnapshot,
      operation: "snapshot",
      createdAt: nowIso(),
    });
    rememberBrowserRuntimeEvent(params.loopState, "run.browser.snapshot", {
      result: scopedSnapshot,
      operation: "snapshot",
    });
    const scopedObservation = params.loopState.lastBrowserObservation;
    const scopedRefCount =
      typeof scopedObservation?.refCount === "number" ? scopedObservation.refCount : 0;
    if (!bestScopedSnapshot || scopedRefCount > bestScopedSnapshot.refCount) {
      bestScopedSnapshot = {
        snapshot: scopedSnapshot,
        snapshotText: scopedSnapshotText,
        refCount: scopedRefCount,
      };
    }
    if (suggestCatalogTargets(params.request, params.loopState.lastBrowserObservation).length) {
      return {
        snapshot: scopedSnapshot,
        snapshotText: scopedSnapshotText,
        usedScopedSnapshot: true,
      };
    }
  }

  if (bestScopedSnapshot && bestScopedSnapshot.refCount > 0) {
    return {
      snapshot: bestScopedSnapshot.snapshot,
      snapshotText: bestScopedSnapshot.snapshotText,
      usedScopedSnapshot: true,
    };
  }

  return {
    snapshot: params.currentSnapshot,
    snapshotText: params.currentSnapshotText,
    usedScopedSnapshot: false,
  };
}

function suggestStructuredFieldTargets(
  request: AutomationRuntimeRunRequest,
  observation: BrowserObservationMemory | undefined,
): Array<{ key: string; value: string; ref: string; name?: string }> {
  const refs = observation?.refs?.filter(isEditableObservationRef) || [];
  if (!refs.length) {
    return [];
  }
  const usedRefs = new Set<string>();
  const suggestions: Array<{ key: string; value: string; ref: string; name?: string }> = [];
  for (const entry of extractStructuredFieldEntries(request)) {
    const tokens = fieldKeyTokens(entry.key);
    const match = refs
      .filter((refEntry) => !usedRefs.has(refEntry.ref))
      .map((refEntry) => {
        const haystack = `${refEntry.name || ""} ${refEntry.role || ""}`.toLowerCase();
        const score = tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
        return { refEntry, score };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)[0];
    if (!match) {
      continue;
    }
    usedRefs.add(match.refEntry.ref);
    suggestions.push({
      key: entry.key,
      value: entry.value,
      ref: match.refEntry.ref,
      name: match.refEntry.name,
    });
  }
  return suggestions;
}

function withStructuredFieldRecoveryContract(
  request: AutomationRuntimeRunRequest,
  loopState: LoopState,
): AutomationRuntimeRunRequest {
  const structuredTargets = suggestStructuredFieldTargets(
    request,
    loopState.lastBrowserObservation,
  );
  if (!structuredTargets.length) {
    const primaryCompletionTarget = suggestPrimaryCompletionTarget(
      request,
      loopState.lastBrowserObservation,
    );
    if (!primaryCompletionTarget) {
      return request;
    }
    const goalHints = asRecord(request.goalHints) || {};
    const executionContract = asRecord(goalHints.executionContract) || {};
    return {
      ...request,
      goalHints: {
        ...request.goalHints,
        executionContract: {
          ...executionContract,
          current_execution_step: {
            kind: "advance",
            label: "Complete the visible primary action on the active form",
            allowed_actions: ["snapshot", "click"],
            target_sequence: [
              {
                key: "primary_action",
                ref: primaryCompletionTarget.ref,
                name: primaryCompletionTarget.name,
                action: primaryCompletionTarget.action,
              },
            ],
          },
        },
      },
    };
  }
  const goalHints = asRecord(request.goalHints) || {};
  const executionContract = asRecord(goalHints.executionContract) || {};
  const nextStep = {
    kind: "fill_field",
    label: "Fill the next structured field on the active form",
    allowed_actions: ["snapshot", "type"],
    target_sequence: structuredTargets.map((target) => ({
      key: target.key,
      ref: target.ref,
      name: target.name,
      value: target.value,
    })),
  };
  return {
    ...request,
    goalHints: {
      ...request.goalHints,
      executionContract: {
        ...executionContract,
        current_execution_step: nextStep,
      },
    },
  };
}

function withCatalogRecoveryContract(
  request: AutomationRuntimeRunRequest,
  loopState: LoopState,
): AutomationRuntimeRunRequest {
  const catalogTargets = suggestCatalogTargets(request, loopState.lastBrowserObservation);
  const genericCatalogTargets = suggestGenericCatalogFilterTargets(
    request,
    loopState.lastBrowserObservation,
  );
  const catalogEntries = extractCatalogTargetEntries(request);
  if (!catalogTargets.length && !genericCatalogTargets.length && !catalogEntries.length) {
    return request;
  }
  const goalHints = asRecord(request.goalHints) || {};
  const executionContract = asRecord(goalHints.executionContract) || {};
  const snapshotSequence = buildCatalogSnapshotSequence();
  const nextStep = catalogTargets.length
    ? {
        kind: "filter",
        label: "Apply the next visible catalog control on the active results surface",
        allowed_actions: ["snapshot", "scrollintoview", "click", "select"],
        target_sequence: catalogTargets.map((target) => ({
          key: target.key,
          ref: target.ref,
          name: target.name,
          value: target.value,
          action: target.action,
        })),
      }
    : genericCatalogTargets.length
      ? {
          kind: "filter",
          label: "Apply the next visible filter controls on the active results surface",
          allowed_actions: ["snapshot", "scrollintoview", "click", "select"],
          target_sequence: genericCatalogTargets.map((target, index) => ({
            key: `filter_${index + 1}`,
            ref: target.ref,
            name: target.name,
            action: target.action,
          })),
        }
    : {
        kind: "filter",
        label: "Capture a scoped filter-surface snapshot before the next catalog action",
        allowed_actions: ["snapshot"],
        snapshot_sequence: snapshotSequence,
        target_constraints: {
          filters: Object.fromEntries(catalogEntries.map((entry) => [entry.key, entry.value])),
          snapshot_selectors: catalogSnapshotSelectors(snapshotSequence),
        },
      };
  return {
    ...request,
    goalHints: {
      ...request.goalHints,
      executionContract: {
        ...executionContract,
        current_execution_step: nextStep,
      },
    },
  };
}

function withInitialCatalogExecutionContract(
  request: AutomationRuntimeRunRequest,
): AutomationRuntimeRunRequest {
  if (currentExecutionStepRecord(request)) {
    return request;
  }
  const catalogEntries = extractCatalogTargetEntries(request);
  const genericFilterCount = requestedCatalogFilterCount(request.text);
  if (!catalogEntries.length && genericFilterCount <= 0) {
    return request;
  }
  const goalHints = asRecord(request.goalHints) || {};
  const executionContract = asRecord(goalHints.executionContract) || {};
  const snapshotSequence = buildCatalogSnapshotSequence();
  return {
    ...request,
    goalHints: {
      ...request.goalHints,
      executionContract: {
        ...executionContract,
        current_execution_step: {
          kind: "filter",
          label: "Capture a scoped filter-surface snapshot before the next catalog action",
          allowed_actions: ["snapshot"],
          snapshot_sequence: snapshotSequence,
          target_constraints: {
            filters: Object.fromEntries(catalogEntries.map((entry) => [entry.key, entry.value])),
            filter_count: genericFilterCount > 0 ? genericFilterCount : undefined,
            snapshot_selectors: catalogSnapshotSelectors(snapshotSequence),
          },
        },
      },
    },
  };
}

function withTargetedRecoveryContract(
  request: AutomationRuntimeRunRequest,
  loopState: LoopState,
): AutomationRuntimeRunRequest {
  const catalogRecoveryRequest = withCatalogRecoveryContract(request, loopState);
  if (catalogRecoveryRequest !== request) {
    return catalogRecoveryRequest;
  }
  return withStructuredFieldRecoveryContract(request, loopState);
}

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
    "When the current foreground surface is a form or editor with multiple editable controls, progress one unresolved control at a time and re-snapshot after each field change.",
    "Do not re-enter the same value into the same control unless the fresh snapshot still shows it as unresolved.",
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
  if (action?.target) {
    contextLines.push(`Last browser action target: ${action.target}`);
  }
  if (action?.value) {
    contextLines.push(`Last browser action value: ${action.value}`);
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
    text.includes("restart the runtime gateway") ||
    text.includes("runtime gateway restart")
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

async function probeCdpEndpoint(cdpUrl: string): Promise<string | null> {
  try {
    const response = await fetch(cdpUrl, {
      method: "GET",
      signal: AbortSignal.timeout(1000),
    });
    void response;
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to connect to browser CDP endpoint ${cdpUrl}: ${message}`;
  }
}

function normalizeSnapshotText(snapshot: Record<string, unknown>): string {
  return String(snapshot.snapshot || "").trim();
}

function snapshotHasRefs(snapshot: Record<string, unknown>): boolean {
  const refs = snapshot.refs;
  return Boolean(refs && typeof refs === "object" && Object.keys(refs as Record<string, unknown>).length > 0);
}

const EDITABLE_SURFACE_SELECTOR =
  "input, textarea, [role='searchbox'], [role='textbox'], [role='combobox'], form";

function snapshotStateChanged(previousSnapshotText: string, nextSnapshotText: string): boolean {
  const previous = previousSnapshotText.trim().toLowerCase();
  const next = nextSnapshotText.trim().toLowerCase();
  return Boolean(previous && next && previous !== next);
}

function actionSignature(actionArgs: string[] | null): string {
  if (!actionArgs?.length) {
    return "";
  }
  return actionArgs.map((value) => String(value).trim().toLowerCase()).join("::");
}

function cleanVerifierNeedle(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  const afterColon = trimmed.includes(":") ? trimmed.split(":").slice(1).join(":").trim() : trimmed;
  const lowered = afterColon.toLowerCase();
  if (
    !afterColon ||
    lowered === "visible post-action confirmation is present." ||
    lowered === "visible post-action confirmation is present" ||
    lowered === "a visible post-action state change confirms the action completed." ||
    lowered === "a visible post-action state change confirms the action completed" ||
    lowered === "the editor or compose surface is no longer active." ||
    lowered === "the editor or compose surface is no longer active" ||
    lowered.startsWith("the requested outcome is completed for") ||
    lowered.startsWith("a visible post-action confirmation replaces") ||
    lowered.startsWith("the ui is no longer showing") ||
    lowered.includes("no longer appears")
  ) {
    return "";
  }
  return afterColon.replace(/^["'\s]+|["'\s.]+$/g, "");
}

function explicitVerifierNeedles(request: AutomationRuntimeRunRequest): string[] {
  const contract = asRecord(request.goalHints?.executionContract);
  if (!contract) {
    return [];
  }
  const verificationEvidence = asRecord(contract.verification_evidence);
  const checks = Array.isArray(verificationEvidence?.checks)
    ? (verificationEvidence?.checks as unknown[])
    : [];
  const completionCriteria = Array.isArray(contract.completion_criteria)
    ? (contract.completion_criteria as unknown[])
    : [];
  const expectedStateChange =
    typeof verificationEvidence?.expected_state_change === "string"
      ? verificationEvidence.expected_state_change
      : "";
  const needles = [
    expectedStateChange,
    ...checks.map((item) => String(item || "")),
    ...completionCriteria.map((item) => String(item || "")),
  ]
    .map(cleanVerifierNeedle)
    .filter((item) => item.length >= 3);
  return Array.from(new Set(needles));
}

function currentExecutionStepContract(
  request: AutomationRuntimeRunRequest,
): { kind: string; allowedActions: Set<string> } | null {
  const contract = asRecord(request.goalHints?.executionContract);
  const currentStep = asRecord(contract?.current_execution_step);
  if (!currentStep) {
    return null;
  }
  const kind = String(currentStep.kind || "").trim().toLowerCase();
  const allowedActions = new Set(
    (Array.isArray(currentStep.allowed_actions) ? currentStep.allowed_actions : [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean),
  );
  if (!kind && allowedActions.size === 0) {
    return null;
  }
  return { kind, allowedActions };
}

function runtimeBrowserOperations(result: AgentBrowserBatchResult): string[] {
  const runtimeSummary = asRecord(result.metadata.runtimeSummary);
  return (Array.isArray(runtimeSummary?.browserOperations) ? runtimeSummary.browserOperations : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

function currentStepActionMismatchResult(
  request: AutomationRuntimeRunRequest,
  result: AgentBrowserBatchResult,
): AgentBrowserBatchResult | null {
  const stepContract = currentExecutionStepContract(request);
  if (!stepContract || stepContract.allowedActions.size === 0) {
    return null;
  }
  const disallowedOperation = runtimeBrowserOperations(result).find((operation) => {
    if (operation === "snapshot") {
      return false;
    }
    return !stepContract.allowedActions.has(operation);
  });
  if (!disallowedOperation) {
    return null;
  }
  const reason =
    `Runtime emitted browser action ${disallowedOperation} while active step ${stepContract.kind || "unknown"} only allows ${Array.from(stepContract.allowedActions).join(", ") || "no actions"}.`;
  return {
    ...result,
    success: false,
    metadata: {
      ...result.metadata,
      terminalCode: "STEP_ACTION_MISMATCH",
      terminalIncident: {
        code: "STEP_ACTION_MISMATCH",
        reason,
        replannable: false,
        phase: "planning",
      },
    },
    error: `STEP_ACTION_MISMATCH: ${reason}`,
  };
}

function snapshotMatchesExplicitVerifier(snapshotText: string, needles: string[]): boolean {
  const normalizedSnapshot = snapshotText.trim().toLowerCase();
  if (!normalizedSnapshot || !needles.length) {
    return false;
  }
  return needles.some((needle) => normalizedSnapshot.includes(needle.toLowerCase()));
}

function requestLooksLikeAuthFlow(text: string): boolean {
  const normalized = String(text || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("sign in") ||
    normalized.includes("signin") ||
    normalized.includes("log in") ||
    normalized.includes("login") ||
    normalized.includes("authenticate") ||
    normalized.includes("authorize") ||
    normalized.includes("consent") ||
    normalized.includes("choose account") ||
    normalized.includes("choose an account")
  );
}

function detectForegroundInterruption(params: {
  request: AutomationRuntimeRunRequest;
  snapshot: Record<string, unknown>;
  snapshotText: string;
  previousSnapshotText: string;
  hasPriorProgress: boolean;
}): { terminalCode: "AUTH_REQUIRED" | "HUMAN_REQUIRED"; reason: string } | null {
  const { request, snapshot, snapshotText, previousSnapshotText, hasPriorProgress } = params;
  if (requestLooksLikeAuthFlow(request.text)) {
    return null;
  }
  const stateChanged = snapshotStateChanged(previousSnapshotText, snapshotText);
  if (!hasPriorProgress && !stateChanged) {
    return null;
  }
  const title = String(snapshot.title || "").trim().toLowerCase();
  const url = String(snapshot.origin || snapshot.url || "").trim().toLowerCase();
  const combined = [snapshotText, title, url].join("\n").toLowerCase();

  const authSignals = [
    "choose an account",
    "continue with google",
    "sign in",
    "log in",
    "enter your password",
    "forgot password",
    "verify it's you",
    "2-step verification",
    "two-factor",
    "authentication required",
    "reauthenticate",
  ];
  const consentSignals = [
    "allow access",
    "grant access",
    "permissions requested",
    "permission requested",
    "authorize app",
    "authorization request",
    "consent",
    "allow and continue",
  ];

  if (
    url.includes("accounts.google.com") ||
    url.includes("/signin") ||
    url.includes("/login") ||
    authSignals.some((signal) => combined.includes(signal))
  ) {
    return {
      terminalCode: "AUTH_REQUIRED",
      reason: "Authentication or account selection is required before the task can continue.",
    };
  }
  if (consentSignals.some((signal) => combined.includes(signal))) {
    return {
      terminalCode: "HUMAN_REQUIRED",
      reason: "A consent or permissions prompt needs human review before the task can continue.",
    };
  }
  return null;
}

function genericGoalLooksComplete(params: {
  genericTarget: string;
  snapshot: Record<string, unknown>;
  snapshotText: string;
  previousSnapshotText: string;
}): boolean {
  const { genericTarget, snapshot, snapshotText, previousSnapshotText } = params;
  if (!genericTarget) {
    return false;
  }
  const targetStillActionable = Boolean(
    findRefByName(snapshot, (name) => name.toLowerCase() === genericTarget.toLowerCase()),
  );
  if (targetStillActionable) {
    return false;
  }
  const stateChanged = snapshotStateChanged(previousSnapshotText, snapshotText);
  const targetStillVisible = snapshotText.toLowerCase().includes(genericTarget.toLowerCase());
  if (!targetStillVisible && stateChanged) {
    return true;
  }
  if (!snapshotHasRefs(snapshot) && (stateChanged || targetStillVisible)) {
    return true;
  }
  return false;
}

function findRefByName(snapshot: Record<string, unknown>, matcher: (name: string, role: string) => boolean): string | null {
  const refs = snapshot.refs;
  if (!refs || typeof refs !== "object") {
    return null;
  }
  for (const [ref, rawEntry] of Object.entries(refs as Record<string, unknown>)) {
    if (!rawEntry || typeof rawEntry !== "object") {
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    const name = String(entry.name || "").trim();
    const role = String(entry.role || "").trim().toLowerCase();
    if (matcher(name, role)) {
      return `@${ref}`;
    }
  }
  return null;
}

async function executePromptBrowserRunWithHooks(params: {
  request: AutomationRuntimeRunRequest;
  loopState: LoopState;
  emit: EmitEvent;
}, hooks: PromptBrowserRunHooks): Promise<AgentBrowserBatchResult> {
  const { request, emit, loopState } = params;
  const runJsonCommand = hooks.runJsonCommand;
  if (!runJsonCommand) {
    throw new Error("runJsonCommand hook is required for hook-based browser execution.");
  }

  await runJsonCommand(["connect", request.browser.cdpUrl]);
  const genericTarget =
    /click the (.+?) button/i.exec(request.text)?.[1] ||
    /click (.+)$/i.exec(request.text)?.[1] ||
    /go to (.+)$/i.exec(request.text)?.[1] ||
    "";
  const verifierNeedles = explicitVerifierNeedles(request);

  let observationAttempts = 0;
  let previousSnapshotText = "";
  let lastMutatingActionSignature = "";
  let hasPriorProgress = false;
  let pendingHookRecovery: ObservationRecoveryPlan | null = null;

  for (let step = 0; step < 12; step += 1) {
    let snapshot: Record<string, unknown>;
    const pendingRecovery = pendingHookRecovery || loopState.pendingObservationRecovery;
    if (pendingRecovery?.recoveredObservation) {
      snapshot = pendingRecovery.recoveredObservation;
      pendingHookRecovery = null;
      loopState.pendingObservationRecovery = undefined;
    } else {
      const snapshotArgs = pendingRecovery?.snapshotRequest
        ? buildSnapshotCommandFromRecoveryRequest(pendingRecovery.snapshotRequest)
        : ["snapshot", "-i", "-c", "-d", "8"];
      try {
        snapshot = await runJsonCommand(snapshotArgs);
        if (pendingRecovery) {
          pendingHookRecovery = null;
          loopState.pendingObservationRecovery = undefined;
        }
      } catch (error) {
        return {
          success: false,
          rows: [],
          metadata: { terminalCode: "EXECUTION_FAILED" },
          error: String((error as Error)?.message || error || "Snapshot failed."),
        };
      }
    }
    if (!snapshotHasRefs(snapshot)) {
      try {
        const focusedSnapshot = await runJsonCommand([
          "snapshot",
          "-i",
          "-c",
          "-d",
          "8",
          "-s",
          EDITABLE_SURFACE_SELECTOR,
        ]);
        if (snapshotHasRefs(focusedSnapshot)) {
          snapshot = focusedSnapshot;
        }
      } catch {
        // Keep the original broad snapshot when focused re-observation is unavailable.
      }
    }

    let snapshotText = normalizeSnapshotText(snapshot);
    emit("run.browser.snapshot", {
      result: snapshot,
      operation: "snapshot",
      createdAt: nowIso(),
    });
    rememberBrowserRuntimeEvent(loopState, "run.browser.snapshot", { result: snapshot, operation: "snapshot" });
    const scopedCatalogSnapshot = await applyCatalogSnapshotSequence({
      request,
      loopState,
      currentSnapshot: snapshot,
      currentSnapshotText: snapshotText,
      emit,
      runJsonCommand,
    });
    if (scopedCatalogSnapshot.usedScopedSnapshot) {
      snapshot = scopedCatalogSnapshot.snapshot;
      snapshotText = scopedCatalogSnapshot.snapshotText;
    }
    const scopedSearchResultsSnapshot = await applySearchResultsSnapshotSequence({
      request,
      loopState,
      currentSnapshot: snapshot,
      currentSnapshotText: snapshotText,
      emit,
      runJsonCommand,
    });
    if (scopedSearchResultsSnapshot.usedScopedSnapshot) {
      snapshot = scopedSearchResultsSnapshot.snapshot;
      snapshotText = scopedSearchResultsSnapshot.snapshotText;
    }
    const genericGoalSatisfied = genericGoalLooksComplete({
      genericTarget,
      snapshot,
      snapshotText,
      previousSnapshotText,
    });
    const explicitVerifierSatisfied = snapshotMatchesExplicitVerifier(
      snapshotText,
      verifierNeedles,
    );
    const interruption = detectForegroundInterruption({
      request,
      snapshot,
      snapshotText,
      previousSnapshotText,
      hasPriorProgress,
    });
    if (interruption) {
      emit("run.runtime_incident", {
        code: interruption.terminalCode,
        reason: interruption.reason,
        replannable: false,
        phase: "execution",
        createdAt: nowIso(),
      });
      return {
        success: false,
        rows: [{ text: snapshotText }],
        metadata: { terminalCode: interruption.terminalCode },
        error: `${interruption.terminalCode}: ${interruption.reason}`,
      };
    }
    if (genericGoalSatisfied) {
      return {
        success: true,
        rows: [{ text: snapshotText }],
        metadata: { terminalCode: "COMPLETED" },
      };
    }
    if (explicitVerifierSatisfied) {
      return {
        success: true,
        rows: [{ text: snapshotText }],
        metadata: { terminalCode: "COMPLETED" },
      };
    }

    const planned = hooks.planNextAction
      ? await hooks.planNextAction({ request, snapshot, loopState })
      : null;
    const plannedAction = String(planned?.action || "").trim().toLowerCase();
    const canTrustEmptyUiCompletion =
      verifierNeedles.length === 0 && !snapshotHasRefs(snapshot);
    if (plannedAction === "done" && (genericGoalSatisfied || explicitVerifierSatisfied || canTrustEmptyUiCompletion)) {
      return {
        success: true,
        rows: [{ text: snapshotText }],
        metadata: { terminalCode: "COMPLETED" },
      };
    }

    let actionArgs: string[] | null = null;
    if (plannedAction && plannedAction !== "done" && planned?.ref) {
      const normalizedAction = plannedAction === "scroll" ? "scrollIntoView" : plannedAction;
      actionArgs = [normalizedAction, String(planned.ref)];
      if (planned?.value != null) {
        actionArgs.push(String(planned.value));
      }
    } else {
      const targetRef = genericTarget
        ? findRefByName(snapshot, (name) => name.toLowerCase() === genericTarget.toLowerCase())
        : null;
      if (targetRef) {
        actionArgs = ["click", targetRef];
      }
    }

    const preferredStepAction =
      preferredActionArgsForCurrentStep(request, snapshot) ||
      liveCatalogPreferredActionArgs(request, snapshot, loopState.lastBrowserObservation);
    if (preferredStepAction) {
      const currentStep = currentExecutionStepRecord(request);
      const stepKind = String(currentStep?.kind || "").trim().toLowerCase();
      const currentAction = String(actionArgs?.[0] || "").trim().toLowerCase();
      const currentRef = String(actionArgs?.[1] || "").trim();
      const preferredRef = String(preferredStepAction[1] || "").trim();
      const currentIsConcreteStepAction =
        Boolean(currentRef) &&
        currentRef === preferredRef &&
        ((stepKind === "filter" && ["click", "select", "scrollintoview"].includes(currentAction)) ||
          (stepKind === "advance" && currentAction === "click") ||
          (stepKind === "fill_field" && currentAction === "type"));
      if (!currentIsConcreteStepAction) {
        actionArgs = preferredStepAction;
      }
    }

    if (!actionArgs) {
      observationAttempts += 1;
      if (observationAttempts >= 2) {
        return {
          success: false,
          rows: [{ text: snapshotText }],
          metadata: { terminalCode: "OBSERVATION_EXHAUSTED" },
          error: "OBSERVATION_EXHAUSTED: No actionable browser target remained after repeated observations.",
        };
      }
      continue;
    }

    const nextActionSignature = actionSignature(actionArgs);
    const plannerDirectedAction = Boolean(plannedAction && plannedAction !== "done" && planned?.ref);
    const repeatingMutatingNoOp =
      plannerDirectedAction &&
      isMutatingBrowserOperation(actionArgs[0]) &&
      nextActionSignature &&
      nextActionSignature === lastMutatingActionSignature &&
      !snapshotStateChanged(previousSnapshotText, snapshotText);
    if (repeatingMutatingNoOp) {
      emit("run.runtime_incident", {
        code: "ACTION_STALLED",
        reason:
          "The same mutating browser action was proposed again after an unchanged snapshot. Replanning is required.",
        replannable: false,
        phase: "execution",
        createdAt: nowIso(),
        action: actionArgs[0],
        target: actionArgs[1],
      });
      return {
        success: false,
        rows: [{ text: snapshotText }],
        metadata: { terminalCode: "ACTION_STALLED" },
        error:
          "ACTION_STALLED: Repeated mutating browser action was blocked because the UI did not change after the previous attempt.",
      };
    }

    observationAttempts = 0;
    const actionResult = await runJsonCommand(actionArgs);
    const actionFailure = actResultError(actionResult);
    if (actionFailure) {
      if (actionFailure.recoverable) {
        if (!actionFailure.snapshotRequest && !actionFailure.recoveredObservation) {
          emit("run.runtime_incident", {
            code: "OBSERVATION_UNGROUNDED",
            reason: actionFailure.reason,
            replannable: false,
            phase: "error",
            createdAt: nowIso(),
            action: actionArgs[0],
            target: actionArgs[1],
          });
          loopState.pendingObservationRecovery = {
            snapshotRequest: {
              action: "snapshot",
              request: {
                interactive: true,
                compact: true,
                refs: "aria",
              },
            },
            reason: actionFailure.reason,
          };
          return observationUngroundedResult(request, loopState, loopState.pendingObservationRecovery);
        }
        const recoveryPlan: ObservationRecoveryPlan = {
          snapshotRequest: actionFailure.snapshotRequest || {
            action: "snapshot",
            request: {
              interactive: true,
              compact: true,
              refs: "aria",
            },
          },
          retryContract: actionFailure.retryContract,
          reason: actionFailure.reason,
          recoveredObservation: actionFailure.recoveredObservation,
        };
        pendingHookRecovery = recoveryPlan;
        loopState.pendingObservationRecovery = recoveryPlan;
        if (recoveryPlan.recoveredObservation) {
          emit("run.browser.snapshot", {
            result: recoveryPlan.recoveredObservation,
            operation: "snapshot",
            createdAt: nowIso(),
          });
          rememberBrowserRuntimeEvent(loopState, "run.browser.snapshot", {
            result: recoveryPlan.recoveredObservation,
            operation: "snapshot",
          });
        }
        previousSnapshotText = snapshotText;
        observationAttempts = 0;
        continue;
      }
      emit("run.runtime_incident", {
        code: "ACTION_REJECTED",
        reason: actionFailure.reason,
        replannable: false,
        phase: "error",
        createdAt: nowIso(),
        action: actionArgs[0],
        target: actionArgs[1],
      });
      return {
        success: false,
        rows: [{ text: snapshotText }],
        metadata: { terminalCode: "ACTION_REJECTED" },
        error: `ACTION_REJECTED: ${actionFailure.reason}`,
      };
    }
    emit("run.browser.action", {
      action: actionArgs[0],
      target: actionArgs[1],
      value: actionArgs[2],
      result: actionResult,
      createdAt: nowIso(),
    });
    rememberBrowserRuntimeEvent(loopState, "run.browser.action", {
      action: actionArgs[0],
      target: actionArgs[1],
      value: actionArgs[2],
      result: actionResult,
    });
    if (isMutatingBrowserOperation(actionArgs[0])) {
      await sleep(actionArgs[0] === "press" ? 400 : 250);
    }
    hasPriorProgress = true;
    lastMutatingActionSignature = isMutatingBrowserOperation(actionArgs[0])
      ? nextActionSignature
      : "";

    previousSnapshotText = snapshotText;
  }

  return {
    success: false,
    rows: [],
    metadata: { terminalCode: "OBSERVATION_EXHAUSTED" },
    error: "OBSERVATION_EXHAUSTED: Browser automation exceeded the observation budget.",
  };
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
      return "Detected model rate limiting from Runtime. Backing off briefly and retrying once with a fresh embedded session.";
    case "overloaded":
      return "Detected temporary model overload from Runtime. Backing off briefly and retrying once with a fresh embedded session.";
    case "timeout":
      return "Detected model/network timeout from Runtime. Retrying once with a fresh embedded session.";
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

function observationUngroundedResult(
  request: AutomationRuntimeRunRequest,
  loopState: LoopState,
  recovery?: ObservationRecoveryPlan,
): AgentBrowserBatchResult {
  loopState.terminalIncident = {
    code: "OBSERVATION_UNGROUNDED",
    reason:
      recovery?.reason ||
      "Scoped observation recovery still did not produce actionable refs from the live UI.",
    replannable: false,
    phase: "error",
  };
  return terminalIncidentResult(
    request,
    loopState,
    {
      success: false,
      rows: [],
      metadata: { terminalCode: "OBSERVATION_UNGROUNDED" },
      error:
        "OBSERVATION_UNGROUNDED: Scoped observation recovery still did not produce actionable refs from the live UI.",
    },
  );
}

function withObservedCompletionRequirement(
  result: AgentBrowserBatchResult,
  loopState: LoopState,
): AgentBrowserBatchResult {
  if (!result.success) {
    return result;
  }
  if (hasFreshObservationAfterLastMutation(loopState)) {
    return result;
  }
  return {
    ...result,
    success: false,
    metadata: {
      ...result.metadata,
      terminalCode: "TERMINAL_COMPLETION_UNVERIFIED",
      terminalIncident: {
        code: "TERMINAL_COMPLETION_UNVERIFIED",
        reason:
          "Runtime reported completion immediately after a mutating browser action without a fresh confirming observation.",
        replannable: false,
        phase: "verification",
      },
    },
    error:
      "TERMINAL_COMPLETION_UNVERIFIED: Runtime finished without re-observing the UI after the last mutating action.",
  };
}

export async function executePromptBrowserRun(
  params: {
    request: AutomationRuntimeRunRequest;
    loopState: LoopState;
    emit: EmitEvent;
    signal?: AbortSignal;
  },
  hooks: PromptBrowserRunHooks = {},
): Promise<AgentBrowserBatchResult> {
  const { request, emit } = params;
  const prepareRun = hooks.prepareRun ?? prepareEmbeddedRuntimeRun;
  const prepareRetryRun = hooks.prepareRetryRun ?? prepareEmbeddedRuntimeRetryRun;
  const executePreparedRun = hooks.executePreparedRun ?? executePreparedEmbeddedRuntimeRun;
  if (hooks.runJsonCommand) {
    return await executePromptBrowserRunWithHooks(params, hooks);
  }
  if (/^https?:\/\//i.test(request.browser.cdpUrl)) {
    const cdpProbeError = await probeCdpEndpoint(request.browser.cdpUrl);
    if (cdpProbeError) {
      return {
        success: false,
        rows: [],
        metadata: { terminalCode: "EXECUTION_FAILED" },
        error: cdpProbeError,
      };
    }
  }
  const initialRequest = withInitialCatalogExecutionContract(request);
  const modelRef = normalizeModelRef(request);
  const browserFirstPrompt = await buildBrowserFirstPrompt(initialRequest);
  let prepared = await prepareRun({ request: initialRequest, emit, modelRef });

  const emitAndRemember: EmitEvent = (type, payload) => {
    rememberBrowserRuntimeEvent(params.loopState, type, payload);
    emit(type, payload);
  };

  const initialResult = await executePreparedRun({
    prepared,
    request: { ...initialRequest, text: browserFirstPrompt },
    emit: emitAndRemember,
    signal: params.signal,
  });
  const initialStepMismatch = currentStepActionMismatchResult(initialRequest, initialResult);
  if (initialStepMismatch) {
    return initialStepMismatch;
  }
  if (hasTerminalIncident(params.loopState)) {
    return terminalIncidentResult(request, params.loopState, initialResult);
  }
  const verifiedInitialResult = withObservedCompletionRequirement(
    initialResult,
    params.loopState,
  );
  const pendingObservationRecovery = params.loopState.pendingObservationRecovery;
  if (pendingObservationRecovery && !verifiedInitialResult.success) {
    const recoveryCount = Number(params.loopState.browserObservationRecoveryCount || 0);
    if (recoveryCount < 1) {
      params.loopState.browserObservationRecoveryCount = recoveryCount + 1;
      emit("run.log", {
        level: "warn",
        source: "runtime",
        message:
          "The last browser observation did not produce actionable refs. Retrying once with a narrower scoped observation contract.",
        createdAt: nowIso(),
      });
      prepared = await prepareRetryRun({ prepared, emit });
      const recoveryRequest = withTargetedRecoveryContract(initialRequest, params.loopState);
      const recovered = await executePreparedRun({
        prepared,
        request: {
          ...recoveryRequest,
          text: buildObservationRecoveryPrompt(
            recoveryRequest,
            params.loopState,
            pendingObservationRecovery,
          ),
        },
        emit: emitAndRemember,
        signal: params.signal,
      });
      const recoveredStepMismatch = currentStepActionMismatchResult(initialRequest, recovered);
      if (recoveredStepMismatch) {
        return recoveredStepMismatch;
      }
      if (hasTerminalIncident(params.loopState)) {
        return terminalIncidentResult(request, params.loopState, recovered);
      }
      if (params.loopState.pendingObservationRecovery) {
        return observationUngroundedResult(
          request,
          params.loopState,
          params.loopState.pendingObservationRecovery,
        );
      }
      return withObservedCompletionRequirement(recovered, params.loopState);
    }
    return observationUngroundedResult(request, params.loopState, pendingObservationRecovery);
  }
  const recoverableToolError = shouldRecoverFromToolError(verifiedInitialResult, params.loopState);
  if (recoverableToolError) {
    const recoveryCount = Number(params.loopState.browserToolErrorRecoveryCount || 0);
    if (recoveryCount < 1) {
      params.loopState.browserToolErrorRecoveryCount = recoveryCount + 1;
      emit("run.log", {
        level: "warn",
        source: "runtime",
        message:
          "The last browser tool action failed on a grounded surface. Retrying once with a stricter single-control recovery contract.",
        createdAt: nowIso(),
      });
      prepared = await prepareRetryRun({ prepared, emit });
      const recoveryRequest = withTargetedRecoveryContract(initialRequest, params.loopState);
      const recovered = await executePreparedRun({
        prepared,
        request: {
          ...recoveryRequest,
          text: buildToolErrorRecoveryPrompt(recoveryRequest, params.loopState, recoverableToolError),
        },
        emit: emitAndRemember,
        signal: params.signal,
      });
      const recoveredStepMismatch = currentStepActionMismatchResult(initialRequest, recovered);
      if (recoveredStepMismatch) {
        return recoveredStepMismatch;
      }
      if (hasTerminalIncident(params.loopState)) {
        return terminalIncidentResult(request, params.loopState, recovered);
      }
      return withObservedCompletionRequirement(recovered, params.loopState);
    }
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
          ? "Detected browser channel timeout/unavailability from Runtime. Restarting browser daemon and retrying from the last good observation."
          : "Browser channel timed out again after foreground-snapshot recovery. Restarting browser daemon and retrying once more with labeled-screenshot guidance.",
      createdAt: nowIso(),
    });
    await restartEmbeddedBrowserBridgeDaemons();
    const recovered = await executePreparedRun({
      prepared,
      request: {
        ...initialRequest,
        text: buildBrowserTimeoutRecoveryPrompt(
          initialRequest,
          params.loopState,
          params.loopState.browserTimeoutRecoveryCount || 1,
        ),
      },
      emit: emitAndRemember,
      signal: params.signal,
    });
    const timeoutRecoveredStepMismatch = currentStepActionMismatchResult(initialRequest, recovered);
    if (timeoutRecoveredStepMismatch) {
      return timeoutRecoveredStepMismatch;
    }
    if (hasTerminalIncident(params.loopState)) {
      return terminalIncidentResult(request, params.loopState, recovered);
    }
    return withObservedCompletionRequirement(recovered, params.loopState);
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
    prepared = await prepareRetryRun({ prepared, emit });
    const retried = await executePreparedRun({
      prepared,
      emit: emitAndRemember,
      signal: params.signal,
    });
    const retriedStepMismatch = currentStepActionMismatchResult(initialRequest, retried);
    if (retriedStepMismatch) {
      return retriedStepMismatch;
    }
    if (hasTerminalIncident(params.loopState)) {
      return terminalIncidentResult(request, params.loopState, retried);
    }
    const persistentTransientFailure = classifyTransientModelFailure(retried);
    if (persistentTransientFailure) {
      return withTransientFailureMetadata(retried, persistentTransientFailure);
    }
    return withObservedCompletionRequirement(retried, params.loopState);
  }
  if (looksLikeCapabilityRefusal(initialResult)) {
    params.emit("run.log", {
      level: "info",
      source: "runtime",
      message:
        "Runtime returned a generic capability refusal; retrying once with upstream agent-browser guidance injected into the prompt.",
      createdAt: nowIso(),
    });
    const retried = await executePreparedRun({
      prepared,
      request: { ...request, text: browserFirstPrompt },
      emit: emitAndRemember,
      signal: params.signal,
    });
    const browserFirstRetriedStepMismatch = currentStepActionMismatchResult(initialRequest, retried);
    if (browserFirstRetriedStepMismatch) {
      return browserFirstRetriedStepMismatch;
    }
    if (hasTerminalIncident(params.loopState)) {
      return terminalIncidentResult(request, params.loopState, retried);
    }
    return withObservedCompletionRequirement(retried, params.loopState);
  }
  return verifiedInitialResult;
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
