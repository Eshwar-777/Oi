import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  browserAct,
  browserConsoleMessages,
  browserSnapshot,
  browserTabs,
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
} from "../../browser/browser-core-surface.js";
import { loadBrowserConfig } from "../../config/browser-config.js";
import { wrapExternalContent } from "../../security/external-content.js";
import { imageResultFromFile, jsonResult } from "./common.js";

type BrowserProxyRequest = (opts: {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
}) => Promise<unknown>;

function wrapBrowserExternalJson(params: {
  kind: "snapshot" | "console" | "tabs";
  payload: unknown;
  includeWarning?: boolean;
}): { wrappedText: string; safeDetails: Record<string, unknown> } {
  const extractedText = JSON.stringify(params.payload, null, 2);
  const wrappedText = wrapExternalContent(extractedText, {
    source: "browser",
    includeWarning: params.includeWarning ?? true,
  });
  return {
    wrappedText,
    safeDetails: {
      ok: true,
      externalContent: {
        untrusted: true,
        source: "browser",
        kind: params.kind,
        wrapped: true,
      },
    },
  };
}

function formatTabsToolResult(tabs: unknown[]): AgentToolResult<unknown> {
  const wrapped = wrapBrowserExternalJson({
    kind: "tabs",
    payload: { tabs },
    includeWarning: false,
  });
  const content: AgentToolResult<unknown>["content"] = [
    { type: "text", text: wrapped.wrappedText },
  ];
  return {
    content,
    details: { ...wrapped.safeDetails, tabCount: tabs.length },
  };
}

function isChromeStaleTargetError(profile: string | undefined, err: unknown): boolean {
  if (profile !== "chrome") {
    return false;
  }
  const msg = String(err);
  return msg.includes("404:") && msg.includes("tab not found");
}

function stripTargetIdFromActRequest(
  request: Parameters<typeof browserAct>[1],
): Parameters<typeof browserAct>[1] | null {
  const targetId = typeof request.targetId === "string" ? request.targetId.trim() : undefined;
  if (!targetId) {
    return null;
  }
  const retryRequest = { ...request };
  delete retryRequest.targetId;
  return retryRequest as Parameters<typeof browserAct>[1];
}

function canRetryChromeActWithoutTargetId(request: Parameters<typeof browserAct>[1]): boolean {
  const typedRequest = request as Partial<Record<"kind" | "action", unknown>>;
  const kind =
    typeof typedRequest.kind === "string"
      ? typedRequest.kind
      : typeof typedRequest.action === "string"
        ? typedRequest.action
        : "";
  return kind === "hover" || kind === "scrollIntoView" || kind === "wait";
}

function actKindOf(request: Parameters<typeof browserAct>[1]): string {
  const typedRequest = request as Partial<Record<"kind" | "action", unknown>>;
  return typeof typedRequest.kind === "string"
    ? typedRequest.kind
    : typeof typedRequest.action === "string"
      ? typedRequest.action
      : "";
}

function isMutatingActRequest(request: Parameters<typeof browserAct>[1]): boolean {
  return new Set(["click", "type", "press", "drag", "select", "fill", "close"]).has(
    actKindOf(request),
  );
}

function isSequentialTextEntryActRequest(request: Parameters<typeof browserAct>[1]): boolean {
  const kind = actKindOf(request);
  return (kind === "type" || kind === "fill") && targetPresent(request);
}

function targetPresent(request: Parameters<typeof browserAct>[1]): boolean {
  return (
    (typeof request.ref === "string" && request.ref.trim().length > 0) ||
    (typeof request.selector === "string" && request.selector.trim().length > 0)
  );
}

function invalidActRecoveryResult(params: {
  request: Parameters<typeof browserAct>[1];
  missing: string[];
  reason: string;
}) {
  return jsonResult({
    ok: false,
    recoverable: true,
    requiresObservation: true,
    reason: params.reason,
    invalidRequest: {
      kind: actKindOf(params.request),
      missing: params.missing,
    },
  });
}

function snapshotRecoveryResult(params: {
  selector?: string;
  reason: string;
  error?: unknown;
  ambiguous?: boolean;
}) {
  return jsonResult({
    ok: false,
    recoverable: true,
    requiresObservation: true,
    reason: params.reason,
    snapshotRequest: {
      selector: params.selector,
      ambiguous: params.ambiguous ?? false,
    },
    error: params.error ? String(params.error) : undefined,
  });
}

