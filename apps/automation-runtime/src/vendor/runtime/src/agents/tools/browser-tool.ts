import crypto from "node:crypto";
import {
  applyBrowserProxyPaths,
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserCloseTab,
  browserFocusTab,
  browserNavigate,
  browserOpenTab,
  browserProfiles,
  browserPdfSave,
  browserScreenshotAction,
  browserStatus,
  browserStart,
  browserStop,
  DEFAULT_UPLOAD_DIR,
  persistBrowserProxyFiles,
  resolveBrowserConfig,
  resolveExistingPathsWithinRoot,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "../../browser/browser-core-surface.js";
import { loadBrowserConfig } from "../../config/browser-config.js";
import {
  executeActAction,
  executeConsoleAction,
  executeExtractAction,
  executeSnapshotAction,
  executeTabsAction,
} from "./browser-tool.actions.js";
import { BrowserToolSchema } from "./browser-tool.schema.js";
import { type AnyAgentTool, imageResultFromFile, jsonResult, readStringParam } from "./common.js";

function readOptionalTargetAndTimeout(params: Record<string, unknown>) {
  const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? params.timeoutMs
      : undefined;
  return { targetId, timeoutMs };
}

function readTargetUrlParam(params: Record<string, unknown>) {
  return (
    readStringParam(params, "targetUrl") ??
    readStringParam(params, "url", { required: true, label: "targetUrl" })
  );
}

const LEGACY_BROWSER_ACT_REQUEST_KEYS = [
  "targetId",
  "ref",
  "doubleClick",
  "button",
  "modifiers",
  "text",
  "submit",
  "slowly",
  "key",
  "delayMs",
  "x",
  "y",
  "startRef",
  "endRef",
  "values",
  "fields",
  "width",
  "height",
  "timeMs",
  "textGone",
  "selector",
  "url",
  "loadState",
  "fn",
  "timeoutMs",
] as const;

const BROWSER_ACT_ACTIONS = new Set([
  "click",
  "type",
  "press",
  "scroll",
  "hover",
  "drag",
  "select",
  "fill",
  "resize",
  "wait",
  "evaluate",
  "close",
]);

const BROWSER_TOP_LEVEL_ACTIONS = new Set([
  "status",
  "start",
  "stop",
  "profiles",
  "tabs",
  "open",
  "focus",
  "close",
  "snapshot",
  "extract",
  "screenshot",
  "navigate",
  "console",
  "pdf",
  "upload",
  "dialog",
]);

const BROWSER_SNAPSHOT_HINT_KEYS = new Set([
  "level",
  "compact",
  "interactive",
  "depth",
  "selector",
  "frame",
  "labels",
  "limit",
  "maxChars",
  "snapshotFormat",
  "refs",
  "mode",
  "fullPage",
]);

function normalizeScrollCoordinate(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const normalized = trimmed.toLowerCase().replace(/\s+/g, "");
  if (
    normalized === "document.body.scrollheight" ||
    normalized === "document.documentelement.scrollheight" ||
    normalized === "body.scrollheight" ||
    normalized === "scrollheight" ||
    normalized === "pageend" ||
    normalized === "bottom" ||
    normalized === "end" ||
    normalized === "max"
  ) {
    return "page_end";
  }
  if (
    normalized === "0" ||
    normalized === "pagestart" ||
    normalized === "top" ||
    normalized === "start" ||
    normalized === "document.body.scrolltop" ||
    normalized === "document.documentelement.scrolltop"
  ) {
    return "page_start";
  }
  return trimmed;
}

function normalizeBrowserToolParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...params };
  const action = typeof normalized.action === "string" ? normalized.action.trim() : "";
  const kind = typeof normalized.kind === "string" ? normalized.kind.trim() : "";

  if (!action && !kind) {
    const url = typeof normalized.url === "string" ? normalized.url.trim() : "";
    if (url) {
      normalized.action = "open";
      return normalized;
    }
    if (
      Array.isArray(normalized.request) ||
      (normalized.request && typeof normalized.request === "object")
    ) {
      normalized.action = "act";
      return normalized;
    }
    const looksLikeSnapshot = Object.keys(normalized).some((key) =>
      BROWSER_SNAPSHOT_HINT_KEYS.has(key),
    );
    if (looksLikeSnapshot) {
      normalized.action = "snapshot";
      return normalized;
    }
  }

  if (!action && kind.toLowerCase() === "snapshot") {
    normalized.action = "snapshot";
    delete normalized.kind;
    return normalized;
  }

  if (!action && kind) {
    const normalizedKind = kind.toLowerCase();
    if (BROWSER_TOP_LEVEL_ACTIONS.has(normalizedKind)) {
      normalized.action = normalizedKind;
      delete normalized.kind;
      return normalized;
    }
    normalized.action = "act";
    return normalized;
  }

  if (BROWSER_ACT_ACTIONS.has(action.toLowerCase())) {
    normalized.action = "act";
    if (!kind) {
      normalized.kind = action.toLowerCase();
    }
  }

  return normalized;
}

