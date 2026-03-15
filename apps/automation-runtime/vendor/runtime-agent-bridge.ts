import fs from "node:fs/promises";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "../src/vendor/runtime/src/agents/defaults.js";
import { classifyBridgeOutcome } from "./runtime-bridge-outcome.ts";
import { resolveBrowserSessionAgentId } from "../src/vendor/runtime/src/agents/browser-session-agent.js";
import { runEmbeddedBrowserPiAgent } from "../src/vendor/runtime/src/agents/pi-embedded-runner/browser-run.js";
import {
  resolveBrowserSession,
  resolveBrowserSessionTranscriptFile,
  updateBrowserSessionStoreAfterRun,
} from "./runtime-bridge-session-store.ts";
import { loadBrowserConfig } from "../src/vendor/runtime/src/config/browser-config.js";

const PREFIX = "__OI_RUNTIME__";

type BridgeRequest = {
  request: {
    runId: string;
    text: string;
    pageRegistry?: Record<string, Record<string, unknown>> | null;
    activePageRef?: string | null;
    goalHints?: {
      taskMode?: string | null;
      app?: string | null;
      entities?: Record<string, unknown> | null;
      executionContract?: Record<string, unknown> | null;
    } | null;
  };
  sessionId: string;
  sessionKey: string;
  modelRef?: string;
  workspaceDir: string;
};

type RuntimeSummary = {
  sawToolEvent: boolean;
  sawBrowserToolEvent: boolean;
  sawToolError: boolean;
  sawAssistantText: boolean;
  assistantText: string;
  lifecyclePhase: string;
  toolNames: string[];
  browserOperations: string[];
  sawMutatingBrowserAction: boolean;
};

type TranscriptSummary = {
  toolCalls: number;
  browserToolCalls: number;
  browserMutatingToolCalls: number;
  browserExtractToolCalls: number;
  toolResults: number;
  toolErrors: number;
  browserSuccessfulMutationResults: number;
  browserSuccessfulExtractResults: number;
  browserRecoverableFailures: number;
  browserTerminalFailures: number;
  assistantText: string;
};

type BrowserTaskShape = {
  sourceApps: string[];
  destinationApps: string[];
  operations: string[];
  referencesVisibleState: boolean;
  crossAppTransfer: boolean;
  extractedArtifactName?: string;
  destinationRecipient?: string;
};

type ExecutionContract = {
  current_execution_step?: Record<string, unknown> | null;
  ui_surface?: Record<string, unknown> | null;
};

const APP_SIGNAL_MAP: Record<string, readonly string[]> = {
  gmail: ["gmail", "email", "inbox", "draft", "drafts", "sent mail"],
  whatsapp: ["whatsapp", "chat", "thread"],
  telegram: ["telegram"],
  slack: ["slack"],
  github: ["github", "repo", "repository", "pull request", "issue"],
  calendar: ["calendar", "event"],
  docs: ["docs", "document", "doc"],
  notion: ["notion", "page", "workspace"],
};

const VISIBLE_STATE_MARKERS = [
  "first ",
  "latest ",
  "top ",
  "currently open",
  "open tab",
  "visible ",
  "selected ",
  "active ",
  "inbox",
  "thread",
  "chat",
  "draft",
  "body of",
] as const;