function extractRecoveryResult(params: {
  selector?: string;
  reason: string;
  error?: unknown;
}) {
  return jsonResult({
    ok: false,
    recoverable: true,
    requiresObservation: true,
    reason: params.reason,
    extractRequest: {
      selector: params.selector,
      mode: "visible_text",
    },
    error: params.error ? String(params.error) : undefined,
  });
}

function actRecoveryResult(params: {
  request: Parameters<typeof browserAct>[1];
  reason: string;
  error?: unknown;
}) {
  const kind = actKindOf(params.request);
  const prefersFocusedForeground =
    kind === "type" || kind === "fill" || kind === "select";
  return jsonResult({
    ok: false,
    recoverable: true,
    requiresObservation: true,
    reason: params.reason,
    failedAction: {
      kind: actKindOf(params.request),
      ref: params.request.ref,
      selector: params.request.selector,
      targetId:
        typeof params.request.targetId === "string" ? params.request.targetId : undefined,
    },
    snapshotRequest: prefersFocusedForeground
      ? {
          interactive: true,
          compact: true,
          refs: "aria",
          selector:
            "[aria-modal='true']:has(:focus), [role='dialog']:has(:focus), dialog:has(:focus), form:has(:focus), [contenteditable='true']:focus, textarea:focus, input:focus, [role='textbox']:focus, [role='combobox']:focus",
        }
      : {
          interactive: true,
          compact: true,
          refs: "aria",
        },
    retryGuidance: prefersFocusedForeground
      ? "Recover by snapshotting the currently focused foreground surface first. Prefer a focused dialog, form, editor, or active input over a full-page body snapshot."
      : "Recover by taking a fresh compact interactive snapshot of the active foreground surface before retrying.",
    retryContract: prefersFocusedForeground
      ? {
          refOnly: true,
          requiresFocusedForegroundSnapshot: true,
        }
      : undefined,
    error: params.error ? String(params.error) : undefined,
  });
}

function isStrictModeSnapshotError(err: unknown): boolean {
  const text = String(err || "");
  return text.includes("strict mode violation") && text.includes("ariaSnapshot");
}

function isRecoverableSnapshotTimeoutError(err: unknown): boolean {
  const text = String(err || "").toLowerCase();
  return (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("waiting for locator") ||
    text.includes("browserserviceerror")
  );
}

function isRecoverableDynamicFormActError(
  request: Parameters<typeof browserAct>[1],
  err: unknown,
): boolean {
  const kind = actKindOf(request);
  if (!new Set(["click", "type", "fill", "select"]).has(kind)) {
    return false;
  }
  const text = String(err || "").toLowerCase();
  return (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("not found or not visible") ||
    text.includes("strict mode violation") ||
    (text.includes("matched") && text.includes("elements")) ||
    text.includes("element is not attached") ||
    text.includes("element is outside of the viewport") ||
    text.includes("element is not editable") ||
    text.includes("waiting for locator")
  );
}

function dynamicFormActRecoveryReason(request: Parameters<typeof browserAct>[1]): string {
  const kind = actKindOf(request);
  if (kind === "type" || kind === "fill" || kind === "select") {
    return "The browser action could not reliably reach the active editable control after the UI changed or the current ref became ambiguous. Capture a fresh snapshot of the active foreground form, dialog, drawer, popup, or editor, then target the actual textbox, combobox, textarea, or select control instead of a container element. Do not fall back to broad selectors such as body, button, or generic role-button containers while a foreground surface is already open.";
  }
  return "The browser action could not reliably reach the active target after the UI changed or the current ref became ambiguous. Capture a fresh snapshot of the active foreground form, dialog, drawer, popup, or editor, then continue from that surface with fresh refs. Do not broaden back to body-level or generic button snapshots while the foreground surface is still visible.";
}

