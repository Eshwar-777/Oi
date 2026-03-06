import { buildFindScript, buildUiBlockerScanScript } from "./cdp-scripts";
import type { ActionabilityCheckResult, ElementBox, UiBlockerScan } from "./types";

export interface CdpCore {
  ensureDebugger: (tabId: number) => Promise<void>;
  cdp: (tabId: number, method: string, params?: Record<string, unknown>) => Promise<unknown>;
  cdpEval: (tabId: number, expression: string) => Promise<unknown>;
  normalizeViewportPoint: (tabId: number, rawX: number, rawY: number) => Promise<{ x: number; y: number }>;
  findElementBox: (tabId: number, target: unknown) => Promise<ElementBox>;
  checkActionabilityAtPoint: (tabId: number, x: number, y: number) => Promise<ActionabilityCheckResult>;
  scanUiBlockers: (tabId: number, targetPoint?: { x: number; y: number }) => Promise<UiBlockerScan>;
  clickPoint: (tabId: number, x: number, y: number) => Promise<void>;
  findByBackendNodeId: (tabId: number, backendNodeId: number) => Promise<ElementBox | null>;
}

export function createCdpCore(debuggerAttachedTabs: Set<number>): CdpCore {
  async function ensureDebugger(tabId: number): Promise<void> {
    if (debuggerAttachedTabs.has(tabId)) return;
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      debuggerAttachedTabs.add(tabId);
      await chrome.debugger.sendCommand({ tabId }, "Runtime.enable", {});
    } catch (err: unknown) {
      const msg = String(err).toLowerCase();
      if (msg.includes("already attached") || msg.includes("another debugger")) {
        try {
          await chrome.debugger.detach({ tabId });
        } catch {
          // no-op
        }
        try {
          await chrome.debugger.attach({ tabId }, "1.3");
          await chrome.debugger.sendCommand({ tabId }, "Runtime.enable", {});
        } catch {
          // no-op: last resort is marking as attached
        }
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

  async function normalizeViewportPoint(
    tabId: number,
    rawX: number,
    rawY: number,
  ): Promise<{ x: number; y: number }> {
    return (await cdpEval(tabId, `
      (function() {
        const rawX = ${Math.round(rawX)};
        const rawY = ${Math.round(rawY)};
        const vw = Math.max(1, window.innerWidth || 1);
        const vh = Math.max(1, window.innerHeight || 1);
        let x = rawX;
        let y = rawY;

        if (y < 0 || y > vh - 1) {
          const top = Math.max(0, rawY - Math.floor(vh * 0.4));
          window.scrollTo({ top, behavior: "instant" });
          y = rawY - window.scrollY;
        }

        x = Math.max(1, Math.min(vw - 1, x));
        y = Math.max(1, Math.min(vh - 1, y));
        return { x: Math.round(x), y: Math.round(y) };
      })()
    `)) as { x: number; y: number };
  }

  async function findElementBox(tabId: number, target: unknown): Promise<ElementBox> {
    const script = buildFindScript(target);
    return (await cdpEval(tabId, script)) as ElementBox;
  }

  async function checkActionabilityAtPoint(tabId: number, x: number, y: number): Promise<ActionabilityCheckResult> {
    const result = (await cdpEval(tabId, `
      (async function() {
        const x = ${Math.round(x)};
        const y = ${Math.round(y)};
        const hit1 = document.elementFromPoint(x, y);
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
    `)) as ActionabilityCheckResult;
    return result ?? { ok: false, reason: "actionability-check-failed" };
  }

  async function scanUiBlockers(tabId: number, targetPoint?: { x: number; y: number }): Promise<UiBlockerScan> {
    const data = (await cdpEval(tabId, buildUiBlockerScanScript(targetPoint))) as UiBlockerScan;
    return (
      data ?? {
        blockerClass: "none",
        reason: "scan-empty",
        closePoints: [],
        backdropPoint: null,
        targetCovered: false,
        hitTag: "",
      }
    );
  }

  async function clickPoint(tabId: number, x: number, y: number): Promise<void> {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  async function findByBackendNodeId(tabId: number, backendNodeId: number): Promise<ElementBox | null> {
    try {
      await cdp(tabId, "DOM.enable", {});
      const resolved = (await cdp(tabId, "DOM.resolveNode", { backendNodeId })) as {
        object?: { objectId?: string };
      };
      const objectId = resolved?.object?.objectId;
      if (!objectId) return null;
      const evalRes = (await cdp(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `
          function() {
            if (!this || !(this instanceof Element)) {
              return { found: false, x: 0, y: 0, width: 0, height: 0, description: "resolved-node-not-element" };
            }
            this.scrollIntoView({ behavior: "instant", block: "center" });
            const r = this.getBoundingClientRect();
            const tag = this.tagName.toLowerCase();
            const label = this.getAttribute("aria-label")
              || this.getAttribute("placeholder")
              || this.getAttribute("title")
              || this.textContent?.trim().substring(0, 40)
              || "";
            return {
              found: r.width > 0 && r.height > 0,
              x: r.left + r.width / 2,
              y: r.top + r.height / 2,
              width: r.width,
              height: r.height,
              description: "<" + tag + "> " + label,
            };
          }
        `,
        returnByValue: true,
        awaitPromise: true,
      })) as { result?: { value?: unknown } };
      const box = evalRes?.result?.value as ElementBox | undefined;
      if (!box?.found) return null;
      return box;
    } catch {
      return null;
    }
  }

  return {
    ensureDebugger,
    cdp,
    cdpEval,
    normalizeViewportPoint,
    findElementBox,
    checkActionabilityAtPoint,
    scanUiBlockers,
    clickPoint,
    findByBackendNodeId,
  };
}
