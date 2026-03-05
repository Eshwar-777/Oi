/**
 * Background service worker for the OI browser extension.
 *
 * Supports multiple attached tabs under an "OI" Chrome tab group.
 * Uses Chrome Debugger API (CDP) for all page interactions.
 */

const DEFAULT_RELAY_WS_URL = import.meta.env.VITE_OI_RELAY_WS_URL || "ws://127.0.0.1:8080/ws";
const PING_INTERVAL_MS = 25000;
const STORAGE_KEY_ATTACHED_TABS = "oi_attached_tabs";
const STORAGE_KEY_AUTH_TOKEN = "oi_auth_token";
const STORAGE_KEY_AUTH_RENEWAL = "oi_auth_renewal";
const STORAGE_KEY_FIREBASE_CONFIG = "oi_firebase_config";
const STORAGE_KEY_AUTH_REFRESH_URL = "oi_auth_refresh_url";
const OI_GROUP_TITLE = "OI";

let socket: WebSocket | null = null;
let deviceId = "";
let currentRunId = "";
let automationPaused = false;
let screenshotIntervalId: ReturnType<typeof setInterval> | null = null;
let pingIntervalId: ReturnType<typeof setInterval> | null = null;
let reconnectTimerId: ReturnType<typeof setTimeout> | null = null;
let isConnectingWebSocket = false;
let screenshotCaptureInFlight = false;
let relayState: "connecting" | "connected" | "error" = "connecting";
let relayError = "";
let isRefreshingAuth = false;
let suppressNextCloseError = false;

interface TabInfo { url: string; title: string }
const attachedTabs = new Map<number, TabInfo>();
const debuggerAttachedTabs = new Set<number>();
const autoAttachInFlight = new Set<number>();

// Ref map for aria snapshot — maps e0, e1... to role+name for locator resolution
interface RefEntry { role: string; name: string; level?: number; description?: string; nth?: number }
const refMapByTab = new Map<number, Record<string, RefEntry>>();

function getRefMapForTab(tabId: number): Record<string, RefEntry> {
  return refMapByTab.get(tabId) ?? {};
}

function getFirstAttachedTabId(): number | null {
  const first = attachedTabs.keys().next();
  return first.done ? null : (first.value as number);
}

// =========================================================================
// OI Tab Group management
// =========================================================================

async function ensureOiGroup(tabId: number): Promise<void> {
  try {
    const groups = await chrome.tabGroups.query({ title: OI_GROUP_TITLE });
    if (groups.length > 0) {
      await chrome.tabs.group({ tabIds: tabId, groupId: groups[0].id });
    } else {
      const g = await chrome.tabs.group({ tabIds: tabId });
      await chrome.tabGroups.update(g, { title: OI_GROUP_TITLE, color: "red", collapsed: false });
    }
  } catch { /* tab groups may not be available */ }
}

async function removeFromOiGroup(tabId: number): Promise<void> {
  try { await chrome.tabs.ungroup(tabId); } catch { /* ok */ }
}

async function isInOiGroup(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.groupId || tab.groupId === -1) return false;
    const group = await chrome.tabGroups.get(tab.groupId);
    return group.title === OI_GROUP_TITLE;
  } catch { return false; }
}

async function autoAttachTabIfInOiGroup(tabId: number, tabHint?: chrome.tabs.Tab): Promise<void> {
  if (attachedTabs.has(tabId) || autoAttachInFlight.has(tabId)) return;
  autoAttachInFlight.add(tabId);
  try {
    const tab = tabHint?.id === tabId ? tabHint : await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab?.id) return;
    if (!tab.groupId || tab.groupId === -1) return;
    const inOiGroup = await isInOiGroup(tab.id);
    if (!inOiGroup) return;

    attachedTabs.set(tab.id, { url: tab.url ?? "", title: tab.title ?? "" });
    await persistAttachedTabs();
    await setAttachBadge();
    sendTabAttached(tab.id, tab.url ?? "", tab.title ?? "");
  } finally {
    autoAttachInFlight.delete(tabId);
  }
}

async function autoAttachTabsInOiGroup(): Promise<void> {
  const groups = await chrome.tabGroups.query({ title: OI_GROUP_TITLE }).catch(() => []);
  if (!groups.length) return;
  for (const g of groups) {
    if (typeof g.id !== "number") continue;
    const tabs = await chrome.tabs.query({ groupId: g.id }).catch(() => []);
    for (const tab of tabs) {
      if (tab.id) await autoAttachTabIfInOiGroup(tab.id, tab);
    }
  }
}

// =========================================================================
// CDP helpers — interact with any page via Chrome Debugger API
// =========================================================================