function validateActRequest(
  request: Parameters<typeof browserAct>[1],
): { ok: true } | { ok: false; missing: string[]; reason: string } {
  const kind = actKindOf(request);
  const missing: string[] = [];
  const hasRef = typeof request.ref === "string" && request.ref.trim().length > 0;
  const hasSelector =
    typeof request.selector === "string" && request.selector.trim().length > 0;
  switch (kind) {
    case "click":
    case "hover":
      if (!targetPresent(request)) {
        missing.push("ref|selector");
      }
      break;
    case "type":
    case "select":
      if (!(hasRef || hasSelector)) {
        missing.push("ref|selector");
      }
      break;
    case "drag":
      if (!(typeof request.startRef === "string" && request.startRef.trim())) {
        missing.push("startRef");
      }
      if (!(typeof request.endRef === "string" && request.endRef.trim())) {
        missing.push("endRef");
      }
      break;
    case "fill":
      if (!Array.isArray(request.fields) || request.fields.length === 0) {
        missing.push("fields");
      }
      break;
    case "resize":
      if (!(typeof request.width === "number" && Number.isFinite(request.width))) {
        missing.push("width");
      }
      if (!(typeof request.height === "number" && Number.isFinite(request.height))) {
        missing.push("height");
      }
      break;
    case "press":
      if (!(typeof request.key === "string" && request.key.trim())) {
        missing.push("key");
      }
      break;
    default:
      break;
  }
  if (kind === "type" && typeof request.text !== "string") {
    missing.push("text");
  }
  if (kind === "select" && (!Array.isArray(request.values) || request.values.length === 0)) {
    missing.push("values");
  }
  if ((kind === "type" || kind === "select") && !hasRef && hasSelector) {
    return {
      ok: false,
      missing: ["ref"],
      reason:
        "Typing and selection inside a dynamic form or focused foreground surface must use a ref from the latest interactive snapshot. Capture a fresh focused foreground snapshot and retry with a concrete ref instead of a selector.",
    };
  }
  if (kind === "fill" && Array.isArray(request.fields)) {
    const missingFieldRef = request.fields.some((field) => {
      const record = field as Record<string, unknown>;
      return !(typeof record.ref === "string" && record.ref.trim().length > 0);
    });
    if (missingFieldRef) {
      return {
        ok: false,
        missing: ["fields[].ref"],
        reason:
          "Form filling inside a dynamic form or focused foreground surface must use field refs from the latest interactive snapshot. Capture a fresh focused foreground snapshot and retry with field refs instead of selector-like field targets.",
      };
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      reason:
        "The browser action request was incomplete for the current UI state. Capture a fresh snapshot and choose a fully specified action.",
    };
  }
  return { ok: true };
}