function normalizeText(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function detectApps(normalized: string): Set<string> {
  const matches = new Set<string>();
  for (const [app, signals] of Object.entries(APP_SIGNAL_MAP)) {
    if (signals.some((signal) => normalized.includes(signal))) {
      matches.add(app);
    }
  }
  return matches;
}

function inferBrowserTaskShape(input: BridgeRequest): BrowserTaskShape | null {
  const normalized = normalizeText(input.request.text);
  if (!normalized) {
    return null;
  }
  const apps = detectApps(normalized);
  const operations = new Set<string>();
  if (normalized.includes("send")) {
    operations.add("send");
  }
  if (["copy", "extract", "forward", "quote", "take the text", "take the body"].some((marker) => normalized.includes(marker))) {
    operations.add("extract");
  }
  if (["open ", "navigate ", "go to ", "switch to "].some((marker) => normalized.includes(marker))) {
    operations.add("navigate");
  }
  const referencesVisibleState = VISIBLE_STATE_MARKERS.some((marker) => normalized.includes(marker));
  const sourceApps = new Set([...apps].filter((app) => app !== "whatsapp" && app !== "telegram" && app !== "slack"));
  const destinationApps = new Set([...apps].filter((app) => app === "whatsapp" || app === "telegram" || app === "slack" || app === "gmail"));
  const crossAppTransfer =
    operations.has("extract") &&
    operations.has("send") &&
    destinationApps.size > 0 &&
    (sourceApps.size > 0 || apps.size > 1);

  if (!crossAppTransfer && operations.size === 0) {
    return null;
  }

  let destinationRecipient: string | undefined;
  const entityRecipient = input.request.goalHints?.entities?.recipient;
  if (typeof entityRecipient === "string" && entityRecipient.trim()) {
    destinationRecipient = entityRecipient.trim();
  } else {
    const recipientMatch =
      /\b(?:to|send it to|send that to|message)\s+([A-Z][A-Za-z0-9._-]{1,40})\b/.exec(input.request.text);
    if (recipientMatch?.[1]) {
      destinationRecipient = recipientMatch[1];
    }
  }

  return {
    sourceApps: [...sourceApps],
    destinationApps: [...destinationApps],
    operations: [...operations],
    referencesVisibleState,
    crossAppTransfer,
    extractedArtifactName: crossAppTransfer ? "copied_content" : undefined,
    destinationRecipient,
  };
}

function splitModelRef(modelRef: string | undefined): {
  providerOverride?: string;
  modelOverride?: string;
} {
  const trimmed = String(modelRef || "").trim();
  if (!trimmed) {
    return {};
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return { modelOverride: trimmed };
  }
  return {
    providerOverride: trimmed.slice(0, slashIndex),
    modelOverride: trimmed.slice(slashIndex + 1),
  };
}

function emit(message: Record<string, unknown>): void {
  process.stdout.write(`${PREFIX}${JSON.stringify(message)}\n`);
}

function browserTaskExtraSystemPrompt(input: BridgeRequest): string | undefined {
  const taskMode = String(input.request.goalHints?.taskMode || "").trim().toLowerCase();
  if (taskMode !== "browser_automation") {
    return undefined;
  }
  const lines = [
    "This run is a browser UI automation task in a live attached browser session.",
    "Use the browser tool as the primary execution surface whenever the task can be completed in the browser UI.",
    "Treat missing native integrations or channels as irrelevant when the task can be completed through the browser UI.",
    "Do not answer with generic capability limitations when the browser tool can perform the task.",
    "Only stop for human input when authentication, CAPTCHA, permissions, or explicit user confirmation genuinely block progress.",
    "In dynamic forms, dialogs, drawers, popups, sheets, and editors, perform only one mutating browser action per assistant turn, then wait for the tool result and re-observe before the next mutating action.",
    "When the task includes unresolved structured field values but the current surface is still a listing, inbox, results page, or home page, first open the create, compose, new, reply, or equivalent entry surface using a visible ref-backed control. Do not type task values into search fields, result filters, or helper controls while the destination editor/form is not open yet.",
    "Do not spend multiple turns circling with only snapshot, evaluate, or scroll actions. After at most three consecutive read-only browser actions, either take one concrete ref-based mutating action or explicitly report the blocker.",
    "If a generic page-control click, evaluate, or scroll attempt fails, take one fresh snapshot and choose a more specific visible target by ref. Do not keep retrying ambiguous current-page-control or evaluate loops.",
    "When the latest interactive browser state already exposes refs, every mutating click, type, hover, or select action must name a concrete ref from that observation. Do not issue text-only clicks, targetId-only clicks, or other generic page-level mutating actions on a ref-rich surface.",
    "Snapshot refs are literal ids such as e12 that appear in the browser observation. Use the ref token exactly as shown. Do not substitute visible labels, section titles, filter names, or other page text in place of a ref id.",
    "When structured values are being entered on a rich form or editor, complete those field entries one at a time, and once those required values are visibly present, advance immediately to the visible primary completion control for the task by concrete ref.",
    "When the page is already in a late-stage flow such as cart, checkout, review, or confirmation, prefer the primary visible next-step control over broad exploratory evaluation.",
    "For send, submit, post, save, or confirm actions, do not treat a successful click or keypress as completion by itself. Take a fresh snapshot afterwards and verify a visible state change.",
    "Visible completion evidence includes things like: the draft/input clearing, the submitted text appearing in the destination surface, the dialog closing, a new sent/posted item appearing, or another explicit success indicator.",
    "If the UI still shows the unsent draft after the action, the task is not complete yet.",
  ];
  const currentStepBlock = currentExecutionStepBlock(input);
  if (currentStepBlock) {
    lines.push(currentStepBlock);
  }
  return lines.join(" ");
}

function browserTaskPrompt(input: BridgeRequest): string {
  const taskMode = String(input.request.goalHints?.taskMode || "").trim().toLowerCase();
  if (taskMode !== "browser_automation") {
    return input.request.text;
  }
  return [
    "Complete this task through the live browser session using the browser tool.",
    "Use browser UI actions rather than relying on native app integrations or messaging/email channels.",
    "If blocked by login, CAPTCHA, permissions, or explicit confirmation, say so clearly.",
    "Avoid read-only churn: after repeated snapshot/evaluate/scroll steps, move to a concrete visible control by ref or declare the blocker.",
    "If a generic current-page-control or evaluate step fails, re-snapshot once and then choose a more specific visible target instead of retrying the same vague control.",
    "When a live interactive snapshot already includes refs, only mutating actions with a concrete ref are acceptable. Do not use text-only clicks, targetId-only clicks, or generic page-level mutating actions on a ref-rich surface.",
    "Snapshot refs are literal ids such as e12 that appear in the observation. Use that ref token exactly. Do not put visible labels like COLOR or + 44 more into the ref field.",
    "",
    input.request.text.trim(),
  ].join("\n");
}

export const __testOnly = {
  inferBrowserTaskShape,
  browserTaskExtraSystemPrompt,
  browserTaskPrompt,
  currentExecutionStepBlock,
  currentExecutionStepPrompt,
};

function executionContract(input: BridgeRequest): ExecutionContract {
  const contract =
    input.request.goalHints &&
    typeof input.request.goalHints === "object" &&
    "executionContract" in input.request.goalHints
      ? (input.request.goalHints as Record<string, unknown>).executionContract
      : null;
  return contract && typeof contract === "object" ? (contract as ExecutionContract) : {};
}

function currentExecutionStep(input: BridgeRequest): Record<string, unknown> | null {
  const contract = executionContract(input);
  return contract.current_execution_step && typeof contract.current_execution_step === "object"
    ? contract.current_execution_step
    : null;
}

function currentSurfaceKind(input: BridgeRequest): string {
  const contract = executionContract(input);
  const uiSurface = contract.ui_surface;
  if (!uiSurface || typeof uiSurface !== "object") {
    return "";
  }
  return String(uiSurface.kind || "").trim().toLowerCase();
}

function targetAppHint(input: BridgeRequest): string {
  const goalHints =
    input.request.goalHints && typeof input.request.goalHints === "object"
      ? (input.request.goalHints as Record<string, unknown>)
      : {};
  const app = String(goalHints.app || "").trim();
  if (app) {
    return app;
  }
  const entities = goalHints.entities && typeof goalHints.entities === "object"
    ? (goalHints.entities as Record<string, unknown>)
    : {};
  return String(entities.app || "").trim();
}

function verificationRuleLines(step: Record<string, unknown>): string[] {
  const rules = Array.isArray(step.verification_rules) ? step.verification_rules : [];
  const lines: string[] = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") {
      continue;
    }
    const record = rule as Record<string, unknown>;
    const kind = String(record.kind || "").trim();
    if (!kind) {
      continue;
    }
    if (kind === "search_query" && record.value) {
      lines.push(`- Verification: the visible search query should become ${JSON.stringify(String(record.value))}.`);
      continue;
    }
    if (kind === "selected_filter" && record.key && record.value) {
      lines.push(`- Verification: the selected filter ${String(record.key)} should become ${JSON.stringify(String(record.value))}.`);
      continue;
    }
    if (kind === "surface_kind" && record.expected_surface) {
      lines.push(`- Verification: the visible surface should transition to ${String(record.expected_surface)}.`);
      continue;
    }
    if (kind === "result_count_changed") {
      lines.push("- Verification: the visible result set should change after the step.");
    }
  }
  return lines;
}