function unsupportedBrowserActionResult(action: string) {
  return jsonResult({
    ok: false,
    recoverable: true,
    requiresObservation: true,
    reason:
      `Unsupported browser action "${action}". Capture a fresh browser snapshot of the current UI, then choose a supported action such as click, type, press, hover, drag, select, fill, resize, wait, evaluate, close, navigate, or snapshot.`,
    invalidRequest: {
      action,
      supportedTopLevelActions: Array.from(BROWSER_TOP_LEVEL_ACTIONS),
      supportedActKinds: Array.from(BROWSER_ACT_ACTIONS),
    },
  });
}

function readActRequestParam(params: Record<string, unknown>) {
  const requestParam = params.request;
  if (Array.isArray(requestParam)) {
    return requestParam.map((item) => normalizeActRequestShape(item, params)) as Parameters<
      typeof browserAct
    >[1][];
  }
  if (requestParam && typeof requestParam === "object") {
    return normalizeActRequestShape(requestParam, params) as Parameters<typeof browserAct>[1];
  }

  const kind = readStringParam(params, "kind");
  if (!kind) {
    return undefined;
  }

  const request: Record<string, unknown> = { kind };
  for (const key of LEGACY_BROWSER_ACT_REQUEST_KEYS) {
    if (!Object.hasOwn(params, key)) {
      continue;
    }
    request[key] = params[key];
  }
  return request as Parameters<typeof browserAct>[1];
}

function normalizeActRequestShape(
  requestParam: unknown,
  legacyParams: Record<string, unknown>,
): Record<string, unknown> {
  const request =
    requestParam && typeof requestParam === "object"
      ? { ...(requestParam as Record<string, unknown>) }
      : {};

  const nestedKind = typeof request.kind === "string" ? request.kind.trim() : "";
  const nestedType = typeof request.type === "string" ? request.type.trim() : "";
  if (!nestedKind && nestedType) {
    request.kind = nestedType.toLowerCase();
    delete request.type;
  }

  for (const key of LEGACY_BROWSER_ACT_REQUEST_KEYS) {
    if (Object.hasOwn(request, key)) {
      continue;
    }
    if (!Object.hasOwn(legacyParams, key)) {
      continue;
    }
    request[key] = legacyParams[key];
  }

  if (!request.kind) {
    const topLevelKind = typeof legacyParams.kind === "string" ? legacyParams.kind.trim() : "";
    if (topLevelKind && topLevelKind !== "act") {
      request.kind = topLevelKind.toLowerCase();
    }
  }

  const requestKind = typeof request.kind === "string" ? request.kind.trim().toLowerCase() : "";
  if (requestKind === "scroll") {
    if (Object.hasOwn(request, "x")) {
      request.x = normalizeScrollCoordinate(request.x);
    }
    if (Object.hasOwn(request, "y")) {
      request.y = normalizeScrollCoordinate(request.y);
    }
  }

  return request;
}

type BrowserProxyFile = {
  path: string;
  base64: string;
  mimeType?: string;
};

type BrowserProxyResult = {
  result: unknown;
  files?: BrowserProxyFile[];
};

const DEFAULT_BROWSER_PROXY_TIMEOUT_MS = 20_000;
const BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS = 5_000;

type BrowserNodeTarget = {
  nodeId: string;
  label?: string;
};

