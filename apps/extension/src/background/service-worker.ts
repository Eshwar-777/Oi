/**
 * Background service worker for the OI browser extension.
 *
 * Supports multiple attached tabs under an "OI" Chrome tab group.
 * Uses Chrome Debugger API (CDP) for all page interactions.
 */
import type { UiToolRuntime } from "./tools/interfaces";
import { assertState as toolAssertState } from "./tools/assert-state";
import { locateTarget as toolLocateTarget } from "./tools/locate-target";
import { assertClickable as toolAssertClickable } from "./tools/assert-clickable";
import { resolveBlockers as toolResolveBlockers } from "./tools/resolve-blockers";
import { verifyPostcondition as toolVerifyPostcondition } from "./tools/verify-postcondition";
import { repairWithLlm as toolRepairWithLlm } from "./tools/repair-with-llm";
import {
  OI_GROUP_TITLE,
  STORAGE_KEY_ATTACHED_TABS,
  STORAGE_KEY_AUTH_REFRESH_URL,
  STORAGE_KEY_AUTH_RENEWAL,
  STORAGE_KEY_AUTH_TOKEN,
  STORAGE_KEY_FIREBASE_CONFIG,
} from "./runtime/constants";
import { attemptAuthRefresh, getAuthToken, getOrCreateDeviceId, getRelayUrl } from "./runtime/auth";
import { buildRoleSnapshot } from "./runtime/ax-snapshot";
import { buildFindByRoleScript } from "./runtime/cdp-scripts";
import { createCdpCore } from "./runtime/cdp-core";
import {
  captureAndSendScreenshot as captureAndSendScreenshotRuntime,
  captureScreenshotBase64 as captureScreenshotBase64Runtime,
  createPingController,
  createScreenshotStreamController,
} from "./runtime/media-stream";
import { handleRemoteInputCommand } from "./runtime/remote-input";
import {
  classifyActionResult,
  infobarGuardError,
  isPotentiallyUnderDebuggerInfobar,
  normalizeDisambiguation,
  tryAdjustPointForInfobar,
} from "./runtime/pure";
import {
  autoAttachTabIfInOiGroup as autoAttachTabIfInOiGroupRuntime,
  autoAttachTabsInOiGroup as autoAttachTabsInOiGroupRuntime,
  ensureOiGroup as ensureOiGroupRuntime,
  isInOiGroup as isInOiGroupRuntime,
  removeFromOiGroup as removeFromOiGroupRuntime,
} from "./runtime/tab-group";
import type {
  AXNode,
  ElementBox,
  RefEntry,
  TabInfo,
} from "./runtime/types";

let socket: WebSocket | null = null;
let deviceId = "";
let currentRunId = "";
let automationPaused = false;
let reconnectTimerId: ReturnType<typeof setTimeout> | null = null;
let isConnectingWebSocket = false;
let relayState: "connecting" | "connected" | "error" = "connecting";
let relayError = "";
let isRefreshingAuth = false;
let suppressNextCloseError = false;

const attachedTabs = new Map<number, TabInfo>();
const debuggerAttachedTabs = new Set<number>();
const autoAttachInFlight = new Set<number>();

// Ref map for aria snapshot — maps e0, e1... to role+name for locator resolution
const refMapByTab = new Map<number, Record<string, RefEntry>>();
const snapshotIdByTab = new Map<number, string>();
const tabCommandQueues = new Map<number, Promise<void>>();
const recentConsoleEventsByTab = new Map<number, Array<Record<string, unknown>>>();
const recentNetworkFailuresByTab = new Map<number, Array<Record<string, unknown>>>();
const cdpCore = createCdpCore(debuggerAttachedTabs);
const { cdp, cdpEval, ensureDebugger, findElementBox, clickPoint, findByBackendNodeId, scanUiBlockers } = cdpCore;
const screenshotStreamController = createScreenshotStreamController({
  getAutomationPaused: () => automationPaused,
  getFirstAttachedTabId,
  getCurrentRunId: () => currentRunId,
  getSocket: () => socket,
  debuggerAttachedTabs,
  onError: (error) => console.warn("[OI Extension] Screenshot stream error:", error),
});
const pingController = createPingController(() => socket);

function getRefMapForTab(tabId: number): Record<string, RefEntry> {
  return refMapByTab.get(tabId) ?? {};
}

function pushRecentEvent(
  store: Map<number, Array<Record<string, unknown>>>,
  tabId: number,
  event: Record<string, unknown>,
): void {
  const current = store.get(tabId) ?? [];
  current.push(event);
  if (current.length > 30) current.splice(0, current.length - 30);
  store.set(tabId, current);
}

function validateTargetIdentity(tabId: number, targetId?: string): string | null {
  const expectedPrefix = `tab:${tabId}`;
  const raw = String(targetId || "").trim();
  if (!raw) return null;
  if (!raw.startsWith(expectedPrefix)) {
    return `Stale targetId '${raw}' does not match current tab '${expectedPrefix}'`;
  }
  return null;
}

async function enqueueTabCommand<T>(tabId: number, task: () => Promise<T>): Promise<T> {
  const previous = tabCommandQueues.get(tabId) ?? Promise.resolve();
  const runPromise = previous
    .catch(() => undefined)
    .then(task);
  const queued = runPromise
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (tabCommandQueues.get(tabId) === queued) {
        tabCommandQueues.delete(tabId);
      }
    });
  tabCommandQueues.set(tabId, queued);
  return runPromise;
}

function getFirstAttachedTabId(): number | null {
  const first = attachedTabs.keys().next();
  return first.done ? null : (first.value as number);
}

// =========================================================================
// OI Tab Group management
// =========================================================================

async function ensureOiGroup(tabId: number): Promise<void> {
  await ensureOiGroupRuntime(tabId);
}

async function removeFromOiGroup(tabId: number): Promise<void> {
  await removeFromOiGroupRuntime(tabId);
}

async function isInOiGroup(tabId: number): Promise<boolean> {
  return isInOiGroupRuntime(tabId);
}

async function autoAttachTabIfInOiGroup(tabId: number, tabHint?: chrome.tabs.Tab): Promise<void> {
  await autoAttachTabIfInOiGroupRuntime(
    tabId,
    {
      attachedTabs,
      autoAttachInFlight,
      persistAttachedTabs,
      setAttachBadge,
      sendTabAttached,
    },
    tabHint,
  );
}

async function autoAttachTabsInOiGroup(): Promise<void> {
  await autoAttachTabsInOiGroupRuntime({
    attachedTabs,
    autoAttachInFlight,
    persistAttachedTabs,
    setAttachBadge,
    sendTabAttached,
  });
}

// =========================================================================
// CDP helpers — interact with any page via Chrome Debugger API
// =========================================================================

function createUiToolRuntime(): UiToolRuntime {
  return {
    cdp,
    cdpEval,
    sleep,
    pressKey: async (tabId: number, key: string) => {
      await cdpKeyboard(tabId, key);
    },
    clickPoint,
  };
}

async function cdpClick(tabId: number, target: unknown, disambiguation?: unknown): Promise<string> {
  const runtime = createUiToolRuntime();
  await toolAssertState(runtime, tabId, {});

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const located = await toolLocateTarget(runtime, tabId, target, normalizeDisambiguation(disambiguation));
    if (!located.ok || typeof located.x !== "number" || typeof located.y !== "number") {
      return located.reason || "Element not found";
    }

    const blocker = await toolResolveBlockers(runtime, tabId, { x: located.x, y: located.y });
    if (blocker.status === "escalate") {
      return `Manual intervention required (${blocker.blockerClass}): ${blocker.details}`;
    }
    if (blocker.status === "failed") return `Not clickable: blocker-${blocker.blockerClass}`;

    const clickable = await toolAssertClickable(runtime, tabId, located.x, located.y);
    if (!clickable.ok) {
      if (attempt < 3) {
        await toolRepairWithLlm(runtime, tabId, {
          action: "click",
          target,
          failureReason: clickable.reason,
        });
        await sleep(120 + attempt * 120);
        continue;
      }
      return `Not clickable: ${clickable.reason}`;
    }

    const adjusted = tryAdjustPointForInfobar(located.box, located.x, located.y);
    if (isPotentiallyUnderDebuggerInfobar(adjusted.y)) {
      return infobarGuardError(located.y);
    }

    await clickPoint(tabId, adjusted.x, adjusted.y);
    const verified = await toolVerifyPostcondition(runtime, tabId, { action: "click", target });
    if (!verified.ok && attempt < 3) {
      await sleep(120 + attempt * 120);
      continue;
    }
    const label = located.box?.description || "coordinates";
    return `Clicked: ${label} at (${adjusted.x},${adjusted.y})`;
  }
  return "Not clickable: unresolved-blocker";
}