async function executeSingleActAction(params: {
  request: Parameters<typeof browserAct>[1];
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<unknown> {
  const { request, baseUrl, profile, proxyRequest } = params;
  return proxyRequest
    ? await proxyRequest({
        method: "POST",
        path: "/act",
        profile,
        body: request,
      })
    : await browserAct(baseUrl, request, {
        profile,
      });
}

export async function executeTabsAction(params: {
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { baseUrl, profile, proxyRequest } = params;
  if (proxyRequest) {
    const result = await proxyRequest({
      method: "GET",
      path: "/tabs",
      profile,
    });
    const tabs = (result as { tabs?: unknown[] }).tabs ?? [];
    return formatTabsToolResult(tabs);
  }
  const tabs = await browserTabs(baseUrl, { profile });
  return formatTabsToolResult(tabs);
}

export async function executeSnapshotAction(params: {
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { input, baseUrl, profile, proxyRequest } = params;
  const snapshotDefaults = loadBrowserConfig().browser?.snapshotDefaults;
  const format: "ai" | "aria" | undefined =
    input.snapshotFormat === "ai" || input.snapshotFormat === "aria"
      ? input.snapshotFormat
      : undefined;
  const mode: "efficient" | undefined =
    input.mode === "efficient"
      ? "efficient"
      : format !== "aria" && snapshotDefaults?.mode === "efficient"
        ? "efficient"
        : undefined;
  const labelsRequested = typeof input.labels === "boolean" ? input.labels : undefined;
  // The embedded browser runtime currently uses Playwright CDP attachment, where
  // the optional DOM label overlay path is less stable than the snapshot path itself.
  // Keep snapshots available by degrading label requests to plain snapshots.
  const labels = false;
  const interactive = typeof input.interactive === "boolean" ? input.interactive : undefined;
  const selector = typeof input.selector === "string" ? input.selector.trim() : undefined;
  const frame = typeof input.frame === "string" ? input.frame.trim() : undefined;
  const refs: "aria" | "role" | undefined =
    input.refs === "aria" || input.refs === "role"
      ? input.refs
      : interactive || selector || frame
        ? "aria"
        : undefined;
  const hasMaxChars = Object.hasOwn(input, "maxChars");
  const targetId = typeof input.targetId === "string" ? input.targetId.trim() : undefined;
  const limit =
    typeof input.limit === "number" && Number.isFinite(input.limit) ? input.limit : undefined;
  const maxChars =
    typeof input.maxChars === "number" && Number.isFinite(input.maxChars) && input.maxChars > 0
      ? Math.floor(input.maxChars)
      : undefined;
  const compact = typeof input.compact === "boolean" ? input.compact : undefined;
  const depth =
    typeof input.depth === "number" && Number.isFinite(input.depth) ? input.depth : undefined;
  const resolvedMaxChars =
    format === "ai"
      ? hasMaxChars
        ? maxChars
        : mode === "efficient"
          ? undefined
          : DEFAULT_AI_SNAPSHOT_MAX_CHARS
      : hasMaxChars
        ? maxChars
        : undefined;
  const snapshotQuery = {
    ...(format ? { format } : {}),
    targetId,
    limit,
    ...(typeof resolvedMaxChars === "number" ? { maxChars: resolvedMaxChars } : {}),
    refs,
    interactive,
    compact,
    depth,
    selector,
    frame,
    labels,
    mode,
  };
  let snapshot: Awaited<ReturnType<typeof browserSnapshot>>;
  try {
    snapshot = proxyRequest
      ? ((await proxyRequest({
          method: "GET",
          path: "/snapshot",
          profile,
          query: snapshotQuery,
        })) as Awaited<ReturnType<typeof browserSnapshot>>)
      : await browserSnapshot(baseUrl, {
          ...snapshotQuery,
          profile,
        });
  } catch (err) {
    if (frame && isRecoverableSnapshotTimeoutError(err)) {
      return snapshotRecoveryResult({
        selector,
        error: err,
        reason:
          "The frame-scoped snapshot timed out before it could confirm the active target. Return to the main document and capture a fresh snapshot of the active foreground form, dialog, drawer, popup, sheet, or editor first. Only switch into a frame after a fresh observation explicitly shows the relevant interactive controls inside that frame.",
      });
    }
    if (selector && isStrictModeSnapshotError(err)) {
      return snapshotRecoveryResult({
        selector,
        ambiguous: true,
        error: err,
        reason:
          "The snapshot selector matched too many elements to observe safely. Capture a more specific snapshot of the active foreground surface, such as the visible dialog, composer, drawer, popup, or focused form, instead of a broad selector.",
      });
    }
    if (selector) {
      return snapshotRecoveryResult({
        selector,
        error: err,
        reason:
          "The scoped snapshot failed for the current UI. Capture a fresh snapshot of the active foreground surface and choose a narrower, more specific selector before acting.",
      });
    }
    if (isRecoverableSnapshotTimeoutError(err)) {
      return snapshotRecoveryResult({
        error: err,
        reason:
          "The browser snapshot timed out before stable refs could be produced. Capture a fresh snapshot of the active foreground form, dialog, drawer, popup, sheet, or editor first, and only broaden to the full page if no clear foreground surface exists.",
      });
    }
    throw err;
  }
  if (snapshot.format === "ai") {
    const extractedText = snapshot.snapshot ?? "";
    const wrappedSnapshot = wrapExternalContent(extractedText, {
      source: "browser",
      includeWarning: true,
    });
    const safeDetails = {
      ok: true,
      format: snapshot.format,
      targetId: snapshot.targetId,
      url: snapshot.url,
      truncated: snapshot.truncated,
      stats: snapshot.stats,
      refs: snapshot.refs ? Object.keys(snapshot.refs).length : undefined,
      labels: snapshot.labels,
      labelsCount: snapshot.labelsCount,
      labelsSkipped: snapshot.labelsSkipped,
      imagePath: snapshot.imagePath,
      imageType: snapshot.imageType,
      labelsRequested,
      externalContent: {
        untrusted: true,
        source: "browser",
        kind: "snapshot",
        format: "ai",
        wrapped: true,
      },
    };
    if (labelsRequested && snapshot.imagePath) {
      return await imageResultFromFile({
        label: "browser:snapshot",
        path: snapshot.imagePath,
        extraText: wrappedSnapshot,
        details: safeDetails,
      });
    }
    return {
      content: [{ type: "text" as const, text: wrappedSnapshot }],
      details: safeDetails,
    };
  }
  {
    const wrapped = wrapBrowserExternalJson({
      kind: "snapshot",
      payload: snapshot,
    });
    return {
      content: [{ type: "text" as const, text: wrapped.wrappedText }],
      details: {
        ...wrapped.safeDetails,
        format: "aria",
        targetId: snapshot.targetId,
        url: snapshot.url,
        nodeCount: snapshot.nodes.length,
        externalContent: {
          untrusted: true,
          source: "browser",
          kind: "snapshot",
          format: "aria",
          wrapped: true,
        },
      },
    };
  }
}

export async function executeExtractAction(params: {
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { input, baseUrl, profile, proxyRequest } = params;
  const selector = typeof input.selector === "string" ? input.selector.trim() : undefined;
  const frame = typeof input.frame === "string" ? input.frame.trim() : undefined;
  const targetId = typeof input.targetId === "string" ? input.targetId.trim() : undefined;
  const maxChars =
    typeof input.maxChars === "number" && Number.isFinite(input.maxChars) && input.maxChars > 0
      ? Math.floor(input.maxChars)
      : 8_000;

  let snapshot: Awaited<ReturnType<typeof browserSnapshot>>;
  try {
    const snapshotQuery = {
      format: "ai" as const,
      targetId,
      selector,
      frame,
      maxChars,
      compact: false,
    };
    snapshot = proxyRequest
      ? ((await proxyRequest({
          method: "GET",
          path: "/snapshot",
          profile,
          query: snapshotQuery,
        })) as Awaited<ReturnType<typeof browserSnapshot>>)
      : await browserSnapshot(baseUrl, {
          ...snapshotQuery,
          profile,
        });
  } catch (err) {
    if (selector && isStrictModeSnapshotError(err)) {
      return extractRecoveryResult({
        selector,
        error: err,
        reason:
          "The extraction selector matched too many elements to read safely. Capture a more specific foreground surface first, then extract from that surface.",
      });
    }
    if (isRecoverableSnapshotTimeoutError(err)) {
      return extractRecoveryResult({
        selector,
        error: err,
        reason:
          "The browser extraction timed out before stable visible text could be recovered. Re-observe the active foreground surface first, then retry extraction from that narrower surface.",
      });
    }
    throw err;
  }

  const extractedText = typeof snapshot.snapshot === "string" ? snapshot.snapshot.trim() : "";
  if (!extractedText) {
    return extractRecoveryResult({
      selector,
      reason:
        "No visible text was recovered from the current surface. Capture a fresh snapshot of the active foreground surface or choose a narrower selector before retrying extraction.",
    });
  }
  const wrappedText = wrapExternalContent(extractedText, {
    source: "browser",
    includeWarning: true,
  });
  return {
    content: [{ type: "text" as const, text: wrappedText }],
    details: {
      ok: true,
      mode: "visible_text",
      format: "ai",
      targetId: snapshot.targetId,
      url: snapshot.url,
      extractedText,
      truncated: snapshot.truncated,
      stats: snapshot.stats,
      externalContent: {
        untrusted: true,
        source: "browser",
        kind: "extract",
        wrapped: true,
      },
    },
  };
}

export async function executeConsoleAction(params: {
  input: Record<string, unknown>;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { input, baseUrl, profile, proxyRequest } = params;
  const level = typeof input.level === "string" ? input.level.trim() : undefined;
  const targetId = typeof input.targetId === "string" ? input.targetId.trim() : undefined;
  if (proxyRequest) {
    const result = (await proxyRequest({
      method: "GET",
      path: "/console",
      profile,
      query: {
        level,
        targetId,
      },
    })) as { ok?: boolean; targetId?: string; messages?: unknown[] };
    const wrapped = wrapBrowserExternalJson({
      kind: "console",
      payload: result,
      includeWarning: false,
    });
    return {
      content: [{ type: "text" as const, text: wrapped.wrappedText }],
      details: {
        ...wrapped.safeDetails,
        targetId: typeof result.targetId === "string" ? result.targetId : undefined,
        messageCount: Array.isArray(result.messages) ? result.messages.length : undefined,
      },
    };
  }
  const result = await browserConsoleMessages(baseUrl, { level, targetId, profile });
  const wrapped = wrapBrowserExternalJson({
    kind: "console",
    payload: result,
    includeWarning: false,
  });
  return {
    content: [{ type: "text" as const, text: wrapped.wrappedText }],
    details: {
      ...wrapped.safeDetails,
      targetId: result.targetId,
      messageCount: result.messages.length,
    },
  };
}

export async function executeActAction(params: {
  request: Parameters<typeof browserAct>[1] | Parameters<typeof browserAct>[1][];
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
}): Promise<AgentToolResult<unknown>> {
  const { request, baseUrl, profile, proxyRequest } = params;
  if (Array.isArray(request)) {
    const results: unknown[] = [];
    for (let index = 0; index < request.length; index += 1) {
      const step = request[index];
      const validation = validateActRequest(step);
      if (!validation.ok) {
        return invalidActRecoveryResult({
          request: step,
          missing: validation.missing,
          reason: validation.reason,
        });
      }
      let result: unknown;
      try {
        result = await executeSingleActAction({
          request: step,
          baseUrl,
          profile,
          proxyRequest,
        });
      } catch (err) {
        if (isRecoverableDynamicFormActError(step, err)) {
          return actRecoveryResult({
            request: step,
            error: err,
            reason: dynamicFormActRecoveryReason(step),
          });
        }
        throw err;
      }
      results.push(result);
      if (
        index < request.length - 1 &&
        isMutatingActRequest(step) &&
        !isSequentialTextEntryActRequest(step)
      ) {
        return jsonResult({
          ok: true,
          partial: true,
          requiresObservation: true,
          reason: "A mutating browser action changed the UI. Capture a fresh snapshot before continuing.",
          executed: results.length,
          stoppedAfterKind: actKindOf(step),
          results,
        });
      }
    }
    return jsonResult({
      ok: true,
      batched: true,
      executed: results.length,
      results,
    });
  }
  const validation = validateActRequest(request);
  if (!validation.ok) {
    return invalidActRecoveryResult({
      request,
      missing: validation.missing,
      reason: validation.reason,
    });
  }
  try {
    const result = await executeSingleActAction({
      request,
      baseUrl,
      profile,
      proxyRequest,
    });
    return jsonResult(result);
  } catch (err) {
    if (isRecoverableDynamicFormActError(request, err)) {
      return actRecoveryResult({
        request,
        error: err,
        reason: dynamicFormActRecoveryReason(request),
      });
    }
    if (isChromeStaleTargetError(profile, err)) {
      const retryRequest = stripTargetIdFromActRequest(request);
      const tabs = proxyRequest
        ? ((
            (await proxyRequest({
              method: "GET",
              path: "/tabs",
              profile,
            })) as { tabs?: unknown[] }
          ).tabs ?? [])
        : await browserTabs(baseUrl, { profile }).catch(() => []);
      // Some Chrome relay targetIds can go stale between snapshots and actions.
      // Only retry safe read-only actions, and only when exactly one tab remains attached.
      if (retryRequest && canRetryChromeActWithoutTargetId(request) && tabs.length === 1) {
        try {
          const retryResult = proxyRequest
            ? await proxyRequest({
                method: "POST",
                path: "/act",
                profile,
                body: retryRequest,
              })
            : await browserAct(baseUrl, retryRequest, {
                profile,
              });
          return jsonResult(retryResult);
        } catch {
          // Fall through to explicit stale-target guidance.
        }
      }
      if (!tabs.length) {
        throw new Error(
          "No Chrome tabs are attached via the OpenClaw Browser Relay extension. Click the toolbar icon on the tab you want to control (badge ON), then retry.",
          { cause: err },
        );
      }
      throw new Error(
        `Chrome tab not found (stale targetId?). Run action=tabs profile="chrome" and use one of the returned targetIds.`,
        { cause: err },
      );
    }
    throw err;
  }
}