function isBrowserNode(node: {
  caps?: unknown;
  commands?: unknown;
}) {
  const caps = Array.isArray(node.caps) ? node.caps : [];
  const commands = Array.isArray(node.commands) ? node.commands : [];
  return caps.includes("browser") || commands.includes("browser.proxy");
}

async function resolveBrowserNodeTarget(params: {
  requestedNode?: string;
  target?: "sandbox" | "host" | "node";
  sandboxBridgeUrl?: string;
}): Promise<BrowserNodeTarget | null> {
  const cfg = loadBrowserConfig();
  const policy = cfg.gateway?.nodes?.browser;
  const mode = policy?.mode ?? "auto";
  if (mode === "off") {
    if (params.target === "node" || params.requestedNode) {
      throw new Error("Node browser proxy is disabled (gateway.nodes.browser.mode=off).");
    }
    return null;
  }
  if (params.sandboxBridgeUrl?.trim() && params.target !== "node" && !params.requestedNode) {
    return null;
  }
  if (params.target && params.target !== "node") {
    return null;
  }
  if (mode === "manual" && params.target !== "node" && !params.requestedNode) {
    return null;
  }

  const { listNodes, resolveNodeIdFromList, selectDefaultNodeFromList } = await import(
    "./nodes-utils.js"
  );
  const nodes = await listNodes({});
  const browserNodes = nodes.filter((node) => node.connected && isBrowserNode(node));
  if (browserNodes.length === 0) {
    if (params.target === "node" || params.requestedNode) {
      throw new Error("No connected browser-capable nodes.");
    }
    return null;
  }

  const requested = params.requestedNode?.trim() || policy?.node?.trim();
  if (requested) {
    const nodeId = resolveNodeIdFromList(browserNodes, requested, false);
    const node = browserNodes.find((entry) => entry.nodeId === nodeId);
    return { nodeId, label: node?.displayName ?? node?.remoteIp ?? nodeId };
  }

  const selected = selectDefaultNodeFromList(browserNodes, {
    preferLocalMac: false,
    fallback: "none",
  });

  if (params.target === "node") {
    if (selected) {
      return {
        nodeId: selected.nodeId,
        label: selected.displayName ?? selected.remoteIp ?? selected.nodeId,
      };
    }
    throw new Error(
      `Multiple browser-capable nodes connected (${browserNodes.length}). Set gateway.nodes.browser.node or pass node=<id>.`,
    );
  }

  if (mode === "manual") {
    return null;
  }

  if (selected) {
    return {
      nodeId: selected.nodeId,
      label: selected.displayName ?? selected.remoteIp ?? selected.nodeId,
    };
  }
  return null;
}

async function callBrowserProxy(params: {
  nodeId: string;
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
}): Promise<BrowserProxyResult> {
  const { callGatewayTool } = await import("./gateway.js");
  const proxyTimeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(1, Math.floor(params.timeoutMs))
      : DEFAULT_BROWSER_PROXY_TIMEOUT_MS;
  const gatewayTimeoutMs = proxyTimeoutMs + BROWSER_PROXY_GATEWAY_TIMEOUT_SLACK_MS;
  const payload = await callGatewayTool<{ payloadJSON?: string; payload?: string }>(
    "node.invoke",
    { timeoutMs: gatewayTimeoutMs },
    {
      nodeId: params.nodeId,
      command: "browser.proxy",
      params: {
        method: params.method,
        path: params.path,
        query: params.query,
        body: params.body,
        timeoutMs: proxyTimeoutMs,
        profile: params.profile,
      },
      idempotencyKey: crypto.randomUUID(),
    },
  );
  const parsed =
    payload?.payload ??
    (typeof payload?.payloadJSON === "string" && payload.payloadJSON
      ? (JSON.parse(payload.payloadJSON) as BrowserProxyResult)
      : null);
  if (!parsed || typeof parsed !== "object" || !("result" in parsed)) {
    throw new Error("browser proxy failed");
  }
  return parsed;
}

async function persistProxyFiles(files: BrowserProxyFile[] | undefined) {
  return await persistBrowserProxyFiles(files);
}