async function prepareEditableElementAtPoint(
  tabId: number,
  x: number,
  y: number,
): Promise<{ ok: boolean; reason: string }> {
  const result = (await cdpEval(
    tabId,
    `
    (function() {
      const hit = document.elementFromPoint(${x}, ${y});
      const candidate = hit instanceof Element
        ? hit.closest('input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"]')
        : null;
      if (!candidate || !(candidate instanceof HTMLElement)) {
        return { ok: false, reason: "no-editable-target-at-point" };
      }
      candidate.focus();
      const active = document.activeElement;
      if (active !== candidate) {
        return { ok: false, reason: "focus-did-not-land-on-target" };
      }
      if (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) {
        candidate.value = "";
        candidate.dispatchEvent(new Event("input", { bubbles: true }));
        return { ok: true, reason: "prepared-form-control" };
      }
      if (candidate.isContentEditable) {
        candidate.textContent = "";
        candidate.dispatchEvent(new Event("input", { bubbles: true }));
        return { ok: true, reason: "prepared-contenteditable" };
      }
      const role = (candidate.getAttribute("role") || "").toLowerCase();
      if (role === "textbox" || role === "combobox") {
        candidate.textContent = "";
        candidate.dispatchEvent(new Event("input", { bubbles: true }));
        return { ok: true, reason: "prepared-role-editable" };
      }
      return { ok: false, reason: "target-not-editable" };
    })()
  `,
  )) as { ok?: boolean; reason?: string };
  return {
    ok: Boolean(result?.ok),
    reason: String(result?.reason || "prepare-editable-unknown"),
  };
}

async function cdpType(tabId: number, target: unknown, text: string, disambiguation?: unknown): Promise<string> {
  const runtime = createUiToolRuntime();
  await toolAssertState(runtime, tabId, {});
  const located = await toolLocateTarget(runtime, tabId, target, normalizeDisambiguation(disambiguation));
  if (!located.ok || typeof located.x !== "number" || typeof located.y !== "number") {
    return located.reason || "Element not found";
  }
  const blocker = await toolResolveBlockers(runtime, tabId, { x: located.x, y: located.y });
  if (blocker.status === "escalate") {
    return `Manual intervention required (${blocker.blockerClass}): ${blocker.details}`;
  }
  if (blocker.status === "failed") return `Not editable: blocker-${blocker.blockerClass}`;
  const clickable = await toolAssertClickable(runtime, tabId, located.x, located.y);
  if (!clickable.ok) return `Not editable: ${clickable.reason}`;
  const adjusted = tryAdjustPointForInfobar(located.box, located.x, located.y);
  if (isPotentiallyUnderDebuggerInfobar(adjusted.y)) {
    return infobarGuardError(located.y);
  }
  await clickPoint(tabId, adjusted.x, adjusted.y);
  await sleep(100);
  const prepared = await prepareEditableElementAtPoint(tabId, adjusted.x, adjusted.y);
  if (!prepared.ok) return `Not editable: ${prepared.reason}`;
  await cdp(tabId, "Input.insertText", { text });
  const verified = await toolVerifyPostcondition(runtime, tabId, {
    action: "type",
    target,
    intendedValue: text,
  });
  if (!verified.ok) return `Not editable: postcondition-${verified.reason}`;
  return `Typed into: ${located.box?.description || "target"}`;
}

async function cdpScroll(tabId: number, target: unknown, deltaY?: number, deltaX?: number): Promise<string> {
  let x = 400, y = 400;
  if (target && (typeof target === "string" ? target.length > 0 : true)) {
    const box = await findElementBox(tabId, target);
    if (box.found) { x = Math.round(box.x); y = Math.round(box.y); }
  }
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: deltaX ?? 0, deltaY: deltaY ?? 300 });
  return `Scrolled by (${deltaX ?? 0}, ${deltaY ?? 300})`;
}

async function cdpHover(tabId: number, target: unknown, disambiguation?: unknown): Promise<string> {
  const runtime = createUiToolRuntime();
  const located = await toolLocateTarget(runtime, tabId, target, normalizeDisambiguation(disambiguation));
  if (!located.ok || typeof located.x !== "number" || typeof located.y !== "number") {
    return located.reason || "Element not found";
  }
  const clickable = await toolAssertClickable(runtime, tabId, located.x, located.y);
  if (!clickable.ok) return `Not hoverable: ${clickable.reason}`;
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(located.x), y: Math.round(located.y) });
  return `Hovered: ${located.box?.description || "target"}`;
}

async function cdpKeyboard(tabId: number, key: string): Promise<string> {
  const keyMap: Record<string, { keyCode: number; code: string; text?: string }> = {
    Enter: { keyCode: 13, code: "Enter", text: "\r" },
    Tab: { keyCode: 9, code: "Tab" },
    Escape: { keyCode: 27, code: "Escape" },
    Backspace: { keyCode: 8, code: "Backspace" },
    Delete: { keyCode: 46, code: "Delete" },
    ArrowUp: { keyCode: 38, code: "ArrowUp" },
    ArrowDown: { keyCode: 40, code: "ArrowDown" },
    ArrowLeft: { keyCode: 37, code: "ArrowLeft" },
    ArrowRight: { keyCode: 39, code: "ArrowRight" },
    Space: { keyCode: 32, code: "Space", text: " " },
    " ": { keyCode: 32, code: "Space", text: " " },
  };
  await ensureDebugger(tabId);
  const mapped = keyMap[key];
  if (mapped) {
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", key, windowsVirtualKeyCode: mapped.keyCode, nativeVirtualKeyCode: mapped.keyCode, code: mapped.code });
    if (mapped.text) await cdp(tabId, "Input.dispatchKeyEvent", { type: "char", text: mapped.text, key, code: mapped.code });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: mapped.keyCode, code: mapped.code });
  } else if (key.length === 1) {
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", text: key, key });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "char", text: key, key });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key });
  } else {
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key });
  }
  return `Key pressed: ${key}`;
}

async function cdpWait(tabId: number, target: unknown, value: unknown): Promise<string> {
  const hasTarget =
    target !== undefined &&
    target !== null &&
    !(
      typeof target === "string" &&
      target.trim().length === 0
    );
  if (!hasTarget) {
    const ms = typeof value === "number" ? value : 2000;
    await sleep(ms);
    return `Waited ${ms}ms`;
  }
  const runtime = createUiToolRuntime();
  const start = Date.now();
  const timeout = 10000;
  while (Date.now() - start < timeout) {
    const located = await toolLocateTarget(runtime, tabId, target, normalizeDisambiguation(undefined));
    if (located.ok) {
      return `Found: ${located.box?.description || "target"} after ${Date.now() - start}ms`;
    }
    await sleep(500);
  }
  return `Timeout waiting for: ${JSON.stringify(target)}`;
}

async function cdpSelect(tabId: number, target: unknown, value: string, disambiguation?: unknown): Promise<string> {
  const runtime = createUiToolRuntime();
  await toolAssertState(runtime, tabId, {});
  const located = await toolLocateTarget(runtime, tabId, target, normalizeDisambiguation(disambiguation));
  if (!located.ok || typeof located.x !== "number" || typeof located.y !== "number") {
    return located.reason || "Element not found";
  }
  const blocker = await toolResolveBlockers(runtime, tabId, { x: located.x, y: located.y });
  if (blocker.status === "escalate") {
    return `Manual intervention required (${blocker.blockerClass}): ${blocker.details}`;
  }
  if (blocker.status === "failed") return `Not selectable: blocker-${blocker.blockerClass}`;
  const adjusted = tryAdjustPointForInfobar(located.box, located.x, located.y);
  if (isPotentiallyUnderDebuggerInfobar(adjusted.y)) {
    return infobarGuardError(located.y);
  }
  await clickPoint(tabId, adjusted.x, adjusted.y);
  await cdpEval(tabId, `
    (function() {
      const hit = document.elementFromPoint(${adjusted.x}, ${adjusted.y});
      const candidate = hit?.closest('select')
        || hit?.querySelector?.('select')
        || (hit instanceof HTMLLabelElement ? (hit.control instanceof HTMLSelectElement ? hit.control : null) : null);
      if (candidate && candidate.tagName === 'SELECT') {
        candidate.value = ${JSON.stringify(value)};
        candidate.dispatchEvent(new Event('input', { bubbles: true }));
        candidate.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()
  `);
  const verified = await toolVerifyPostcondition(runtime, tabId, {
    action: "select",
    target,
    intendedValue: value,
  });
  if (!verified.ok) return `Not selectable: postcondition-${verified.reason}`;
  return `Selected "${value}" in: ${located.box?.description || "target"}`;
}

async function cdpReadDom(tabId: number, target: unknown): Promise<string> {
  const expr = target && typeof target === "string" && target.length > 0
    ? `(document.querySelector(${JSON.stringify(target)}) || document.body).textContent.substring(0, 5000)`
    : `document.body.textContent.substring(0, 5000)`;
  const text = await cdpEval(tabId, expr) as string;
  return text ?? "";
}