async function ensureDebugger(tabId: number): Promise<void> {
  if (debuggerAttachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    debuggerAttachedTabs.add(tabId);
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable", {});
  } catch (err: unknown) {
    const msg = String(err).toLowerCase();
    if (msg.includes("already attached") || msg.includes("another debugger")) {
      // Debugger is attached but we lost track — detach first, then reattach cleanly
      try { await chrome.debugger.detach({ tabId }); } catch { /* ok */ }
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
        await chrome.debugger.sendCommand({ tabId }, "Runtime.enable", {});
      } catch { /* last resort: the debugger might be us from before, just mark as attached */ }
      debuggerAttachedTabs.add(tabId);
    } else {
      throw err;
    }
  }
}

async function cdp(tabId: number, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  await ensureDebugger(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (err) {
    const msg = String(err).toLowerCase();
    if (msg.includes("not attached") || msg.includes("detached")) {
      debuggerAttachedTabs.delete(tabId);
      await ensureDebugger(tabId);
      return chrome.debugger.sendCommand({ tabId }, method, params);
    }
    throw err;
  }
}

async function cdpEval(tabId: number, expression: string): Promise<unknown> {
  const res = (await cdp(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (res.exceptionDetails) {
    throw new Error(`JS error: ${JSON.stringify(res.exceptionDetails)}`);
  }
  return res.result?.value;
}

interface ElementBox { x: number; y: number; width: number; height: number; found: boolean; description: string }
interface ActionabilityCheckResult { ok: boolean; reason: string; hitTag?: string }
interface CoordsTarget { by: "coords"; x: number; y: number }

function parseCoordsTarget(target: unknown): CoordsTarget | null {
  if (!target || typeof target !== "object") return null;
  const maybe = target as Record<string, unknown>;
  if (maybe.by !== "coords") return null;
  const x = Number(maybe.x);
  const y = Number(maybe.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { by: "coords", x, y };
}

async function normalizeViewportPoint(
  tabId: number,
  rawX: number,
  rawY: number,
): Promise<{ x: number; y: number }> {
  return await cdpEval(tabId, `
    (function() {
      const rawX = ${Math.round(rawX)};
      const rawY = ${Math.round(rawY)};
      const vw = Math.max(1, window.innerWidth || 1);
      const vh = Math.max(1, window.innerHeight || 1);
      let x = rawX;
      let y = rawY;

      // If point is clearly outside viewport, treat Y as page-space and scroll near it.
      if (y < 0 || y > vh - 1) {
        const top = Math.max(0, rawY - Math.floor(vh * 0.4));
        window.scrollTo({ top, behavior: "instant" });
        y = rawY - window.scrollY;
      }

      // Keep click target within viewport bounds.
      x = Math.max(1, Math.min(vw - 1, x));
      y = Math.max(1, Math.min(vh - 1, y));
      return { x: Math.round(x), y: Math.round(y) };
    })()
  `) as { x: number; y: number };
}

function buildFindScript(target: unknown): string {
  const serialized = JSON.stringify(target);
  return `
(function() {
  let parsed = ${serialized};
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch {}
  }

  function escSel(s) { return CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\\\"'); }

  function findByString(s) {
    if (!s || typeof s !== 'string') return null;
    try { const e = document.querySelector(s); if (e) return e; } catch {}
    try { const e = document.querySelector('[name="' + escSel(s) + '"]'); if (e) return e; } catch {}
    try { const e = document.querySelector('[aria-label="' + escSel(s) + '" i]'); if (e) return e; } catch {}
    try { const e = document.querySelector('[placeholder="' + escSel(s) + '" i]'); if (e) return e; } catch {}
    const byId = document.getElementById(s);
    if (byId) return byId;
    return findByText(s);
  }

  function findByText(text) {
    const t = text.toLowerCase();
    const candidates = document.querySelectorAll('button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input, textarea, select, label, span, div, h1, h2, h3, h4, p');
    let best = null;
    let bestLen = Infinity;
    for (const el of candidates) {
      if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const al = (el.getAttribute('aria-label') || '').toLowerCase();
      const tx = (el.textContent || '').trim().toLowerCase();
      const ph = (el.getAttribute('placeholder') || '').toLowerCase();
      const tt = (el.getAttribute('title') || '').toLowerCase();
      if (al === t || tx === t || ph === t || tt === t) {
        if (tx.length < bestLen) { best = el; bestLen = tx.length; }
      }
      if (!best && (al.includes(t) || ph.includes(t) || tt.includes(t))) return el;
      if (!best && tx.includes(t) && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link'))
        return el;
    }
    return best;
  }

  function find(p) {
    if (typeof p === 'string') return findByString(p);
    if (!p || typeof p !== 'object') return null;

    if (p.by === 'coords' && typeof p.x === 'number') return document.elementFromPoint(p.x, p.y);

    if (p.by === 'name' && p.value) {
      return document.querySelector('[name="' + escSel(p.value) + '"]') || document.getElementById(p.value);
    }

    if (p.by === 'text' && p.value) return findByText(p.value) || findByString(p.value);

    if (p.by === 'role' && p.value) {
      const els = document.querySelectorAll('[role="' + p.value + '"]');
      const tagMap = { button: 'button', link: 'a', textbox: 'input,textarea', combobox: 'select', checkbox: 'input[type="checkbox"]', radio: 'input[type="radio"]' };
      const extra = tagMap[p.value] ? document.querySelectorAll(tagMap[p.value]) : [];
      const all = [...els, ...extra];
      if (p.name) {
        const n = p.name.toLowerCase();
        for (const el of all) {
          const al = (el.getAttribute('aria-label') || '').toLowerCase();
          const tx = (el.textContent || '').trim().toLowerCase();
          const ph = (el.getAttribute('placeholder') || '').toLowerCase();
          if (al === n || al.includes(n) || tx === n || ph.includes(n)) return el;
        }
      }
      for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return el;
      }
      return null;
    }

    if (p.value) return findByString(p.value);
    if (p.selector) return findByString(p.selector);
    return null;
  }

  const el = find(parsed);
  if (!el) return { found: false, x: 0, y: 0, width: 0, height: 0, description: 'Not found: ' + JSON.stringify(parsed) };
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  const r = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent?.trim().substring(0, 40) || '';
  return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, description: '<' + tag + '> ' + label };
})()
`;
}

async function findElementBox(tabId: number, target: unknown): Promise<ElementBox> {
  const script = buildFindScript(target);
  return await cdpEval(tabId, script) as ElementBox;
}

async function checkActionabilityAtPoint(tabId: number, x: number, y: number): Promise<ActionabilityCheckResult> {
  const result = await cdpEval(tabId, `
    (async function() {
      const x = ${Math.round(x)};
      const y = ${Math.round(y)};
      const hit1 = document.elementFromPoint(x, y);
      // Avoid requestAnimationFrame here: background/throttled tabs can stall rAF
      // and cause Runtime.evaluate to hang until command timeout.
      await new Promise((r) => setTimeout(r, 34));
      const hit2 = document.elementFromPoint(x, y);
      const hit = hit2 || hit1;
      if (!hit) return { ok: false, reason: "no-hit-target" };
      const style = getComputedStyle(hit);
      const disabled = !!hit.closest('[disabled],[aria-disabled="true"]');
      const hidden = style.visibility === "hidden" || style.display === "none" || style.pointerEvents === "none";
      const unstable = hit1 !== hit2;
      if (disabled) return { ok: false, reason: "disabled", hitTag: hit.tagName.toLowerCase() };
      if (hidden) return { ok: false, reason: "not-receiving-events", hitTag: hit.tagName.toLowerCase() };
      if (unstable) return { ok: false, reason: "unstable-hit-target", hitTag: hit.tagName.toLowerCase() };
      return { ok: true, reason: "ok", hitTag: hit.tagName.toLowerCase() };
    })()
  `) as ActionabilityCheckResult;
  return result ?? { ok: false, reason: "actionability-check-failed" };
}

async function cdpClick(tabId: number, target: unknown): Promise<string> {
  const coords = parseCoordsTarget(target);
  if (coords) {
    const pt = await normalizeViewportPoint(tabId, coords.x, coords.y);
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    return `Clicked coordinates at (${pt.x},${pt.y})`;
  }

  const box = await findElementBox(tabId, target);
  if (!box.found) return `Element not found: ${box.description}`;
  const x = Math.round(box.x);
  const y = Math.round(box.y);
  const actionability = await checkActionabilityAtPoint(tabId, x, y);
  if (!actionability.ok) return `Not clickable: ${actionability.reason}`;
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return `Clicked: ${box.description} at (${x},${y})`;
}

async function cdpType(tabId: number, target: unknown, text: string): Promise<string> {
  const box = await findElementBox(tabId, target);
  if (!box.found) return `Element not found: ${box.description}`;
  const x = Math.round(box.x);
  const y = Math.round(box.y);
  const actionability = await checkActionabilityAtPoint(tabId, x, y);
  if (!actionability.ok) return `Not editable: ${actionability.reason}`;
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(100);
  await cdp(tabId, "Input.insertText", { text });
  return `Typed into: ${box.description}`;
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

async function cdpHover(tabId: number, target: unknown): Promise<string> {
  const box = await findElementBox(tabId, target);
  if (!box.found) return `Element not found: ${box.description}`;
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(box.x), y: Math.round(box.y) });
  return `Hovered: ${box.description}`;
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
  const hasTarget = target && typeof target === "string" && target.length > 0;
  if (!hasTarget) {
    const ms = typeof value === "number" ? value : 2000;
    await sleep(ms);
    return `Waited ${ms}ms`;
  }
  const start = Date.now();
  const timeout = 10000;
  while (Date.now() - start < timeout) {
    const box = await findElementBox(tabId, target);
    if (box.found) return `Found: ${box.description} after ${Date.now() - start}ms`;
    await sleep(500);
  }
  return `Timeout waiting for: ${JSON.stringify(target)}`;
}

async function cdpSelect(tabId: number, target: unknown, value: string): Promise<string> {
  const box = await findElementBox(tabId, target);
  if (!box.found) return `Element not found: ${box.description}`;
  await cdpEval(tabId, `
    (function() {
      const spec = ${JSON.stringify(typeof target === "string" ? target : JSON.stringify(target))};
      let parsed = spec; try { parsed = JSON.parse(spec); } catch {}
      let el = null;
      if (typeof parsed === 'string') { el = document.querySelector(parsed) || document.querySelector('[name="'+parsed+'"]'); }
      else if (parsed.value) { el = document.querySelector('[name="'+parsed.value+'"]') || document.querySelector(parsed.value); }
      if (el && el.tagName === 'SELECT') { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', {bubbles:true})); }
    })()
  `);
  return `Selected "${value}" in: ${box.description}`;
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
      return JSON.stringify({ url: location.href, title: document.title, elements: elements, viewport: { w: innerWidth, h: innerHeight }, scrollY: scrollY });
    })()
  `) as string;
  return result ?? "{}";
}

// =========================================================================
// Aria Snapshot + Ref System  (Playwright-style)
// =========================================================================

interface AXNode {
  nodeId: string;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  description?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
  ignored?: boolean;
}

// Roles that are interactive or meaningful enough to expose to the agent
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox",
  "radio", "switch", "slider", "spinbutton", "tab", "menuitem",
  "menuitemcheckbox", "menuitemradio", "option", "treeitem",
  "listbox", "menu", "tree", "grid", "row", "cell",
  "heading", "img", "dialog", "alertdialog", "navigation",
  "search", "form", "main", "complementary", "banner",
  "contentinfo", "region", "alert",
]);

function buildRoleSnapshot(nodes: AXNode[]): { lines: string[]; refMap: Record<string, RefEntry> } {
  const refMap: Record<string, RefEntry> = {};
  const lines: string[] = [];
  let refIdx = 0;
  const duplicateCounter = new Map<string, number>();
  const emittedNodeIds = new Set<string>();
  const MAX_REFS = 250;

  const nodeMap = new Map<string, AXNode>();
  for (const n of nodes) nodeMap.set(n.nodeId, n);

  function emitNode(node: AXNode, depth: number): boolean {
    if (Object.keys(refMap).length >= MAX_REFS) return false;
    const roleRaw = node.role?.value ?? "";
    const role = roleRaw.toLowerCase();
    const name = node.name?.value ?? "";
    const desc = node.description?.value ?? "";

    // Skip generic/structural roles unless they have a name
    const isGeneric = role === "none" || role === "generic" || role === "genericcontainer" || role === "" || role === "group";
    const isInteresting = INTERACTIVE_ROLES.has(role) || (!isGeneric && name !== "");
    if (!isInteresting) return false;

    const ref = `e${refIdx}`;
    refIdx++;

    const key = `${role}::${(name || "").toLowerCase()}`;
    const nth = duplicateCounter.get(key) ?? 0;
    duplicateCounter.set(key, nth + 1);

    const entry: RefEntry = { role, name, nth };
    if (desc) entry.description = desc;

    const levelProp = node.properties?.find((p) => p.name === "level");
    if (levelProp) entry.level = levelProp.value.value as number;

    refMap[ref] = entry;

    const indent = "  ".repeat(Math.min(depth, 6));
    let line = `${indent}[${ref}] ${roleRaw}`;
    if (name) line += ` "${name.substring(0, 80)}"`;
    if (entry.level) line += ` [level=${entry.level}]`;
    if (typeof entry.nth === "number" && entry.nth > 0) line += ` [nth=${entry.nth}]`;
    if (desc) line += ` (${desc.substring(0, 60)})`;
    lines.push(line);
    return true;
  }

  function walkNode(nodeId: string, depth: number): void {
    const node = nodeMap.get(nodeId);
    if (!node || node.ignored) return;
    if (emittedNodeIds.has(nodeId)) return;
    emittedNodeIds.add(nodeId);

    const emitted = emitNode(node, depth);

    // Walk children
    if (node.childIds) {
      for (const childId of node.childIds) {
        walkNode(childId, emitted ? depth + 1 : depth);
      }
    }
  }

  // Start from root (first node)
  if (nodes.length > 0) {
    walkNode(nodes[0].nodeId, 0);
  }

  // Fallback for sparse/disconnected AX trees (common on heavy SPAs like Gmail):
  // emit interesting nodes from full node list if traversal yielded too little.
  if (Object.keys(refMap).length <= 1) {
    for (const node of nodes) {
      if (Object.keys(refMap).length >= MAX_REFS) break;
      if (node.ignored || emittedNodeIds.has(node.nodeId)) continue;
      emitNode(node, 0);
    }
  }

  return { lines, refMap };
}

async function cdpAriaSnapshot(tabId: number): Promise<string> {
  // Enable accessibility domain and get the full tree
  await cdp(tabId, "Accessibility.enable", {});
  const result = await cdp(tabId, "Accessibility.getFullAXTree", {}) as { nodes: AXNode[] };

  const { lines, refMap } = buildRoleSnapshot(result.nodes);

  // Store refs globally for act resolution
  refMapByTab.set(tabId, refMap);

  // Get page info
  const url = await cdpEval(tabId, "location.href") as string;
  const title = await cdpEval(tabId, "document.title") as string;

  return JSON.stringify({
    url: url ?? "",
    title: title ?? "",
    snapshot: lines.join("\n"),
    refCount: Object.keys(refMap).length,
  });
}

// Find an element by its accessibility role+name and return its bounding box
function buildFindByRoleScript(role: string, name: string, nth = 0): string {
  return `
(function() {
  const ROLE = ${JSON.stringify(role)};
  const NAME = ${JSON.stringify(name)};
  const NTH = ${Number.isFinite(nth) ? Math.max(0, Math.floor(nth)) : 0};

  // Map ARIA roles to HTML tag equivalents
  const roleTagMap = {
    button: 'button,[role="button"]',
    link: 'a,[role="link"]',
    textbox: 'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]),textarea,[role="textbox"],[contenteditable="true"]',
    searchbox: 'input[type="search"],[role="searchbox"]',
    combobox: 'select,[role="combobox"]',
    checkbox: 'input[type="checkbox"],[role="checkbox"]',
    radio: 'input[type="radio"],[role="radio"]',
    tab: '[role="tab"]',
    menuitem: '[role="menuitem"]',
    option: 'option,[role="option"]',
    heading: 'h1,h2,h3,h4,h5,h6,[role="heading"]',
    img: 'img,[role="img"]',
    navigation: 'nav,[role="navigation"]',
    search: '[role="search"]',
    dialog: 'dialog,[role="dialog"],[role="alertdialog"]',
    slider: 'input[type="range"],[role="slider"]',
    switch: '[role="switch"]',
  };

  function getAccessibleName(el) {
    return el.getAttribute('aria-label')
      || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent?.trim()
      || el.getAttribute('placeholder')
      || el.getAttribute('title')
      || el.getAttribute('alt')
      || (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
        ? (el.labels?.[0]?.textContent?.trim() || '')
        : el.textContent?.trim().substring(0, 100))
      || '';
  }

  // Try elements matching the role
  const selector = roleTagMap[ROLE] || ('[role="' + ROLE + '"]');
  const candidates = Array.from(document.querySelectorAll(selector));
  const visible = candidates.filter((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
    return true;
  });

  const matches = [];
  for (const el of visible) {
    const accName = getAccessibleName(el) || '';
    if (!NAME) {
      matches.push(el);
      continue;
    }
    const loweredAccName = accName.toLowerCase();
    const loweredNeedle = NAME.toLowerCase();
    if (accName === NAME || loweredAccName === loweredNeedle || loweredAccName.includes(loweredNeedle)) {
      matches.push(el);
    }
  }

  const chosen = matches[NTH] || null;
  if (chosen) {
    chosen.scrollIntoView({ behavior: 'instant', block: 'center' });
    const r = chosen.getBoundingClientRect();
    const acc = getAccessibleName(chosen);
    return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, description: '<' + chosen.tagName.toLowerCase() + '> ' + String(acc || '').substring(0, 40) };
  }

  return { found: false, x: 0, y: 0, width: 0, height: 0, description: 'Not found: ' + ROLE + ' "' + NAME + '" [nth=' + NTH + ']' };
})()
`;
}

async function cdpActByRef(
  tabId: number,
  ref: string,
  kind: string,
  value?: string,
): Promise<string> {
  const refMap = getRefMapForTab(tabId);
  const entry = refMap[ref];
  if (!entry) return `Unknown ref: ${ref}. Take a fresh snapshot first.`;

  const script = buildFindByRoleScript(entry.role, entry.name, entry.nth ?? 0);
  const box = await cdpEval(tabId, script) as ElementBox;

  if (!box.found) {
    return `Element not found for ${ref} (${entry.role} "${entry.name}"): ${box.description}`;
  }

  const x = Math.round(box.x);
  const y = Math.round(box.y);

  switch (kind) {
    case "click":
      {
        const actionability = await checkActionabilityAtPoint(tabId, x, y);
        if (!actionability.ok) return `Not clickable: ${actionability.reason}`;
      }
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      return `Clicked ${ref}: ${box.description}`;

    case "type":
      {
        const actionability = await checkActionabilityAtPoint(tabId, x, y);
        if (!actionability.ok) return `Not editable: ${actionability.reason}`;
      }
      // Click to focus first
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      await sleep(100);
      // Clear existing content and type new text
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, commands: ["selectAll"] });
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
      await cdp(tabId, "Input.insertText", { text: value ?? "" });
      return `Typed into ${ref}: ${box.description}`;

    case "hover":
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      return `Hovered ${ref}: ${box.description}`;

    case "select":
      {
        const actionability = await checkActionabilityAtPoint(tabId, x, y);
        if (!actionability.ok) return `Not selectable: ${actionability.reason}`;
      }
      // For select elements, click then use JS to set value
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      if (value) {
        await cdpEval(tabId, `
          (function() {
            const el = document.elementFromPoint(${x}, ${y});
            if (el && el.tagName === 'SELECT') {
              el.value = ${JSON.stringify(value)};
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          })()
        `);
      }
      return `Selected "${value}" in ${ref}: ${box.description}`;

    default:
      return `Unknown action kind: ${kind}`;
  }
}

// =========================================================================
// Device ID, relay URL, WebSocket
// =========================================================================

async function getOrCreateDeviceId(): Promise<string> {
  const result = await chrome.storage.local.get("oi_device_id");
  if (result.oi_device_id) return result.oi_device_id;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ oi_device_id: id });
  return id;
}

async function getRelayUrl(): Promise<string> {
  const stored = await chrome.storage.local.get("oi_relay_ws_url");
  const url = stored.oi_relay_ws_url as string | undefined;
  return url && url.startsWith("ws") ? url : DEFAULT_RELAY_WS_URL;
}

async function getAuthToken(): Promise<string> {
  const stored = await chrome.storage.local.get(STORAGE_KEY_AUTH_TOKEN);
  return String(stored[STORAGE_KEY_AUTH_TOKEN] ?? "");
}

function relayBaseHttpUrl(relayWsUrl: string): string {
  if (relayWsUrl.startsWith("wss://")) return relayWsUrl.replace("wss://", "https://").replace(/\/ws$/, "");
  if (relayWsUrl.startsWith("ws://")) return relayWsUrl.replace("ws://", "http://").replace(/\/ws$/, "");
  return relayWsUrl.replace(/\/ws$/, "");
}

async function refreshTokenViaFirebase(refreshToken: string, apiKey: string): Promise<string | null> {
  try {
    const form = new URLSearchParams();
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", refreshToken);
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    const idToken = String(body.id_token ?? "");
    const newRefresh = String(body.refresh_token ?? refreshToken);
    if (!idToken) return null;
    await chrome.storage.local.set({
      [STORAGE_KEY_AUTH_TOKEN]: idToken,
      [STORAGE_KEY_AUTH_RENEWAL]: newRefresh,
    });
    return idToken;
  } catch {
    return null;
  }
}

async function refreshTokenViaEndpoint(refreshUrl: string, currentToken: string): Promise<string | null> {
  try {
    const res = await fetch(refreshUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: currentToken, device_id: deviceId }),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    const token = String(body.token ?? body.id_token ?? "");
    if (!token) return null;
    await chrome.storage.local.set({ [STORAGE_KEY_AUTH_TOKEN]: token });
    if (body.refresh_token) {
      await chrome.storage.local.set({ [STORAGE_KEY_AUTH_RENEWAL]: String(body.refresh_token) });
    }
    return token;
  } catch {
    return null;
  }
}

async function attemptAuthRefresh(): Promise<boolean> {
  const stored = await chrome.storage.local.get([
    STORAGE_KEY_AUTH_TOKEN,
    STORAGE_KEY_AUTH_RENEWAL,
    STORAGE_KEY_FIREBASE_CONFIG,
    STORAGE_KEY_AUTH_REFRESH_URL,
    "oi_relay_ws_url",
  ]);
  const currentToken = String(stored[STORAGE_KEY_AUTH_TOKEN] ?? "");
  const refreshToken = String(stored[STORAGE_KEY_AUTH_RENEWAL] ?? "");
  const apiKey = String(stored[STORAGE_KEY_FIREBASE_CONFIG] ?? "");
  const explicitRefreshUrl = String(stored[STORAGE_KEY_AUTH_REFRESH_URL] ?? "");

  if (refreshToken && apiKey) {
    const token = await refreshTokenViaFirebase(refreshToken, apiKey);
    if (token) return true;
  }

  const relayWs = String(stored.oi_relay_ws_url ?? DEFAULT_RELAY_WS_URL);
  const refreshUrl = explicitRefreshUrl || `${relayBaseHttpUrl(relayWs)}/api/auth/refresh`;
  const token = await refreshTokenViaEndpoint(refreshUrl, currentToken);
  return Boolean(token);
}

async function triggerSilentReauth(): Promise<void> {
  if (isRefreshingAuth) return;
  isRefreshingAuth = true;
  relayState = "connecting";
  relayError = "";
  await setAttachBadge();

  try {
    const refreshed = await attemptAuthRefresh();
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

    const reply = (p: Record<string, string>) => sendResult(p, cmdId);

    try {
      if (requestedTabId != null && !attachedTabs.has(requestedTabId)) {
        reply({
          action,
          status: "error",
          data: `Requested tab ${requestedTabId} is not attached on this device. Refusing fallback to another tab.`,
        });
        return;
      }
      if (!tabId || !attachedTabs.has(tabId)) {
        reply({ action, status: "error", data: "No tab attached. Click Oi extension to attach this tab." });
        return;
      }

      let resultMsg = "";

      switch (action) {
        case "navigate":
          await navigateToUrl(tabId, payload.target as string, cmdId);
          return;
        case "click":
          resultMsg = await cdpClick(tabId, payload.target);
          break;
        case "type":
          resultMsg = await cdpType(tabId, payload.target, (payload.value as string) ?? "");
          break;
        case "scroll":
          resultMsg = await cdpScroll(tabId, payload.target, payload.y as number, payload.x as number);
          break;
        case "hover":
          resultMsg = await cdpHover(tabId, payload.target);
          break;
        case "wait":
          resultMsg = await cdpWait(tabId, payload.target, payload.value);
          break;
        case "select":
          resultMsg = await cdpSelect(tabId, payload.target, (payload.value as string) ?? "");
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
          resultMsg = await cdpAriaSnapshot(tabId);
          break;
        case "act": {
          const actRef = payload.ref as string;
          const actKind = payload.kind as string;
          const actValue = payload.value as string | undefined;
          if (!actRef || !actKind) {
            reply({ action: "act", status: "error", data: "Missing ref or kind for act command" });
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
          reply({ action: "screenshot", status: "done", data: "Screenshot captured" });
          return;
        default:
          reply({ action, status: "error", data: `Unknown action: ${action}` });
          return;
      }

      const failedPrefixes = [
        "Element not found",
        "Not found",
        "Timeout waiting",
        "Unknown ref",
        "Ref not found",
        "Unknown action kind",
        "Not clickable",
        "Not editable",
        "Not selectable",
      ];
      const failed = failedPrefixes.some((prefix) => resultMsg.startsWith(prefix));
      reply({ action, status: failed ? "error" : "done", data: resultMsg });

      if (!failed && action !== "read_dom" && action !== "extract_structured" && action !== "media_state") {
        await sleep(400);
        await captureAndSendScreenshot(tabId, currentRunId);
      }
    } catch (err) {
      console.error("[OI Extension] Action error:", action, err);
      reply({ action, status: "error", data: String(err) });
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
  if (debuggerAttachedTabs.has(tabId)) {
    try {
      const result = (await chrome.debugger.sendCommand(
        { tabId }, "Page.captureScreenshot", { format: "jpeg", quality: 60 },
      )) as { data: string };
      return `data:image/jpeg;base64,${result.data}`;
    } catch { /* fall through */ }
  }
  try { return await chrome.tabs.captureVisibleTab(undefined, { format: "jpeg", quality: 60 }); } catch { return null; }
}

async function captureAndSendScreenshot(tabId: number, runId?: string): Promise<void> {
  const dataUrl = await captureScreenshotBase64(tabId);
  if (!dataUrl) return;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: "browser_frame",
      payload: {
        screenshot: dataUrl,
        current_url: tab?.url ?? "",
        page_title: tab?.title ?? "",
        tab_id: tabId,
        run_id: runId ?? currentRunId,
        timestamp: new Date().toISOString(),
      },
    }));
  }
}

function startScreenshotStreaming(intervalMs: number): void {
  stopScreenshotStreaming();
  screenshotIntervalId = setInterval(() => {
    if (automationPaused || screenshotCaptureInFlight) return;
    const tabId = getFirstAttachedTabId();
    if (!tabId) return;
    screenshotCaptureInFlight = true;
    void captureAndSendScreenshot(tabId, currentRunId)
      .catch((err) => console.warn("[OI Extension] Screenshot stream error:", err))
      .finally(() => {
        screenshotCaptureInFlight = false;
      });
  }, intervalMs);
}

function stopScreenshotStreaming(): void {
  screenshotCaptureInFlight = false;
  if (screenshotIntervalId !== null) { clearInterval(screenshotIntervalId); screenshotIntervalId = null; }
}

function startPing(): void {
  stopPing();
  pingIntervalId = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping", timestamp: new Date().toISOString() }));
  }, PING_INTERVAL_MS);
}

function stopPing(): void { if (pingIntervalId !== null) { clearInterval(pingIntervalId); pingIntervalId = null; } }

// =========================================================================
// Remote input
// =========================================================================

async function handleRemoteInput(payload: Record<string, unknown>): Promise<void> {
  const t = payload.input_type as string;
  const tabId = (payload.tab_id as number) || getFirstAttachedTabId();
  if (!tabId) return;
  try {
    await ensureDebugger(tabId);
    if (t === "click") {
      const x = payload.x as number, y = payload.y as number;
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    } else if (t === "type") {
      await cdp(tabId, "Input.insertText", { text: payload.key as string });
    } else if (t === "scroll") {
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 400, deltaX: (payload.dx as number) ?? 0, deltaY: (payload.dy as number) ?? 100 });
    }
  } catch (err) {
    console.warn("[OI Extension] Remote input error:", err);
  }
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

function sendResult(payload: Record<string, string>, cmdId?: string | null): void {
  if (socket?.readyState === WebSocket.OPEN) {
    const out: Record<string, string> = { ...payload, device_id: deviceId, run_id: currentRunId };
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
    attached_count: tabs.length,
    attached_tabs: tabs,
    current_tab_attached: activeTab?.id ? attachedTabs.has(activeTab.id) : false,
    current_tab_title: activeTab?.title ?? "",
    current_tab_url: activeTab?.url ?? "",
  };
}

async function toggleAttachCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, detail: "No active tab." };

  if (attachedTabs.has(tab.id)) {
    try { await chrome.debugger.detach({ tabId: tab.id }); } catch { /* ok */ }
    debuggerAttachedTabs.delete(tab.id);
    refMapByTab.delete(tab.id);
    attachedTabs.delete(tab.id);
    await removeFromOiGroup(tab.id);
    await persistAttachedTabs();
    await setAttachBadge();
    sendTabDetached(tab.id);
    return { ok: true, attached: false, tab_id: tab.id };
  }

  await ensureOiGroup(tab.id);
  attachedTabs.set(tab.id, { url: tab.url ?? "", title: tab.title ?? "" });
  await persistAttachedTabs();
  await setAttachBadge();
  sendTabAttached(tab.id, tab.url ?? "", tab.title ?? "");
  return { ok: true, attached: true, tab_id: tab.id };
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
      chrome.debugger.detach({ tabId }).catch(() => { });
      debuggerAttachedTabs.delete(tabId);
      refMapByTab.delete(tabId);
      attachedTabs.delete(tabId);
      removeFromOiGroup(tabId).then(() => persistAttachedTabs()).then(() => setAttachBadge());
      sendTabDetached(tabId);
      sendResponse({ ok: true });
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
});

chrome.action.onClicked.addListener(async () => { await toggleAttachCurrentTab(); });

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (attachedTabs.has(tabId)) {
    debuggerAttachedTabs.delete(tabId);
    refMapByTab.delete(tabId);
    attachedTabs.delete(tabId);
    await persistAttachedTabs();
    await setAttachBadge();
    sendTabDetached(tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.groupId !== undefined && changeInfo.groupId !== -1) {
    void autoAttachTabIfInOiGroup(tabId, tab);
  }
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
  }
});

// =========================================================================
// Init
// =========================================================================

chrome.runtime.onInstalled.addListener(async () => { await restoreAttachedTabsFromStorage(); connectWebSocket(); setAttachBadge(); });
chrome.runtime.onStartup.addListener(async () => { await restoreAttachedTabsFromStorage(); connectWebSocket(); setAttachBadge(); });
(async () => { await restoreAttachedTabsFromStorage(); connectWebSocket(); setAttachBadge(); })();