function targetSequenceLines(step: Record<string, unknown>): string[] {
  const sequence = Array.isArray(step.target_sequence) ? step.target_sequence : [];
  const lines: string[] = [];
  if (!sequence.length) {
    return lines;
  }
  lines.push("- Follow this live ref-backed target order exactly:");
  for (const [index, rawItem] of sequence.entries()) {
    if (!rawItem || typeof rawItem !== "object") {
      continue;
    }
    const item = rawItem as Record<string, unknown>;
    const key = String(item.key || "").trim();
    const ref = String(item.ref || "").trim();
    const name = String(item.name || "").trim();
    const value = String(item.value || "").trim();
    const action = String(item.action || "").trim().toLowerCase();
    if (!ref || (!value && !action)) {
      continue;
    }
    if (value) {
      lines.push(
        `- ${index + 1}. Use type on ref ${ref}${name ? ` (${name})` : ""}${key ? ` for ${key}` : ""} with value ${JSON.stringify(value)}.`,
      );
      continue;
    }
    lines.push(
      `- ${index + 1}. Use ${action || "click"} on ref ${ref}${name ? ` (${name})` : ""}${key ? ` for ${key}` : ""}.`,
    );
  }
  lines.push("- Do not skip ahead or use auxiliary controls until the current listed ref-backed action succeeds.");
  return lines;
}