async function cdpMediaState(tabId: number): Promise<string> {
  const state = await cdpEval(tabId, `
    (function() {
      const mediaEls = Array.from(document.querySelectorAll('video, audio'));
      if (!mediaEls.length) {
        return JSON.stringify({
          hasMedia: false,
          mediaCount: 0,
          playingCount: 0,
          maxCurrentTime: 0,
          sample: []
        });
      }
      const sample = mediaEls.slice(0, 5).map((m) => ({
        tag: m.tagName.toLowerCase(),
        paused: !!m.paused,
        currentTime: Number(m.currentTime || 0),
        readyState: Number(m.readyState || 0),
        ended: !!m.ended,
        muted: !!m.muted,
        playbackRate: Number(m.playbackRate || 1),
      }));
      const playing = mediaEls.filter((m) => !m.paused && !m.ended && Number(m.readyState || 0) >= 2);
      const maxCurrentTime = mediaEls.reduce((acc, m) => Math.max(acc, Number(m.currentTime || 0)), 0);
      return JSON.stringify({
        hasMedia: true,
        mediaCount: mediaEls.length,
        playingCount: playing.length,
        maxCurrentTime: Number(maxCurrentTime || 0),
        sample
      });
    })()
  `) as string;
  return state ?? "{}";
}

async function cdpExtractStructured(tabId: number): Promise<string> {
  const result = await cdpEval(tabId, `
    (function() {
      const elements = [];
      const interactable = document.querySelectorAll(
        "a, button, input, select, textarea, [role='button'], [role='link'], [role='textbox'], [role='combobox'], [onclick]"
      );
      interactable.forEach(function(el, idx) {
        if (idx > 200) return;
        if (el.offsetParent === null && el.tagName !== 'BODY') return;
        const rect = el.getBoundingClientRect();
        elements.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          type: el.type || '',
          text: (el.textContent || '').trim().substring(0, 100),
          ariaLabel: el.getAttribute('aria-label') || '',
          placeholder: el.getAttribute('placeholder') || '',
          href: el.href || '',
          name: el.getAttribute('name') || '',
          id: el.id || '',
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          visible: rect.width > 0 && rect.height > 0,
        });
      });
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return JSON.stringify({
        url: location.href,
        title: document.title,
        elements: elements,
        viewport: { w: innerWidth, h: innerHeight },
        scrollY: scrollY,
        activeElement: active ? {
          tag: active.tagName.toLowerCase(),
          role: active.getAttribute('role') || '',
          ariaLabel: active.getAttribute('aria-label') || '',
          placeholder: active.getAttribute('placeholder') || '',
          editable:
            active.isContentEditable
            || active.tagName === 'INPUT'
            || active.tagName === 'TEXTAREA'
            || active.getAttribute('role') === 'textbox'
            || active.getAttribute('role') === 'combobox',
        } : null,
      });
    })()
  `) as string;
  return result ?? "{}";
}

async function cdpPageViewportContext(tabId: number): Promise<{
  current_url: string;
  page_title: string;
  viewport: { width: number; height: number };
  device_pixel_ratio: number;
}> {
  const result = (await cdpEval(tabId, `
    (function() {
      return {
        current_url: location.href || "",
        page_title: document.title || "",
        viewport: {
          width: Math.max(0, window.innerWidth || 0),
          height: Math.max(0, window.innerHeight || 0)
        },
        device_pixel_ratio: Number(window.devicePixelRatio || 1)
      };
    })()
  `)) as {
    current_url?: string;
    page_title?: string;
    viewport?: { width?: number; height?: number };
    device_pixel_ratio?: number;
  };
  return {
    current_url: String(result?.current_url || ""),
    page_title: String(result?.page_title || ""),
    viewport: {
      width: Number(result?.viewport?.width || 0),
      height: Number(result?.viewport?.height || 0),
    },
    device_pixel_ratio: Number(result?.device_pixel_ratio || 1),
  };
}

// =========================================================================
// Aria Snapshot + Ref System  (Playwright-style)
// =========================================================================

async function cdpScopedSnapshot(
  tabId: number,
  scopeSelector: string,
  frameSelector?: string,
  snapshotFormat = "ai",
): Promise<string> {
  const scoped = await cdpEval(tabId, `
    (function() {
      const rootDocument = document;
      const INTERACTIVE_SELECTOR = "a, button, input, select, textarea, [role], [tabindex]";
      function childElements(root) {
        if (root instanceof Document) {
          return root.documentElement ? [root.documentElement] : [];
        }
        if (root instanceof ShadowRoot || root instanceof Element) {
          return Array.from(root.children || []);
        }
        return [];
      }
      function collectSelectorMatches(root, selector) {
        const matches = [];
        const stack = childElements(root);
        while (stack.length) {
          const node = stack.shift();
          if (!(node instanceof Element)) continue;
          try {
            if (node.matches(selector)) matches.push(node);
          } catch {}
          if (node.shadowRoot) stack.unshift(...childElements(node.shadowRoot));
          stack.unshift(...childElements(node));
        }
        return matches;
      }
      function collectInteractive(root) {
        const nodes = [];
        const stack = childElements(root);
        while (stack.length && nodes.length < 250) {
          const node = stack.shift();
          if (!(node instanceof Element)) continue;
          try {
            if (node.matches(INTERACTIVE_SELECTOR)) nodes.push(node);
          } catch {}
          if (node.shadowRoot) stack.unshift(...childElements(node.shadowRoot));
          stack.unshift(...childElements(node));
        }
        return nodes;
      }
      function pickBestMatch(nodes) {
        if (!nodes.length) return null;
        const scored = nodes.map((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const z = Number.parseInt(style.zIndex || "0", 10);
          return { el, score: (Number.isFinite(z) ? z : 0) * 1000000 + (rect.width * rect.height) };
        }).sort((a, b) => b.score - a.score);
        return scored[0]?.el || null;
      }
      function matchDescriptor(el) {
        const id = el.id ? "#" + el.id : "";
        const role = el.getAttribute("role") || "";
        const cls = typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
        return (el.tagName.toLowerCase() + id + cls + (role ? "[role=" + role + "]" : "")).slice(0, 120);
      }
      let root = null;
      let frameUsed = "";
      let matchCount = 0;
      let matches = [];
      if (${JSON.stringify(frameSelector || "")}) {
        const frameCandidates = collectSelectorMatches(rootDocument, ${JSON.stringify(frameSelector || "")});
        const frameEl = pickBestMatch(frameCandidates);
        if (frameEl && frameEl.tagName === "IFRAME") {
          try {
            const frameDoc = frameEl.contentDocument;
            if (frameDoc) {
              const scopedMatches = collectSelectorMatches(frameDoc, ${JSON.stringify(scopeSelector)});
              matchCount = scopedMatches.length;
              matches = scopedMatches.slice(0, 5).map(matchDescriptor);
              root = pickBestMatch(scopedMatches);
              frameUsed = ${JSON.stringify(frameSelector || "")};
            }
          } catch {
            root = null;
          }
        }
      }
      if (!root) {
        const scopedMatches = collectSelectorMatches(rootDocument, ${JSON.stringify(scopeSelector)});
        matchCount = scopedMatches.length;
        matches = scopedMatches.slice(0, 5).map(matchDescriptor);
        root = pickBestMatch(scopedMatches);
      }
      if (!root) return { ok: false, reason: "scope-not-found", matchCount, matches };
      if (matchCount > 1) return { ok: false, reason: "scope-ambiguous", matchCount, matches };

      const nodes = collectInteractive(root).slice(0, 200);
      const duplicateCounter = new Map();
      const lines = [];
      const refs = {};
      let refIdx = 0;
      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const role = (el.getAttribute("role") || "").toLowerCase()
          || (el.tagName === "A" ? "link" : "")
          || (el.tagName === "BUTTON" ? "button" : "")
          || (el.tagName === "INPUT" ? "textbox" : "");
        const name = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.textContent || el.getAttribute("title") || "").trim().substring(0, 80);
        if (!role && !name) continue;
        const key = role + "::" + name.toLowerCase();
        const nth = duplicateCounter.get(key) || 0;
        duplicateCounter.set(key, nth + 1);
        const ref = "e" + refIdx++;
        refs[ref] = { role: role || "generic", name, nth };
        lines.push("[" + ref + "] " + (role || el.tagName.toLowerCase()) + (name ? ' "' + name + '"' : "") + (nth > 0 ? " [nth=" + nth + "]" : ""));
      }
      return {
        ok: true,
        lines,
        refs,
        frameUsed,
        matchCount,
        matches,
        currentUrl: location.href || "",
        title: document.title || "",
      };
    })()
  `) as {
    ok?: boolean;
    reason?: string;
    lines?: string[];
    refs?: Record<string, RefEntry>;
    frameUsed?: string;
    matchCount?: number;
    matches?: string[];
    currentUrl?: string;
    title?: string;
  };
  if (!scoped?.ok) {
    return JSON.stringify({
      url: "",
      title: "",
      snapshot: "",
      refCount: 0,
      snapshot_id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      targetId: `tab:${tabId}`,
      snapshotFormat: ${JSON.stringify(snapshotFormat)},
      scopeSelector,
      frame: frameSelector || "",
      scopeMatchCount: Number(scoped?.matchCount || 0),
      scopeMatches: Array.isArray(scoped?.matches) ? scoped.matches : [],
      error: String(scoped?.reason || "scope-not-found"),
    });
  }
  const snapshotId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  refMapByTab.set(tabId, scoped.refs || {});
  snapshotIdByTab.set(tabId, snapshotId);
  return JSON.stringify({
    url: scoped.currentUrl || "",
    title: scoped.title || "",
    snapshot: (scoped.lines || []).join("\\n"),
    refCount: Object.keys(scoped.refs || {}).length,
    snapshot_id: snapshotId,
    targetId: `tab:${tabId}`,
    snapshotFormat: snapshotFormat,
    scopeSelector,
    frame: scoped.frameUsed || frameSelector || "",
    scopeMatchCount: Number(scoped.matchCount || 0),
    scopeMatches: Array.isArray(scoped.matches) ? scoped.matches : [],
  });
}