function applyProxyPaths(result: unknown, mapping: Map<string, string>) {
  applyBrowserProxyPaths(result, mapping);
}

function resolveBrowserBaseUrl(params: {
  target?: "sandbox" | "host";
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
}): string | undefined {
  const cfg = loadBrowserConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const normalizedSandbox = params.sandboxBridgeUrl?.trim() ?? "";
  const target = params.target ?? (normalizedSandbox ? "sandbox" : "host");

  if (target === "sandbox") {
    if (!normalizedSandbox) {
      throw new Error(
        'Sandbox browser is unavailable. Enable agents.defaults.sandbox.browser.enabled or use target="host" if allowed.',
      );
    }
    return normalizedSandbox.replace(/\/$/, "");
  }

  if (params.allowHostControl === false) {
    throw new Error("Host browser control is disabled by sandbox policy.");
  }
  if (!resolved.enabled) {
    throw new Error(
      "Browser control is disabled. Set browser.enabled=true in ~/.runtime/runtime.json.",
    );
  }
  return undefined;
}

export function createBrowserTool(opts?: {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  agentSessionKey?: string;
}): AnyAgentTool {
  const targetDefault = opts?.sandboxBridgeUrl ? "sandbox" : "host";
  const hostHint =
    opts?.allowHostControl === false ? "Host target blocked by policy." : "Host target allowed.";
  const extensionProfileEnabled = process.env.RUNTIME_DISABLE_EXTENSION_PROFILE !== "1";
  const profileGuidance = extensionProfileEnabled
    ? [
        'Profiles: use profile="chrome" for Chrome extension relay takeover (your existing Chrome tabs). Use profile="runtime" for the isolated runtime-managed browser.',
        'If the user mentions the Chrome extension / Browser Relay / toolbar button / “attach tab”, ALWAYS use profile="chrome" (do not ask which profile).',
        "Chrome extension relay needs an attached tab: user must click the Runtime Browser Relay toolbar icon on the tab (badge ON). If no tab is connected, ask them to attach it.",
      ]
    : [
        'Profiles: use the default attached-browser profile unless the user explicitly requests a different browser profile by name.',
      ];
  return {
    label: "Browser",
    name: "browser",
    description: [
      "Control the browser via Runtime's browser control server (status/start/stop/profiles/tabs/open/snapshot/screenshot/actions).",
      ...profileGuidance,
      'When a node-hosted browser proxy is available, the tool may auto-route to it. Pin a node with node=<id|name> or target="node".',
      "When using refs from snapshot (e.g. e12), keep the same tab: prefer passing targetId from the snapshot response into subsequent actions (act/click/type/etc).",
      'For stable, self-resolving refs across calls, use snapshot with refs="aria" (Playwright aria-ref ids). Default refs="role" are role+name-based.',
      'Use snapshot plus concrete browser actions for UI automation. Prefer direct click/type/press/scroll/select/fill requests tied to fresh refs from the latest snapshot.',
      'Use action="act" only for a structured low-level request object (or top-level kind+fields after normalization). Do not send free-text browser goals or natural-language act requests.',
      "Use extract to capture visible text/content from the current page or a narrowed foreground surface. Avoid using repeated broad snapshots when the task is to copy or read visible content.",
      "Avoid act:wait by default; use only in exceptional cases when no reliable UI state exists.",
      `target selects browser location (sandbox|host|node). Default: ${targetDefault}.`,
      hostHint,
    ].join(" "),
    parameters: BrowserToolSchema,
    execute: async (_toolCallId, args) => {
      const params = normalizeBrowserToolParams(args as Record<string, unknown>);
      const action = readStringParam(params, "action", { required: true });
      let profile = readStringParam(params, "profile");
      const requestedNode = readStringParam(params, "node");
      let target = readStringParam(params, "target") as "sandbox" | "host" | "node" | undefined;

      if (!extensionProfileEnabled && profile === "chrome") {
        profile = undefined;
      }

      if (requestedNode && target && target !== "node") {
        throw new Error('node is only supported with target="node".');
      }

      if (extensionProfileEnabled && !target && !requestedNode && profile === "chrome") {
        // Chrome extension relay takeover is a host Chrome feature; prefer host unless explicitly targeting a node.
        target = "host";
      }

      const nodeTarget = await resolveBrowserNodeTarget({
        requestedNode: requestedNode ?? undefined,
        target,
        sandboxBridgeUrl: opts?.sandboxBridgeUrl,
      });

      const resolvedTarget = target === "node" ? undefined : target;
      const baseUrl = nodeTarget
        ? undefined
        : resolveBrowserBaseUrl({
            target: resolvedTarget,
            sandboxBridgeUrl: opts?.sandboxBridgeUrl,
            allowHostControl: opts?.allowHostControl,
          });

      const proxyRequest = nodeTarget
        ? async (opts: {
            method: string;
            path: string;
            query?: Record<string, string | number | boolean | undefined>;
            body?: unknown;
            timeoutMs?: number;
            profile?: string;
          }) => {
            const proxy = await callBrowserProxy({
              nodeId: nodeTarget.nodeId,
              method: opts.method,
              path: opts.path,
              query: opts.query,
              body: opts.body,
              timeoutMs: opts.timeoutMs,
              profile: opts.profile,
            });
            const mapping = await persistProxyFiles(proxy.files);
            applyProxyPaths(proxy.result, mapping);
            return proxy.result;
          }
        : null;

      switch (action) {
        case "status":
          if (proxyRequest) {
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
              }),
            );
          }
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "start":
          if (proxyRequest) {
            await proxyRequest({
              method: "POST",
              path: "/start",
              profile,
            });
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
              }),
            );
          }
          await browserStart(baseUrl, { profile });
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "stop":
          if (proxyRequest) {
            await proxyRequest({
              method: "POST",
              path: "/stop",
              profile,
            });
            return jsonResult(
              await proxyRequest({
                method: "GET",
                path: "/",
                profile,
              }),
            );
          }
          await browserStop(baseUrl, { profile });
          return jsonResult(await browserStatus(baseUrl, { profile }));
        case "profiles":
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "GET",
              path: "/profiles",
            });
            return jsonResult(result);
          }
          return jsonResult({ profiles: await browserProfiles(baseUrl) });
        case "tabs":
          return await executeTabsAction({ baseUrl, profile, proxyRequest });
        case "open": {
          const targetUrl = readTargetUrlParam(params);
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/tabs/open",
              profile,
              body: { url: targetUrl },
            });
            return jsonResult(result);
          }
          const opened = await browserOpenTab(baseUrl, targetUrl, { profile });
          trackSessionBrowserTab({
            sessionKey: opts?.agentSessionKey,
            targetId: opened.targetId,
            baseUrl,
            profile,
          });
          return jsonResult(opened);
        }
        case "focus": {
          const targetId = readStringParam(params, "targetId", {
            required: true,
          });
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/tabs/focus",
              profile,
              body: { targetId },
            });
            return jsonResult(result);
          }
          await browserFocusTab(baseUrl, targetId, { profile });
          return jsonResult({ ok: true });
        }
        case "close": {
          const targetId = readStringParam(params, "targetId");
          if (proxyRequest) {
            const result = targetId
              ? await proxyRequest({
                  method: "DELETE",
                  path: `/tabs/${encodeURIComponent(targetId)}`,
                  profile,
                })
              : await proxyRequest({
                  method: "POST",
                  path: "/act",
                  profile,
                  body: { kind: "close" },
                });
            return jsonResult(result);
          }
          if (targetId) {
            await browserCloseTab(baseUrl, targetId, { profile });
            untrackSessionBrowserTab({
              sessionKey: opts?.agentSessionKey,
              targetId,
              baseUrl,
              profile,
            });
          } else {
            await browserAct(baseUrl, { kind: "close" }, { profile });
          }
          return jsonResult({ ok: true });
        }
        case "snapshot":
          return await executeSnapshotAction({
            input: params,
            baseUrl,
            profile,
            proxyRequest,
          });
        case "extract":
          return await executeExtractAction({
            input: params,
            baseUrl,
            profile,
            proxyRequest,
          });
        case "screenshot": {
          const targetId = readStringParam(params, "targetId");
          const fullPage = Boolean(params.fullPage);
          const ref = readStringParam(params, "ref");
          const element = readStringParam(params, "element");
          const type = params.type === "jpeg" ? "jpeg" : "png";
          const result = proxyRequest
            ? ((await proxyRequest({
                method: "POST",
                path: "/screenshot",
                profile,
                body: {
                  targetId,
                  fullPage,
                  ref,
                  element,
                  type,
                },
              })) as Awaited<ReturnType<typeof browserScreenshotAction>>)
            : await browserScreenshotAction(baseUrl, {
                targetId,
                fullPage,
                ref,
                element,
                type,
                profile,
              });
          return await imageResultFromFile({
            label: "browser:screenshot",
            path: result.path,
            details: result,
          });
        }
        case "navigate": {
          const targetUrl = readTargetUrlParam(params);
          const targetId = readStringParam(params, "targetId");
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/navigate",
              profile,
              body: {
                url: targetUrl,
                targetId,
              },
            });
            return jsonResult(result);
          }
          return jsonResult(
            await browserNavigate(baseUrl, {
              url: targetUrl,
              targetId,
              profile,
            }),
          );
        }
        case "console":
          return await executeConsoleAction({
            input: params,
            baseUrl,
            profile,
            proxyRequest,
          });
        case "pdf": {
          const targetId = typeof params.targetId === "string" ? params.targetId.trim() : undefined;
          const result = proxyRequest
            ? ((await proxyRequest({
                method: "POST",
                path: "/pdf",
                profile,
                body: { targetId },
              })) as Awaited<ReturnType<typeof browserPdfSave>>)
            : await browserPdfSave(baseUrl, { targetId, profile });
          return {
            content: [{ type: "text" as const, text: `FILE:${result.path}` }],
            details: result,
          };
        }
        case "upload": {
          const paths = Array.isArray(params.paths) ? params.paths.map((p) => String(p)) : [];
          if (paths.length === 0) {
            throw new Error("paths required");
          }
          const uploadPathsResult = await resolveExistingPathsWithinRoot({
            rootDir: DEFAULT_UPLOAD_DIR,
            requestedPaths: paths,
            scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`,
          });
          if (!uploadPathsResult.ok) {
            throw new Error(uploadPathsResult.error);
          }
          const normalizedPaths = uploadPathsResult.paths;
          const ref = readStringParam(params, "ref");
          const inputRef = readStringParam(params, "inputRef");
          const element = readStringParam(params, "element");
          const { targetId, timeoutMs } = readOptionalTargetAndTimeout(params);
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/hooks/file-chooser",
              profile,
              body: {
                paths: normalizedPaths,
                ref,
                inputRef,
                element,
                targetId,
                timeoutMs,
              },
            });
            return jsonResult(result);
          }
          return jsonResult(
            await browserArmFileChooser(baseUrl, {
              paths: normalizedPaths,
              ref,
              inputRef,
              element,
              targetId,
              timeoutMs,
              profile,
            }),
          );
        }
        case "dialog": {
          const accept = Boolean(params.accept);
          const promptText = typeof params.promptText === "string" ? params.promptText : undefined;
          const { targetId, timeoutMs } = readOptionalTargetAndTimeout(params);
          if (proxyRequest) {
            const result = await proxyRequest({
              method: "POST",
              path: "/hooks/dialog",
              profile,
              body: {
                accept,
                promptText,
                targetId,
                timeoutMs,
              },
            });
            return jsonResult(result);
          }
          return jsonResult(
            await browserArmDialog(baseUrl, {
              accept,
              promptText,
              targetId,
              timeoutMs,
              profile,
            }),
          );
        }
        case "act": {
          const request = readActRequestParam(params);
          if (!request) {
            return jsonResult({
              ok: false,
              recoverable: true,
              requiresObservation: true,
              reason:
                "The browser act request was missing. Capture a fresh snapshot and choose a fully specified action.",
              invalidRequest: {
                action: "act",
                missing: ["request"],
              },
            });
          }
          return await executeActAction({
            request,
            baseUrl,
            profile,
            proxyRequest,
          });
        }
        default:
          return unsupportedBrowserActionResult(action);
      }
    },
  };
}