function snapshotSequenceLines(step: Record<string, unknown>): string[] {
  const sequence = Array.isArray(step.snapshot_sequence) ? step.snapshot_sequence : [];
  const lines: string[] = [];
  if (!sequence.length) {
    return lines;
  }
  lines.push("- Use this scoped snapshot sequence exactly until one step returns usable refs:");
  for (const [index, rawItem] of sequence.entries()) {
    if (!rawItem || typeof rawItem !== "object") {
      continue;
    }
    const item = rawItem as Record<string, unknown>;
    const selector = String(item.selector || "").trim();
    const interactive = item.interactive === true ? "interactive=true, " : "";
    const compact = item.compact === true ? "compact=true, " : "";
    const snapshotFormat = String(item.snapshotFormat || "").trim();
    const refs = String(item.refs || "").trim();
    if (!selector) {
      continue;
    }
    lines.push(
      `- ${index + 1}. Take a snapshot with selector ${JSON.stringify(selector)}${
        interactive || compact || snapshotFormat || refs
          ? ` (${interactive}${compact}${snapshotFormat ? `snapshotFormat=${snapshotFormat}, ` : ""}${refs ? `refs=${refs}` : ""}`.replace(/, $/, "") + ")"
          : ""
      }.`,
    );
  }
  lines.push("- Do not use generic page scrolling, vague clicks, or evaluate before one of those scoped snapshots returns usable refs.");
  return lines;
}

function stepKindGuidance(stepKind: string, surfaceKind: string): string[] {
  switch (stepKind) {
    case "search":
      return [
        "- Only perform actions that directly advance the search step.",
        "- Use a visible editable search control ref, update the query, then re-observe.",
        "- Do not open filters, product results, or checkout controls until the search step verifies.",
      ];
    case "filter":
      return [
        "- Only perform actions that directly advance the current filter step.",
        "- Use visible filter controls on the current results surface and re-observe after one filter mutation.",
        "- Do not use generic page scrolling on a results or filter surface once filter refs are visible or listed below.",
        "- If a listed filter control may be off-screen, use scrollIntoView on that same listed ref first, then click or select that exact ref.",
        "- Do not select a result or advance checkout until this filter step verifies.",
      ];
    case "select_result":
      return [
        "- Only perform actions that directly advance result selection.",
        "- Choose one concrete visible result ref from the current listing and open it.",
        "- Do not change unrelated filters or retype the search query while selecting a result.",
      ];
    case "fill_field":
      return [
        "- Only perform actions that directly advance the current field-entry step.",
        "- Use a concrete editable field ref, enter the requested value once, then re-observe.",
      ];
    case "advance":
      return [
        "- Only perform actions that directly advance to the next visible surface.",
        "- Prefer the concrete primary CTA that moves the current surface forward.",
      ];
    case "navigate":
      return [
        "- Only perform actions that establish the correct starting surface for the workflow.",
        "- Stay on the intended target site or app while establishing that starting surface.",
        "- If direct navigation fails, do not substitute a different site or search engine. Re-observe or report the blocker instead.",
      ];
    default:
      return surfaceKind
        ? [`- Stay on the current ${surfaceKind} surface and perform only the next action needed to advance the active step.`]
        : [];
  }
}

function currentExecutionStepBlock(input: BridgeRequest): string {
  const step = currentExecutionStep(input);
  if (!step) {
    return "";
  }
  const label = String(step.label || "").trim();
  const stepKind = String(step.kind || "").trim().toLowerCase();
  const surfaceKind = currentSurfaceKind(input);
  const targetApp = targetAppHint(input);
  const lines = [
    "## Active execution step",
    `- Current step kind: ${stepKind || "unknown"}`,
  ];
  if (label) {
    lines.push(`- Current step goal: ${label}`);
  }
  if (targetApp) {
    lines.push(`- Intended target site or app: ${targetApp}`);
  }
  if (surfaceKind) {
    lines.push(`- Current visible surface: ${surfaceKind}`);
  }
  lines.push(...stepKindGuidance(stepKind, surfaceKind));
  lines.push(...snapshotSequenceLines(step));
  lines.push(...targetSequenceLines(step));
  lines.push(...verificationRuleLines(step));
  lines.push("- Do not work on later steps until the current step verifies from the live UI.");
  return lines.join("\n");
}

function currentExecutionStepPrompt(input: BridgeRequest): string {
  const block = currentExecutionStepBlock(input);
  if (!block) {
    return "";
  }
  return block.replace(/^## Active execution step\n?/, "").replace(/\n/g, " ");
}

function resolvePreferredBrowserTargetId(input: BridgeRequest): string | undefined {
  const activePageRef = String(input.request.activePageRef || "").trim();
  const pageRegistry =
    input.request.pageRegistry && typeof input.request.pageRegistry === "object"
      ? input.request.pageRegistry
      : null;
  if (!activePageRef || !pageRegistry) {
    return undefined;
  }
  const pageEntry = pageRegistry[activePageRef];
  if (!pageEntry || typeof pageEntry !== "object") {
    return undefined;
  }
  const pageId = String(pageEntry.page_id || pageEntry.targetId || "").trim();
  return pageId || undefined;
}

function flushAndExit(code: number): void {
  process.stdout.write("", () => {
    process.stderr.write("", () => {
      process.exit(code);
    });
  });
}

function nowIso(): string {
  return new Date().toISOString();
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

function extractPayloadText(payloads: Array<Record<string, unknown>>): string | undefined {
  const text = payloads
    .map((payload) => String(payload.text || "").trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return text || undefined;
}

function looksLikeTerminalFailureText(value: string | undefined): boolean {
  const text = normalizeText(value || "");
  if (!text) {
    return false;
  }
  return [
    "rate limit",
    "try again later",
    "timed out",
    "timeout",
    "request failed",
    "execution failed",
    "runtime embedded runtime reported an error",
    "currently blocked",
    "blocked at the step",
    "unable to proceed",
    "cannot proceed",
    "cannot isolate",
    "encountered difficulties",
    "these attempts were unsuccessful",
    "requires user input",
    "requires login",
    "captcha",
    "permission denied",
    "human review required",
    "auth required",
  ].some((marker) => text.includes(marker));
}

function createRuntimeSummary(): RuntimeSummary {
  return {
    sawToolEvent: false,
    sawBrowserToolEvent: false,
    sawToolError: false,
    sawAssistantText: false,
    assistantText: "",
    lifecyclePhase: "",
    toolNames: [],
    browserOperations: [],
    sawMutatingBrowserAction: false,
  };
}

function createTranscriptSummary(): TranscriptSummary {
  return {
    toolCalls: 0,
    browserToolCalls: 0,
    browserMutatingToolCalls: 0,
    browserExtractToolCalls: 0,
    toolResults: 0,
    toolErrors: 0,
    browserSuccessfulMutationResults: 0,
    browserSuccessfulExtractResults: 0,
    browserRecoverableFailures: 0,
    browserTerminalFailures: 0,
    assistantText: "",
  };
}

function appendUnique(values: string[], value: string): void {
  if (!value || values.includes(value)) {
    return;
  }
  values.push(value);
}

function classifyBrowserOperation(data: Record<string, unknown>): string | null {
  const args = data.args && typeof data.args === "object" ? (data.args as Record<string, unknown>) : {};
  const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
  if (!action) {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (url) {
      return "open";
    }
    if (Array.isArray(args.request) || (args.request && typeof args.request === "object")) {
      return "act";
    }
    return null;
  }
  if (action !== "act") {
    return action;
  }
  const request =
    args.request && typeof args.request === "object" ? (args.request as Record<string, unknown>) : {};
  const actKind =
    (typeof request.kind === "string" ? request.kind : typeof args.kind === "string" ? args.kind : "")
      .trim()
      .toLowerCase();
  return actKind ? `act:${actKind}` : "act";
}

function classifyBrowserOperationFromMeta(data: Record<string, unknown>): string | null {
  const metaValue = typeof data.meta === "string" ? data.meta.trim().toLowerCase() : "";
  if (!metaValue) {
    return null;
  }
  const kindMatch = /^kind\s+([a-z]+)/.exec(metaValue);
  if (kindMatch?.[1]) {
    return `act:${kindMatch[1]}`;
  }
  if (metaValue === "press") {
    return "act:press";
  }
  return null;
}

function isMutatingBrowserOperation(operation: string): boolean {
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
  ]).has(operation);
}

async function readTranscriptSummary(sessionFile: string): Promise<TranscriptSummary> {
  const summary = createTranscriptSummary();
  const toolCallMeta = new Map<
    string,
    {
      browser: boolean;
      op: string | null;
      mutating: boolean;
      extract: boolean;
    }
  >();
  try {
    const raw = await fs.readFile(sessionFile, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (record.type !== "message") {
        continue;
      }
      const message =
        record.message && typeof record.message === "object"
          ? (record.message as Record<string, unknown>)
          : null;
      if (!message) {
        continue;
      }
      const role = String(message.role || "").trim().toLowerCase();
      const content = Array.isArray(message.content)
        ? (message.content as Array<Record<string, unknown>>)
        : [];
      if (role === "assistant") {
        for (const item of content) {
          if (item.type === "toolCall") {
            summary.toolCalls += 1;
            if (item.name === "browser") {
              summary.browserToolCalls += 1;
              const args =
                item.arguments && typeof item.arguments === "object"
                  ? (item.arguments as Record<string, unknown>)
                  : {};
              const op = classifyBrowserOperation({ args }) || classifyBrowserOperationFromMeta(args);
              if (op && isMutatingBrowserOperation(op)) {
                summary.browserMutatingToolCalls += 1;
              }
              if (op === "extract") {
                summary.browserExtractToolCalls += 1;
              }
              const toolCallId = typeof item.id === "string" ? item.id : "";
              if (toolCallId) {
                toolCallMeta.set(toolCallId, {
                  browser: true,
                  op,
                  mutating: Boolean(op && isMutatingBrowserOperation(op)),
                  extract: op === "extract",
                });
              }
            }
          } else if (item.type === "text") {
            const text = String(item.text || "").trim();
            if (text) {
              summary.assistantText = text;
            }
          }
        }
      } else if (role === "toolresult") {
        summary.toolResults += 1;
        if (Boolean(message.isError)) {
          summary.toolErrors += 1;
          continue;
        }
        const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
        const callMeta = toolCallId ? toolCallMeta.get(toolCallId) : null;
        const details =
          message.details && typeof message.details === "object"
            ? (message.details as Record<string, unknown>)
            : null;
        if (details && Boolean(details.isError)) {
          summary.toolErrors += 1;
          if (callMeta?.browser) {
            summary.browserTerminalFailures += 1;
          }
          continue;
        }
        if (callMeta?.browser) {
          const content = Array.isArray(message.content)
            ? (message.content as Array<Record<string, unknown>>)
            : [];
          let parsedJson: Record<string, unknown> | null = null;
          for (const item of content) {
            if (item.type !== "text") {
              continue;
            }
            const text = String(item.text || "").trim();
            if (!(text.startsWith("{") && text.endsWith("}"))) {
              continue;
            }
            try {
              parsedJson = JSON.parse(text) as Record<string, unknown>;
              break;
            } catch {
              continue;
            }
          }
          const ok = parsedJson?.ok;
          const recoverable = parsedJson?.recoverable;
          if (ok === true) {
            if (callMeta.extract) {
              summary.browserSuccessfulExtractResults += 1;
            }
            if (callMeta.mutating) {
              summary.browserSuccessfulMutationResults += 1;
            }
          } else if (ok === false) {
            if (recoverable === true) {
              summary.browserRecoverableFailures += 1;
            } else {
              summary.browserTerminalFailures += 1;
            }
          }
        }
      }
    }
  } catch {
    return summary;
  }
  return summary;
}

function mapAgentEventToRuntimeEvent(
  evt: { stream: string; data?: Record<string, unknown> },
  summary: RuntimeSummary,
  toolArgsByCallId: Map<string, unknown>,
): { eventType: string; payload: Record<string, unknown> } | null {
  const stream = String(evt.stream || "").trim().toLowerCase();
  const data = evt.data && typeof evt.data === "object" ? evt.data : {};
  if (stream === "tool") {
    const phase = String(data.phase || "").trim().toLowerCase();
    const toolName = String(data.name || "").trim();
    summary.sawToolEvent = true;
    appendUnique(summary.toolNames, toolName);
    if (toolName === "browser") {
      summary.sawBrowserToolEvent = true;
      if (phase === "start" || phase === "result" || phase === "update") {
        const operation = classifyBrowserOperation(data) || classifyBrowserOperationFromMeta(data);
        if (operation) {
          appendUnique(summary.browserOperations, operation);
          if (isMutatingBrowserOperation(operation)) {
            summary.sawMutatingBrowserAction = true;
          }
        }
      }
    }
    if (Boolean(data.isError)) {
      summary.sawToolError = true;
    }
    if (phase === "start") {
      const toolCallId = String(data.toolCallId || "").trim();
      if (toolCallId && data.args !== undefined) {
        toolArgsByCallId.set(toolCallId, data.args);
      }
      return {
        eventType: "run.tool.started",
        payload: {
          toolName,
          toolCallId: data.toolCallId,
          args: data.args,
        },
      };
    }
    if (phase === "result" || phase === "update") {
      const toolCallId = String(data.toolCallId || "").trim();
      const args = data.args !== undefined ? data.args : toolCallId ? toolArgsByCallId.get(toolCallId) : undefined;
      if (phase === "result" && toolCallId) {
        toolArgsByCallId.delete(toolCallId);
      }
      return {
        eventType: "run.tool.finished",
        payload: {
          toolName,
          toolCallId: data.toolCallId,
          args,
          isError: Boolean(data.isError),
          meta: data.meta,
          result: data.result,
          partialResult: data.partialResult,
        },
      };
    }
  }
  if (stream === "assistant") {
    const text = String(data.text || data.delta || "").trim();
    if (text) {
      summary.sawAssistantText = true;
      summary.assistantText = text;
    }
    return {
      eventType: "run.log",
      payload: {
        level: "info",
        source: "runtime:assistant",
        message: stringifyLogArg(data),
        createdAt: nowIso(),
      },
    };
  }
  if (stream === "lifecycle") {
    const phase = String(data.phase || "").trim().toLowerCase();
    if (phase) {
      summary.lifecyclePhase = phase;
    }
    if (phase === "error") {
      return {
        eventType: "run.log",
        payload: {
          level: "warn",
          source: "runtime:lifecycle",
          message: String(data.error || "Runtime reported a lifecycle error."),
          createdAt: nowIso(),
        },
      };
    }
  }
  return {
    eventType: "run.log",
    payload: {
      level: stream === "error" ? "error" : "info",
      source: `runtime:${evt.stream}`,
      message: stringifyLogArg(data),
      createdAt: nowIso(),
    },
  };
}

async function readInput(): Promise<BridgeRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as BridgeRequest;
}

async function main(): Promise<void> {
  const input = await readInput();
  const cfg = loadBrowserConfig();
  const sessionAgentId = resolveBrowserSessionAgentId({
    sessionKey: input.sessionKey,
    config: cfg,
  });
  const sessionResolution = resolveBrowserSession({
    cfg,
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
    agentId: sessionAgentId,
  });
  const sessionKey = sessionResolution.sessionKey ?? input.sessionKey;
  const { sessionFile, sessionEntry } = await resolveBrowserSessionTranscriptFile({
    sessionId: sessionResolution.sessionId,
    sessionKey,
    sessionEntry: sessionResolution.sessionEntry,
    sessionStore: sessionResolution.sessionStore,
    storePath: sessionResolution.storePath,
    agentId: sessionAgentId,
  });
  const { providerOverride, modelOverride } = splitModelRef(input.modelRef);
  const preferredTargetId = resolvePreferredBrowserTargetId(input);
  if (preferredTargetId) {
    process.env.OI_BROWSER_TARGET_ID = preferredTargetId;
  } else {
    delete process.env.OI_BROWSER_TARGET_ID;
  }

  emit({
    kind: "event",
    eventType: "run.log",
    payload: {
      level: "info",
      source: "runtime-bridge",
      message:
        `Invoking runEmbeddedBrowserPiAgent session=${sessionResolution.sessionId} ` +
        `agent=${sessionAgentId} model=${input.modelRef || "default"} sessionKey=${sessionKey}` +
        (preferredTargetId ? ` targetId=${preferredTargetId}` : ""),
      createdAt: nowIso(),
    },
  });

  try {
    const runtimeSummary = createRuntimeSummary();
    const toolArgsByCallId = new Map<string, unknown>();
    const result = await runEmbeddedBrowserPiAgent({
      sessionId: sessionResolution.sessionId,
      sessionKey,
      agentId: sessionAgentId,
      trigger: "user",
      messageChannel: "webchat",
      senderIsOwner: true,
      disableMessageTool: true,
      browserOnlyTools: true,
      requireExplicitMessageTarget: true,
      sessionFile,
      workspaceDir: input.workspaceDir,
      config: cfg,
      prompt: browserTaskPrompt(input),
      extraSystemPrompt: browserTaskExtraSystemPrompt(input),
      provider: providerOverride,
      model: modelOverride,
      timeoutMs: 300_000,
      runId: input.request.runId,
      onAgentEvent: (evt) => {
        const mapped = mapAgentEventToRuntimeEvent(evt, runtimeSummary, toolArgsByCallId);
        if (mapped) {
          emit({
            kind: "event",
            eventType: mapped.eventType,
            payload: mapped.payload,
          });
        }
      },
    } as Parameters<typeof runEmbeddedBrowserPiAgent>[0]);

    if (sessionResolution.sessionStore && sessionKey && sessionResolution.storePath) {
      await updateBrowserSessionStoreAfterRun({
        cfg,
        sessionId: sessionResolution.sessionId,
        sessionKey,
        storePath: sessionResolution.storePath,
        sessionStore: sessionResolution.sessionStore,
        defaultProvider: providerOverride || DEFAULT_PROVIDER,
        defaultModel: modelOverride || DEFAULT_MODEL,
        fallbackProvider: providerOverride,
        fallbackModel: modelOverride,
        result,
      });
      if (sessionEntry) {
        sessionResolution.sessionStore[sessionKey] = sessionEntry;
      }
    }

    const payloads = Array.isArray(result.payloads)
      ? (result.payloads as Array<Record<string, unknown>>)
      : [];
    const transcriptSummary = await readTranscriptSummary(sessionFile);
    const stopReason = String(result.meta?.stopReason || "").trim().toLowerCase();
    const payloadText = extractPayloadText(payloads);
    const assistantOutcomeText = transcriptSummary.assistantText || runtimeSummary.assistantText || "";
    const terminalFailureText = [
      assistantOutcomeText,
      payloadText,
      typeof result.meta?.error?.message === "string" ? result.meta.error.message : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const terminalFailureDetected =
      looksLikeTerminalFailureText(terminalFailureText) ||
      transcriptSummary.browserTerminalFailures > 0 ||
      Boolean(result.meta?.error);
    const meta = {
      ...(result.meta || {}),
      stopReason,
      runtimeSummary,
      transcriptSummary,
    } as Record<string, unknown>;
    const failedPayload = payloads.find((payload) => Boolean(payload.isError));
    const outcome = classifyBridgeOutcome({
      requestText: input.request.text,
      payloadText,
      assistantOutcomeText,
      stopReason,
      transcriptSummary,
      runtimeSummary,
      failedPayloadPresent: Boolean(failedPayload),
      resultMetaErrorPresent: Boolean(result.meta?.error),
      terminalFailureDetected,
    });
    const success = outcome.success;
    emit({
      kind: "result",
      success,
      payloads,
      meta:
        success
          ? {
              ...meta,
              browserEngaged: outcome.browserEngaged,
              browserTaskSucceeded: outcome.browserTaskSucceeded,
              browserBoundaryStopSucceeded: outcome.browserBoundaryStopSucceeded,
              terminalCode: "COMPLETED",
            }
          : {
              ...meta,
              browserEngaged: outcome.browserEngaged,
              browserTaskSucceeded: outcome.browserTaskSucceeded,
              browserBoundaryStopSucceeded: outcome.browserBoundaryStopSucceeded,
              terminalCode: outcome.terminalCode,
            },
      error:
        success
          ? undefined
          : outcome.browserNotEngaged
            ? String(
                assistantOutcomeText ||
                  payloadText ||
                  "Browser automation did not engage for this runtime request.",
              )
            : outcome.browserBlockedResponse
              ? String(
                  assistantOutcomeText ||
                    payloadText ||
                    "Browser automation is blocked and requires user intervention.",
                )
            : outcome.browserEngaged
              ? String(
                  terminalFailureText ||
                    payloadText ||
                    "Browser automation engaged but did not produce a successful browser result.",
                )
            : outcome.assistantOnlyResponse || outcome.browserObservationOnlyResponse
              ? String(assistantOutcomeText || payloadText || "Runtime requires user input.")
              : String(
                  failedPayload?.text ||
                    result.meta?.error?.message ||
                    payloadText ||
                    "Runtime embedded runtime reported an error.",
                ),
    });
    if (!success) {
      flushAndExit(1);
      return;
    }
    flushAndExit(0);
    return;
  } catch (error) {
    emit({
      kind: "result",
      success: false,
      payloads: [],
      meta: { terminalCode: "EXECUTION_FAILED" },
      error: error instanceof Error ? error.message : String(error),
    });
    flushAndExit(1);
    return;
  }
}

void main();