async function cdpRoleSnapshot(tabId: number, frameSelector?: string): Promise<string> {
  const scoped = await cdpEval(tabId, `
    (function() {
      const rootDocument = document;
      const INTERACTIVE_SELECTOR = "a, button, input, select, textarea, [role], [tabindex]";
      function childElements(root) {
        if (root instanceof Document) {
          return root.documentElement ? [root.documentElement] : [];
        }
        if (root instanceof ShadowRoot || root instanceof Element) {
          return Array.from(root.children || []);
        }
        return [];
      }
      function collectSelectorMatches(root, selector) {
        const matches = [];
        const stack = childElements(root);
        while (stack.length) {
          const node = stack.shift();
          if (!(node instanceof Element)) continue;
          try {
            if (node.matches(selector)) matches.push(node);
          } catch {}
          if (node.shadowRoot) stack.unshift(...childElements(node.shadowRoot));
          stack.unshift(...childElements(node));
        }
        return matches;
      }
      function collectInteractive(root) {
        const nodes = [];
        const stack = childElements(root);
        while (stack.length && nodes.length < 250) {
          const node = stack.shift();
          if (!(node instanceof Element)) continue;
          try {
            if (node.matches(INTERACTIVE_SELECTOR)) nodes.push(node);
          } catch {}
          if (node.shadowRoot) stack.unshift(...childElements(node.shadowRoot));
          stack.unshift(...childElements(node));
        }
        return nodes;
      }
      function pickBestMatch(nodes) {
        if (!nodes.length) return null;
        const scored = nodes.map((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const z = Number.parseInt(style.zIndex || "0", 10);
          return { el, score: (Number.isFinite(z) ? z : 0) * 1000000 + (rect.width * rect.height) };
        }).sort((a, b) => b.score - a.score);
        return scored[0]?.el || null;
      }
      let root = rootDocument;
      let frameUsed = "";
      if (${JSON.stringify(frameSelector || "")}) {
        const frameCandidates = collectSelectorMatches(rootDocument, ${JSON.stringify(frameSelector || "")});
        const frameEl = pickBestMatch(frameCandidates);
        if (frameEl && frameEl.tagName === "IFRAME") {
          try {
            const frameDoc = frameEl.contentDocument;
            if (frameDoc) {
              root = frameDoc;
              frameUsed = ${JSON.stringify(frameSelector || "")};
            }
          } catch {}
        }
      }

      const nodes = collectInteractive(root).slice(0, 250);
      const duplicateCounter = new Map();
      const lines = [];
      const refs = {};
      let refIdx = 0;
      for (const el of nodes) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const role = (el.getAttribute("role") || "").toLowerCase()
          || (el.tagName === "A" ? "link" : "")
          || (el.tagName === "BUTTON" ? "button" : "")
          || (el.tagName === "INPUT" ? "textbox" : "");
        const name = (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.textContent || el.getAttribute("title") || "").trim().substring(0, 80);
        if (!role && !name) continue;
        const key = role + "::" + name.toLowerCase();
        const nth = duplicateCounter.get(key) || 0;
        duplicateCounter.set(key, nth + 1);
        const ref = "e" + refIdx++;
        refs[ref] = { role: role || "generic", name, nth };
        lines.push("[" + ref + "] " + (role || el.tagName.toLowerCase()) + (name ? ' "' + name + '"' : "") + (nth > 0 ? " [nth=" + nth + "]" : ""));
      }
      return {
        currentUrl: location.href || "",
        title: document.title || "",
        lines,
        refs,
        frameUsed,
      };
    })()
  `) as {
    lines?: string[];
    refs?: Record<string, RefEntry>;
    frameUsed?: string;
    currentUrl?: string;
    title?: string;
  };

  const snapshotId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  refMapByTab.set(tabId, scoped.refs || {});
  snapshotIdByTab.set(tabId, snapshotId);
  return JSON.stringify({
    url: scoped.currentUrl || "",
    title: scoped.title || "",
    snapshot: (scoped.lines || []).join("\\n"),
    refCount: Object.keys(scoped.refs || {}).length,
    snapshot_id: snapshotId,
    targetId: `tab:${tabId}`,
    snapshotFormat: "role",
    scopeSelector: "",
    frame: scoped.frameUsed || frameSelector || "",
  });
}

async function cdpScopedAriaSnapshot(tabId: number, scopeSelector: string, frameSelector?: string): Promise<string> {
  const scoped = await cdpEval(tabId, `
    (function() {
      function childElements(root) {
        if (root instanceof Document) {
          return root.documentElement ? [root.documentElement] : [];
        }
        if (root instanceof ShadowRoot || root instanceof Element) {
          return Array.from(root.children || []);
        }
        return [];
      }
      function collectSelectorMatches(root, selector) {
        const matches = [];
        const stack = childElements(root);
        while (stack.length) {
          const node = stack.shift();
          if (!(node instanceof Element)) continue;
          try {
            if (node.matches(selector)) matches.push(node);
          } catch {}
          if (node.shadowRoot) stack.unshift(...childElements(node.shadowRoot));
          stack.unshift(...childElements(node));
        }
        return matches;
      }
      function pickBestMatch(nodes) {
        if (!nodes.length) return null;
        return nodes
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const z = Number.parseInt(style.zIndex || "0", 10);
            return { el, score: (Number.isFinite(z) ? z : 0) * 1000000 + (rect.width * rect.height) };
          })
          .sort((a, b) => b.score - a.score)[0]?.el || null;
      }
      function textOf(el) {
        return (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80);
      }
      function roleOf(el) {
        return (el.getAttribute("role") || "").toLowerCase()
          || (el.tagName === "BUTTON" ? "button" : "")
          || (el.tagName === "A" ? "link" : "")
          || (el.tagName === "INPUT" ? "textbox" : "")
          || el.tagName.toLowerCase();
      }
      const rootDocument = document;
      let frameUsed = "";
      let root = null;
      let scopedMatches = [];
      if (${JSON.stringify(frameSelector || "")}) {
        const frameCandidates = collectSelectorMatches(rootDocument, ${JSON.stringify(frameSelector || "")});
        const frameEl = pickBestMatch(frameCandidates);
        if (frameEl && frameEl.tagName === "IFRAME") {
          try {
            const frameDoc = frameEl.contentDocument;
            if (frameDoc) {
              scopedMatches = collectSelectorMatches(frameDoc, ${JSON.stringify(scopeSelector)});
              root = pickBestMatch(scopedMatches);
              frameUsed = ${JSON.stringify(frameSelector || "")};
            }
          } catch {
            root = null;
          }
        }
      }
      if (!root) {
        scopedMatches = collectSelectorMatches(rootDocument, ${JSON.stringify(scopeSelector)});
        root = pickBestMatch(scopedMatches);
      }
      if (!root) return { ok: false, reason: "scope-not-found", matchCount: scopedMatches.length };
      if (scopedMatches.length > 1) return { ok: false, reason: "scope-ambiguous", matchCount: scopedMatches.length };

      const refs = {};
      const lines = [];
      let refIdx = 0;
      const seen = new Map();
      function walk(node, depth) {
        if (!(node instanceof Element)) return;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const role = roleOf(node);
        const name = textOf(node);
        if (!role && !name) return;
        const key = role + "::" + name.toLowerCase();
        const nth = seen.get(key) || 0;
        seen.set(key, nth + 1);
        const ref = "e" + refIdx++;
        refs[ref] = { role, name, nth };
        lines.push("  ".repeat(Math.min(depth, 6)) + "[" + ref + "] " + role + (name ? ' "' + name + '"' : "") + (nth > 0 ? " [nth=" + nth + "]" : ""));
        Array.from(node.children).slice(0, 40).forEach((child) => walk(child, depth + 1));
        if (node.shadowRoot) {
          Array.from(node.shadowRoot.children).slice(0, 40).forEach((child) => walk(child, depth + 1));
        }
      }
      walk(root, 0);
      return {
        ok: true,
        refs,
        lines,
        frameUsed,
        matchCount: scopedMatches.length,
        currentUrl: location.href || "",
        title: document.title || "",
      };
    })()
  `) as {
    ok?: boolean;
    reason?: string;
    refs?: Record<string, RefEntry>;
    lines?: string[];
    frameUsed?: string;
    matchCount?: number;
    currentUrl?: string;
    title?: string;
  };
  const snapshotId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!scoped?.ok) {
    return JSON.stringify({
      url: "",
      title: "",
      snapshot: "",
      refCount: 0,
      snapshot_id: snapshotId,
      targetId: `tab:${tabId}`,
      snapshotFormat: "aria",
      scopeSelector,
      frame: frameSelector || "",
      error: String(scoped?.reason || "scope-not-found"),
    });
  }
  refMapByTab.set(tabId, scoped.refs || {});
  snapshotIdByTab.set(tabId, snapshotId);
  return JSON.stringify({
    url: scoped.currentUrl || "",
    title: scoped.title || "",
    snapshot: (scoped.lines || []).join("\\n"),
    refCount: Object.keys(scoped.refs || {}).length,
    snapshot_id: snapshotId,
    targetId: `tab:${tabId}`,
    snapshotFormat: "aria",
    scopeSelector,
    frame: scoped.frameUsed || frameSelector || "",
    scopeMatchCount: Number(scoped.matchCount || 0),
  });
}

async function cdpAriaSnapshot(
  tabId: number,
  options?: { snapshotFormat?: string; scopeSelector?: string; frame?: string; targetId?: string },
): Promise<string> {
  const snapshotFormat = String(options?.snapshotFormat || "ai").toLowerCase();
  const scopeSelector = String(options?.scopeSelector || "");
  const frame = String(options?.frame || "");
  if (scopeSelector) {
    if (snapshotFormat === "aria") {
      return cdpScopedAriaSnapshot(tabId, scopeSelector, frame || undefined);
    }
    if (snapshotFormat === "role") {
      return cdpScopedSnapshot(tabId, scopeSelector, frame || undefined, "role");
    }
    return cdpScopedSnapshot(tabId, scopeSelector, frame || undefined, "ai");
  }
  if (snapshotFormat === "role") {
    return cdpRoleSnapshot(tabId, frame || undefined);
  }
  // Enable accessibility domain and get the full tree
  await cdp(tabId, "Accessibility.enable", {});
  const result = await cdp(tabId, "Accessibility.getFullAXTree", {}) as { nodes: AXNode[] };

  const { lines, refMap } = buildRoleSnapshot(result.nodes);
  const snapshotId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Store refs globally for act resolution
  refMapByTab.set(tabId, refMap);
  snapshotIdByTab.set(tabId, snapshotId);

  // Get page info
  const url = await cdpEval(tabId, "location.href") as string;
  const title = await cdpEval(tabId, "document.title") as string;

  return JSON.stringify({
    url: url ?? "",
    title: title ?? "",
    snapshot: lines.join("\n"),
    refCount: Object.keys(refMap).length,
    snapshot_id: snapshotId,
    targetId: String(options?.targetId || `tab:${tabId}`),
    snapshotFormat,
    scopeSelector: scopeSelector || "",
    frame: frame || "",
  });
}

async function cdpDiagnostics(tabId: number): Promise<string> {
  const pageContext = await cdpPageViewportContext(tabId);
  const blockers = await scanUiBlockers(tabId);
  const domSignals = await cdpEval(tabId, `
    (function() {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return {
        readyState: document.readyState || "",
        activeTag: active ? active.tagName.toLowerCase() : "",
        activeRole: active ? (active.getAttribute("role") || "") : "",
        activeLabel: active ? (active.getAttribute("aria-label") || active.getAttribute("placeholder") || active.textContent || "").trim().slice(0, 80) : "",
        dialogCount: document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog, .modal, [class*="modal"], .popup, [class*="popup"]').length,
        iframeCount: document.querySelectorAll("iframe").length,
        overlayCount: document.querySelectorAll('.overlay, .backdrop, [class*="overlay"], [class*="backdrop"], [class*="scrim"], [data-testid*="modal"]').length,
      };
    })()
  `) as Record<string, unknown>;
  return JSON.stringify({
    current_url: pageContext.current_url,
    page_title: pageContext.page_title,
    viewport: pageContext.viewport,
    device_pixel_ratio: pageContext.device_pixel_ratio,
    blockers,
    console: recentConsoleEventsByTab.get(tabId) ?? [],
    network_failures: recentNetworkFailuresByTab.get(tabId) ?? [],
    dom: domSignals ?? {},
    targetId: `tab:${tabId}`,
  });
}

async function cdpActByRef(
  tabId: number,
  ref: string,
  kind: string,
  value?: string,
): Promise<string> {
  const runtime = createUiToolRuntime();
  const refMap = getRefMapForTab(tabId);
  const entry = refMap[ref];
  if (!entry) return `Unknown ref: ${ref}. Take a fresh snapshot first.`;

  let box: ElementBox | null = null;
  if (typeof entry.backendDOMNodeId === "number") {
    box = await findByBackendNodeId(tabId, entry.backendDOMNodeId);
  }
  if (!box) {
    const script = buildFindByRoleScript(entry.role, entry.name, entry.nth ?? 0);
    box = await cdpEval(tabId, script) as ElementBox;
  }

  if (!box?.found) {
    const description = box?.description ?? "lookup-failed";
    return `Element not found for ${ref} (${entry.role} "${entry.name}"): ${description}`;
  }

  const x = Math.round(box.x);
  const y = Math.round(box.y);

  switch (kind) {
    case "click":
      {
        const blocker = await toolResolveBlockers(runtime, tabId, { x, y });
        if (blocker.status === "escalate") {
          return `Manual intervention required (${blocker.blockerClass}): ${blocker.details}`;
        }
        if (blocker.status === "failed") return `Not clickable: blocker-${blocker.blockerClass}`;
        const clickable = await toolAssertClickable(runtime, tabId, x, y);
        if (!clickable.ok) return `Not clickable: ${clickable.reason}`;
        const clickBox = box as ElementBox | undefined;
        const adjustedClick = tryAdjustPointForInfobar(clickBox, x, y);
        if (isPotentiallyUnderDebuggerInfobar(adjustedClick.y)) return infobarGuardError(y);
        await clickPoint(tabId, adjustedClick.x, adjustedClick.y);
        return `Clicked ${ref}: ${box.description}`;
      }

    case "type":
      {
        const blocker = await toolResolveBlockers(runtime, tabId, { x, y });
        if (blocker.status === "escalate") {
          return `Manual intervention required (${blocker.blockerClass}): ${blocker.details}`;
        }
        if (blocker.status === "failed") return `Not editable: blocker-${blocker.blockerClass}`;
        const clickable = await toolAssertClickable(runtime, tabId, x, y);
        if (!clickable.ok) return `Not editable: ${clickable.reason}`;
        const typeBox = box as ElementBox | undefined;
        const adjustedType = tryAdjustPointForInfobar(typeBox, x, y);
        if (isPotentiallyUnderDebuggerInfobar(adjustedType.y)) return infobarGuardError(y);
        await clickPoint(tabId, adjustedType.x, adjustedType.y);
        await sleep(100);
        const prepared = await prepareEditableElementAtPoint(tabId, adjustedType.x, adjustedType.y);
        if (!prepared.ok) return `Not editable: ${prepared.reason}`;
        await cdp(tabId, "Input.insertText", { text: value ?? "" });
        const verified = await toolVerifyPostcondition(runtime, tabId, {
          action: "type",
          target: { by: "role", value: entry.role, name: entry.name },
          intendedValue: value ?? "",
        });
        if (!verified.ok) return `Not editable: postcondition-${verified.reason}`;
        return `Typed into ${ref}: ${box.description}`;
      }

    case "hover":
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      return `Hovered ${ref}: ${box.description}`;

    case "select":
      {
        const blocker = await toolResolveBlockers(runtime, tabId, { x, y });
        if (blocker.status === "escalate") {
          return `Manual intervention required (${blocker.blockerClass}): ${blocker.details}`;
        }
        if (blocker.status === "failed") return `Not selectable: blocker-${blocker.blockerClass}`;
        const clickable = await toolAssertClickable(runtime, tabId, x, y);
        if (!clickable.ok) return `Not selectable: ${clickable.reason}`;
        const selectBox = box as ElementBox | undefined;
        const adjustedSelect = tryAdjustPointForInfobar(selectBox, x, y);
        if (isPotentiallyUnderDebuggerInfobar(adjustedSelect.y)) return infobarGuardError(y);
        await clickPoint(tabId, adjustedSelect.x, adjustedSelect.y);
        if (value) {
          await cdpEval(tabId, `
            (function() {
              const el = document.elementFromPoint(${adjustedSelect.x}, ${adjustedSelect.y});
              if (el && el.tagName === 'SELECT') {
                el.value = ${JSON.stringify(value)};
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            })()
          `);
          const verified = await toolVerifyPostcondition(runtime, tabId, {
            action: "select",
            target: { by: "role", value: entry.role, name: entry.name },
            intendedValue: value,
          });
          if (!verified.ok) return `Not selectable: postcondition-${verified.reason}`;
        }
        return `Selected "${value}" in ${ref}: ${box.description}`;
      }

    default:
      return `Unknown action kind: ${kind}`;
  }
}

// =========================================================================
// Device ID, relay URL, WebSocket
// =========================================================================

async function triggerSilentReauth(): Promise<void> {
  if (isRefreshingAuth) return;
  isRefreshingAuth = true;
  relayState = "connecting";
  relayError = "";
  await setAttachBadge();

  try {
    const refreshed = await attemptAuthRefresh(deviceId);
    if (!refreshed) {
      relayState = "error";
      relayError = "Authentication required. Please sign in again.";
      await setAttachBadge();
      return;
    }

    suppressNextCloseError = true;
    try { socket?.close(4001, "reauth"); } catch { /* ignore */ }
    socket = null;
    clearReconnectTimer();
    scheduleReconnect(150);
  } finally {
    isRefreshingAuth = false;
  }
}

function clearReconnectTimer(): void {
  if (reconnectTimerId !== null) {
    clearTimeout(reconnectTimerId);
    reconnectTimerId = null;
  }
}

function scheduleReconnect(delayMs = 5000): void {
  if (reconnectTimerId !== null) return;
  reconnectTimerId = setTimeout(() => {
    reconnectTimerId = null;
    void connectWebSocket();
  }, delayMs);
}

async function connectWebSocket(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (isConnectingWebSocket) return;
  isConnectingWebSocket = true;
  clearReconnectTimer();

  deviceId = await getOrCreateDeviceId();
  relayState = "connecting";
  relayError = "";
  await setAttachBadge();
  const relayUrl = await getRelayUrl();
  const ws = new WebSocket(relayUrl);
  socket = ws;

  ws.onopen = async () => {
    if (socket !== ws) return;
    isConnectingWebSocket = false;
    console.log("[OI Extension] WebSocket connected");
    relayState = "connected";
    relayError = "";
    await setAttachBadge();
    const token = await getAuthToken();
    socket?.send(JSON.stringify({
        type: "auth",
      payload: { token, device_id: deviceId },
        timestamp: new Date().toISOString(),
    }));
    startPing();
  };

  ws.onmessage = async (event) => {
    if (socket !== ws) return;
    try {
      const frame = JSON.parse(event.data);
      if (frame?.type === "error") {
        const detail = String(frame?.detail ?? "").toLowerCase();
        if (detail.includes("unauthorized") || detail.includes("invalid token")) {
          await triggerSilentReauth();
          return;
        }
      }
      await handleBackendCommand(frame);
    } catch (error) {
      console.error("[OI Extension] Failed to handle message:", error);
    }
  };

  ws.onclose = (event: CloseEvent) => {
    if (socket !== ws) return;
    isConnectingWebSocket = false;
    stopPing();
    if (suppressNextCloseError) {
      suppressNextCloseError = false;
      relayState = "connecting";
      relayError = "";
    } else {
      relayState = "error";
      relayError = event.code === 1000 ? "Closed" : `Relay disconnected (${event.code}: ${event.reason || "unknown"})`;
      console.log("[OI Extension] WebSocket closed", event.code, "— reconnecting in 5s");
    }
    setAttachBadge();
    stopScreenshotStreaming();
    socket = null;
    scheduleReconnect(5000);
  };

  ws.onerror = () => {
    if (socket !== ws) return;
    relayState = "error";
    relayError = "Relay connection failed";
    setAttachBadge();
  };
}

// =========================================================================
// Command handler
// =========================================================================

async function handleBackendCommand(frame: Record<string, unknown>): Promise<void> {
  const type = frame.type as string;

  if (type === "auth_ok") { await setAttachBadge(); await reannounceAttachedTabs(); return; }
  if (type === "pong") return;

  if (type === "extension_command") {
    const payload = frame.payload as Record<string, unknown>;
    const action = payload.action as string;
    const runId = payload.run_id as string | undefined;
    const cmdId = (payload.cmd_id as string) || null;
    const requestedTabId = payload.tab_id as number | undefined;
    const tabId = requestedTabId ?? getFirstAttachedTabId();
    if (runId) currentRunId = runId;

    const reply = (p: Record<string, unknown>) => sendResult(p, cmdId);

    try {
      const targetIdError = validateTargetIdentity(tabId, payload.targetId as string | undefined);
      if (targetIdError) {
        reply({
          action,
          status: "error",
          error_code: "STALE_REF",
          data: targetIdError,
        });
        return;
      }
      if (requestedTabId != null && !attachedTabs.has(requestedTabId)) {
        reply({
          action,
          status: "error",
          error_code: "NOT_FOUND",
          data: `Requested tab ${requestedTabId} is not attached on this device. Refusing fallback to another tab.`,
        });
        return;
      }
      if (!tabId || !attachedTabs.has(tabId)) {
        reply({
          action,
          status: "error",
          error_code: "NOT_FOUND",
          data: "No tab attached. Click Oi extension to attach this tab.",
        });
        return;
      }

      await enqueueTabCommand(tabId, async () => {
        let resultMsg = "";

    switch (action) {
      case "navigate":
            await navigateToUrl(tabId, payload.target as string, cmdId);
            return;
      case "click":
            resultMsg = await cdpClick(tabId, payload.target, payload.disambiguation);
        break;
      case "type":
            resultMsg = await cdpType(tabId, payload.target, (payload.value as string) ?? "", payload.disambiguation);
            break;
          case "scroll":
            resultMsg = await cdpScroll(tabId, payload.target, payload.y as number, payload.x as number);
            break;
          case "hover":
            resultMsg = await cdpHover(tabId, payload.target, payload.disambiguation);
            break;
          case "wait":
            resultMsg = await cdpWait(tabId, payload.target, payload.value);
            break;
          case "select":
            resultMsg = await cdpSelect(tabId, payload.target, (payload.value as string) ?? "", payload.disambiguation);
        break;
          case "keyboard":
            resultMsg = await cdpKeyboard(tabId, (payload.key as string) ?? (payload.value as string) ?? "");
        break;
      case "read_dom":
            resultMsg = await cdpReadDom(tabId, payload.target);
            break;
          case "media_state":
            resultMsg = await cdpMediaState(tabId);
            break;
          case "extract_structured":
            resultMsg = await cdpExtractStructured(tabId);
            break;
          case "snapshot":
            resultMsg = await cdpAriaSnapshot(tabId, {
              snapshotFormat: payload.snapshotFormat as string | undefined,
              scopeSelector: payload.scopeSelector as string | undefined,
              frame: payload.frame as string | undefined,
              targetId: payload.targetId as string | undefined,
            });
            {
              let parsed: Record<string, unknown> | null = null;
              try {
                parsed = JSON.parse(resultMsg) as Record<string, unknown>;
              } catch {
                parsed = null;
              }
              if (parsed && typeof parsed.error === "string" && parsed.error) {
                const errorCode = String(parsed.error) === "scope-ambiguous" ? "ELEMENT_AMBIGUOUS" : "NOT_FOUND";
                reply({
                  action,
                  status: "error",
                  error_code: errorCode,
                  data: JSON.stringify(parsed),
                });
                return;
              }
            }
            break;
          case "act": {
            const actRef = payload.ref as string;
            const actKind = payload.kind as string;
            const actValue = payload.value as string | undefined;
            const requestedSnapshotId = payload.snapshot_id as string | undefined;
            const currentSnapshotId = snapshotIdByTab.get(tabId);
            if (!actRef || !actKind) {
              reply({
                action: "act",
                status: "error",
                error_code: "INVALID_ACTION",
                data: "Missing ref or kind for act command",
              });
              return;
            }
            if (requestedSnapshotId && currentSnapshotId && requestedSnapshotId !== currentSnapshotId) {
              reply({
                action: "act",
                status: "error",
                error_code: "STALE_REF",
                data: `Stale snapshot for ref action. expected=${requestedSnapshotId} current=${currentSnapshotId}`,
              });
              return;
            }
            resultMsg = await cdpActByRef(tabId, actRef, actKind, actValue);
            break;
          }
          case "highlight": {
            const box = await findElementBox(tabId, payload.target);
            resultMsg = box.found ? `Highlighted: ${box.description}` : `Not found`;
        break;
          }
          case "screenshot":
            await captureAndSendScreenshot(tabId, payload.run_id as string);
            {
              const screenshot = await captureScreenshotBase64(tabId);
              const pageContext = await cdpPageViewportContext(tabId);
              reply({
                action: "screenshot",
                status: "done",
                data: screenshot ? "Screenshot captured" : "Screenshot capture unavailable",
                screenshot: screenshot ?? "",
                current_url: pageContext.current_url,
                page_title: pageContext.page_title,
                viewport: pageContext.viewport,
                device_pixel_ratio: pageContext.device_pixel_ratio,
                targetId: String((payload.targetId as string | undefined) || `tab:${tabId}`),
                annotated: Boolean(payload.annotated),
                frame: String((payload.frame as string | undefined) || ""),
              });
            }
            return;
          case "scan_ui_blockers": {
            const blockers = await scanUiBlockers(tabId);
            reply({
              action,
              status: "done",
              data: JSON.stringify(blockers),
            });
            return;
          }
          case "diagnostics": {
            reply({
              action,
              status: "done",
              data: await cdpDiagnostics(tabId),
            });
            return;
          }
      default:
            reply({ action, status: "error", error_code: "INVALID_ACTION", data: `Unknown action: ${action}` });
            return;
        }

        const outcome = classifyActionResult(resultMsg);
        reply({
          action,
          status: outcome.status,
          ...(outcome.errorCode ? { error_code: outcome.errorCode } : {}),
          data: resultMsg,
        });

        if (outcome.status === "done" && action !== "read_dom" && action !== "extract_structured" && action !== "media_state") {
          await sleep(400);
          await captureAndSendScreenshot(tabId, currentRunId);
        }
      });
    } catch (err) {
      console.error("[OI Extension] Action error:", action, err);
      reply({
        action,
        status: "error",
        error_code: "EXECUTION_ERROR",
        data: String(err),
      });
    }

  } else if (type === "yield_control") {
    automationPaused = true;
    stopScreenshotStreaming();
    sendResult({ action: "yield_control", status: "done", data: "Automation paused — user taking control" });
  } else if (type === "resume_automation") {
    automationPaused = false;
    const tabId = getFirstAttachedTabId();
    const screenshot = tabId ? await captureScreenshotBase64(tabId) : null;
    sendResult({ action: "resume_automation", status: "resumed", data: "Automation resumed", screenshot: screenshot ?? "" });
  } else if (type === "start_screenshot_stream") {
    const p = frame.payload as Record<string, unknown>;
    currentRunId = (p.run_id as string) ?? currentRunId;
    startScreenshotStreaming((p.interval_ms as number) ?? 1000);
  } else if (type === "stop_screenshot_stream") {
    stopScreenshotStreaming();
  } else if (type === "remote_input") {
    await handleRemoteInput(frame.payload as Record<string, unknown>);
  }
}

// =========================================================================
// Navigation
// =========================================================================

async function navigateToUrl(tabId: number, url: string, cmdId?: string | null): Promise<void> {
  if (!tabId || !attachedTabs.has(tabId)) {
    sendResult({ action: "navigate", status: "error", data: "Tab not attached." }, cmdId);
    return;
  }
  // Explicitly detach debugger before navigation to avoid "already attached" races
  try { await chrome.debugger.detach({ tabId }); } catch { /* ok if not attached */ }
  debuggerAttachedTabs.delete(tabId);
  refMapByTab.delete(tabId);
  snapshotIdByTab.delete(tabId);
  tabCommandQueues.delete(tabId);
  const tab = await chrome.tabs.update(tabId, { url, active: true });
  await ensureOiGroup(tabId);
  attachedTabs.set(tabId, { url, title: tab.title ?? "" });
  await waitForTabLoad(tabId);
  await sleep(1000);
  try { await ensureDebugger(tabId); } catch { /* will attach on first CDP call */ }
  sendResult({ action: "navigate", url, status: "done" }, cmdId);
}

function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => { chrome.tabs.get(tabId, (t) => { if (t.status === "complete") resolve(); else setTimeout(check, 300); }); };
    setTimeout(check, 500);
    setTimeout(resolve, 15000);
  });
}

// =========================================================================
// Screenshots — per-tab via CDP Page.captureScreenshot
// =========================================================================

async function captureScreenshotBase64(tabId: number): Promise<string | null> {
  return captureScreenshotBase64Runtime(tabId, debuggerAttachedTabs);
}

async function captureAndSendScreenshot(tabId: number, runId?: string): Promise<void> {
  await captureAndSendScreenshotRuntime({
    tabId,
    runId,
    currentRunId,
    socket,
    debuggerAttachedTabs,
  });
}

function startScreenshotStreaming(intervalMs: number): void {
  screenshotStreamController.start(intervalMs);
}

function stopScreenshotStreaming(): void {
  screenshotStreamController.stop();
}

function startPing(): void {
  pingController.start();
}

function stopPing(): void {
  pingController.stop();
}

// =========================================================================
// Remote input
// =========================================================================

async function handleRemoteInput(payload: Record<string, unknown>): Promise<void> {
  await handleRemoteInputCommand(payload, {
    getFirstAttachedTabId,
    enqueueTabCommand,
    ensureDebugger,
    cdp,
    onError: (error) => console.warn("[OI Extension] Remote input error:", error),
  });
}

// =========================================================================
// Tab / badge / state management
// =========================================================================

async function persistAttachedTabs(): Promise<void> {
  const entries = [...attachedTabs.entries()];
  await chrome.storage.local.set({ [STORAGE_KEY_ATTACHED_TABS]: entries });
}

async function restoreAttachedTabsFromStorage(): Promise<void> {
  const stored = await chrome.storage.local.get([STORAGE_KEY_ATTACHED_TABS, "oi_attached_tab_id"]);
  const entries = stored[STORAGE_KEY_ATTACHED_TABS] as Array<[number, TabInfo]> | undefined;

  if (entries && Array.isArray(entries)) {
    for (const [tabId, info] of entries) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.id) attachedTabs.set(tab.id, { url: tab.url ?? info.url, title: tab.title ?? info.title });
      } catch { /* tab gone */ }
    }
  } else if (stored.oi_attached_tab_id) {
    try {
      const tab = await chrome.tabs.get(stored.oi_attached_tab_id);
      if (tab?.id) attachedTabs.set(tab.id, { url: tab.url ?? "", title: tab.title ?? "" });
    } catch { /* gone */ }
    await chrome.storage.local.remove("oi_attached_tab_id");
  }
  await persistAttachedTabs();
  await autoAttachTabsInOiGroup();
}

async function reannounceAttachedTabs(): Promise<void> {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const toRemove: number[] = [];
  for (const [tabId, info] of attachedTabs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      sendTabAttached(tabId, tab.url ?? info.url, tab.title ?? info.title);
    } catch {
      toRemove.push(tabId);
    }
  }
  for (const id of toRemove) { attachedTabs.delete(id); debuggerAttachedTabs.delete(id); }
  if (toRemove.length) { await persistAttachedTabs(); await setAttachBadge(); }
}

function sendResult(payload: Record<string, unknown>, cmdId?: string | null): void {
  if (socket?.readyState === WebSocket.OPEN) {
    const out: Record<string, unknown> = { ...payload, device_id: deviceId, run_id: currentRunId };
    if (cmdId) out.cmd_id = cmdId;
    socket.send(JSON.stringify({ type: "extension_result", payload: out, timestamp: new Date().toISOString() }));
  }
}

async function setAttachBadge(): Promise<void> {
  if (relayState === "connecting") {
    await chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
    await chrome.action.setBadgeText({ text: "..." });
    await chrome.action.setTitle({ title: "Oi: Connecting to relay..." });
    return;
  }
  if (relayState === "error") {
    await chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({ title: `Oi: ${relayError || "Relay not reachable"}` });
    return;
  }
  const count = attachedTabs.size;
  await chrome.action.setBadgeBackgroundColor({ color: count > 0 ? "#0a7f2e" : "#6b7280" });
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  await chrome.action.setTitle({
    title: count > 0
      ? `Oi: ${count} tab${count > 1 ? "s" : ""} attached`
      : "Oi: Click to attach current tab",
  });
}

function sendTabAttached(tabId: number, url: string, title: string): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: "target_attached",
      payload: { device_id: deviceId, tab_id: tabId, url, title },
      timestamp: new Date().toISOString(),
    }));
  }
}

function sendTabDetached(tabId: number): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: "target_detached",
      payload: { device_id: deviceId, tab_id: tabId },
        timestamp: new Date().toISOString(),
    }));
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function getNavigatorStatus() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const relayUrl = await getRelayUrl();
  const authToken = await getAuthToken();
  const tabs: Array<{ tab_id: number; url: string; title: string; is_current: boolean }> = [];
  const toRemove: number[] = [];
  for (const [tabId, info] of attachedTabs) {
    try {
      const t = await chrome.tabs.get(tabId);
      tabs.push({ tab_id: tabId, url: t.url ?? info.url, title: t.title ?? info.title, is_current: activeTab?.id === tabId });
    } catch {
      toRemove.push(tabId);
    }
  }
  for (const id of toRemove) { attachedTabs.delete(id); debuggerAttachedTabs.delete(id); }
  if (toRemove.length) await persistAttachedTabs();
  return {
    relay_state: relayState,
    relay_error: relayError,
    relay_url: relayUrl,
    auth_present: Boolean(authToken),
    attached_count: tabs.length,
    attached_tabs: tabs,
    current_tab_attached: activeTab?.id ? attachedTabs.has(activeTab.id) : false,
    current_tab_title: activeTab?.title ?? "",
    current_tab_url: activeTab?.url ?? "",
  };
}

async function clearStoredAuth(): Promise<void> {
  await chrome.storage.local.remove([
    STORAGE_KEY_AUTH_TOKEN,
    STORAGE_KEY_AUTH_RENEWAL,
    STORAGE_KEY_FIREBASE_CONFIG,
    STORAGE_KEY_AUTH_REFRESH_URL,
  ]);
  suppressNextCloseError = true;
  clearReconnectTimer();
  stopPing();
  stopScreenshotStreaming();
  try { socket?.close(4001, "signout"); } catch { /* ignore */ }
  socket = null;
  relayState = "error";
  relayError = "Authentication cleared";
  await setAttachBadge();
}

async function toggleAttachCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, detail: "No active tab." };

  if (attachedTabs.has(tab.id)) {
    await detachAttachedTab(tab.id, { ungroup: true });
    return { ok: true, attached: false, tab_id: tab.id };
  }

  await ensureOiGroup(tab.id);
  attachedTabs.set(tab.id, { url: tab.url ?? "", title: tab.title ?? "" });
  await persistAttachedTabs();
  await setAttachBadge();
  sendTabAttached(tab.id, tab.url ?? "", tab.title ?? "");
  return { ok: true, attached: true, tab_id: tab.id };
}

async function detachAttachedTab(
  tabId: number,
  options: { ungroup?: boolean } = {},
): Promise<void> {
  if (!attachedTabs.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch { /* ok */ }
  debuggerAttachedTabs.delete(tabId);
  refMapByTab.delete(tabId);
  snapshotIdByTab.delete(tabId);
  tabCommandQueues.delete(tabId);
  attachedTabs.delete(tabId);
  if (options.ungroup) {
    await removeFromOiGroup(tabId);
  }
  await persistAttachedTabs();
  await setAttachBadge();
  sendTabDetached(tabId);
}

// =========================================================================
// Message listener (popup, options, content scripts)
// =========================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.source === "oi-content-script") { sendResult(message.payload); return; }

  if (message?.type === "navigator_get_status") {
    getNavigatorStatus().then((s) => sendResponse(s)).catch(() => sendResponse({ relay_state: "error" }));
    return true;
  }
  if (message?.type === "navigator_toggle_attach_current") {
    toggleAttachCurrentTab().then((r) => sendResponse(r)).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "navigator_detach_tab") {
    const tabId = message.tab_id as number;
    if (tabId && attachedTabs.has(tabId)) {
      detachAttachedTab(tabId, { ungroup: true })
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false, detail: "Failed to detach tab" }));
    } else {
      sendResponse({ ok: false, detail: "Tab not attached" });
    }
    return true;
  }
  if (message?.type === "navigator_set_relay_url") {
    const relayUrl = String(message?.relay_url ?? "").trim();
    if (!relayUrl.startsWith("ws://") && !relayUrl.startsWith("wss://")) {
      sendResponse({ ok: false, detail: "Relay URL must start with ws:// or wss://" });
      return;
    }
    chrome.storage.local.set({ oi_relay_ws_url: relayUrl }).then(() => {
      const oldSocket = socket;
      clearReconnectTimer();
      stopPing();
      stopScreenshotStreaming();
      socket = null;
      isConnectingWebSocket = false;
      try { oldSocket?.close(); } catch { /* ok */ }
      void connectWebSocket();
      sendResponse({ ok: true });
    });
    return true;
  }
  if (message?.type === "navigator_set_auth") {
    const token = String(message?.token ?? "");
    const payload: Record<string, string> = {};
    if (token) payload[STORAGE_KEY_AUTH_TOKEN] = token;
    if (typeof message?.refresh_token === "string" && message.refresh_token) {
      payload[STORAGE_KEY_AUTH_RENEWAL] = message.refresh_token;
    }
    if (typeof message?.firebase_api_key === "string" && message.firebase_api_key) {
      payload[STORAGE_KEY_FIREBASE_CONFIG] = message.firebase_api_key;
    }
    if (typeof message?.refresh_url === "string" && message.refresh_url) {
      payload[STORAGE_KEY_AUTH_REFRESH_URL] = message.refresh_url;
    }
    chrome.storage.local.set(payload).then(() => {
      sendResponse({ ok: true });
      void triggerSilentReauth();
    }).catch(() => sendResponse({ ok: false, detail: "Failed to store auth token" }));
    return true;
  }
  if (message?.type === "navigator_refresh_auth") {
    triggerSilentReauth().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "navigator_clear_auth") {
    clearStoredAuth().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
});

chrome.action.onClicked.addListener(async () => { await toggleAttachCurrentTab(); });

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (attachedTabs.has(tabId)) {
    await detachAttachedTab(tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.groupId === undefined) return;
  void (async () => {
    if (changeInfo.groupId === -1) {
      if (attachedTabs.has(tabId)) {
        await detachAttachedTab(tabId);
      }
      return;
    }

    const inOiGroup = await isInOiGroup(tabId);
    if (inOiGroup) {
      await autoAttachTabIfInOiGroup(tabId, tab);
      return;
    }

    if (attachedTabs.has(tabId)) {
      await detachAttachedTab(tabId);
    }
  })().catch(() => { /* ignore tab race */ });
});

chrome.tabGroups.onRemoved.addListener(() => {
  void (async () => {
    // Safety net: detach tabs that are attached but no longer in OI group.
    for (const tabId of [...attachedTabs.keys()]) {
      const inOiGroup = await isInOiGroup(tabId);
      if (!inOiGroup) {
        await detachAttachedTab(tabId);
      }
    }
  })().catch(() => { /* ignore tab/group races */ });
});

chrome.tabGroups.onUpdated.addListener((group) => {
  if (group.title === OI_GROUP_TITLE && typeof group.id === "number") {
    void chrome.tabs.query({ groupId: group.id })
      .then((tabs) => Promise.all(tabs.map((tab) => (tab.id ? autoAttachTabIfInOiGroup(tab.id, tab) : Promise.resolve()))))
      .catch(() => { });
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) {
    debuggerAttachedTabs.delete(source.tabId);
    refMapByTab.delete(source.tabId);
    snapshotIdByTab.delete(source.tabId);
    tabCommandQueues.delete(source.tabId);
    recentConsoleEventsByTab.delete(source.tabId);
    recentNetworkFailuresByTab.delete(source.tabId);
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId == null) return;
  if (method === "Runtime.consoleAPICalled") {
    const payload = params as { type?: string; args?: Array<{ value?: unknown }> };
    pushRecentEvent(recentConsoleEventsByTab, tabId, {
      kind: "console",
      level: String(payload?.type || "log"),
      text: Array.isArray(payload?.args) ? payload.args.map((arg) => String(arg?.value ?? "")).join(" ").trim() : "",
      ts: Date.now(),
    });
    return;
  }
  if (method === "Runtime.exceptionThrown") {
    const payload = params as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
    pushRecentEvent(recentConsoleEventsByTab, tabId, {
      kind: "exception",
      level: "error",
      text: String(payload?.exceptionDetails?.exception?.description || payload?.exceptionDetails?.text || "Runtime exception"),
      ts: Date.now(),
    });
    return;
  }
  if (method === "Network.loadingFailed") {
    const payload = params as { requestId?: string; errorText?: string; canceled?: boolean; type?: string };
    pushRecentEvent(recentNetworkFailuresByTab, tabId, {
      requestId: String(payload?.requestId || ""),
      errorText: String(payload?.errorText || ""),
      canceled: Boolean(payload?.canceled),
      resourceType: String(payload?.type || ""),
      ts: Date.now(),
    });
  }
});

// =========================================================================
// Init
// =========================================================================

chrome.runtime.onInstalled.addListener(async () => { await restoreAttachedTabsFromStorage(); connectWebSocket(); setAttachBadge(); });
chrome.runtime.onStartup.addListener(async () => { await restoreAttachedTabsFromStorage(); connectWebSocket(); setAttachBadge(); });
(async () => { await restoreAttachedTabsFromStorage(); connectWebSocket(); setAttachBadge(); })();
