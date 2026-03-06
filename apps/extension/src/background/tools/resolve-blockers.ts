import type {
  BlockerClass,
  BlockerPoint,
  BlockerResolutionResult,
  UiBlockerScan,
  UiToolRuntime,
} from "./interfaces";

const UI_STABILIZER_MAX_ATTEMPTS = 3;
const UI_STABILIZER_POLICY = {
  cookiePreference: "accept" as "accept" | "reject",
  safeCloseKeywords: [
    "close", "dismiss", "skip", "got it", "not now", "later", "cancel", "no thanks",
    "continue", "ok", "understand", "accept all", "allow all",
  ],
  riskyKeywords: ["delete", "remove", "purchase", "pay", "confirm payment", "book now", "checkout"],
};

function buildUiBlockerScanScript(targetPoint?: { x: number; y: number }): string {
  const tx = targetPoint ? Math.round(targetPoint.x) : null;
  const ty = targetPoint ? Math.round(targetPoint.y) : null;
  return `
    (function() {
      function isVisible(el) {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        return true;
      }
      function centerOf(el, label) {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: label || "" };
      }
      function textOf(el) {
        return (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "").trim().toLowerCase();
      }

      const captchaIframes = Array.from(document.querySelectorAll("iframe[src]"))
        .filter((el) => {
          const src = (el.getAttribute("src") || "").toLowerCase();
          return src.includes("recaptcha") || src.includes("hcaptcha") || src.includes("arkoselabs") || src.includes("turnstile");
        });
      const captchaNodes = Array.from(document.querySelectorAll('[id*="captcha" i], [class*="captcha" i], [name*="captcha" i]'));
      if (captchaIframes.length > 0 || captchaNodes.length > 0) {
        return { blockerClass: "security_gate", reason: "security-verification", closePoints: [], backdropPoint: null, targetCovered: false, hitTag: "" };
      }

      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog, .modal, [class*="modal"], .popup, [class*="popup"]')).filter(isVisible);
      const overlays = Array.from(document.querySelectorAll('.overlay, .backdrop, [class*="overlay"], [class*="backdrop"], [class*="scrim"], [data-testid*="modal"]')).filter(isVisible);
      const loading = Array.from(document.querySelectorAll('[aria-busy="true"], [role="progressbar"], .spinner, [class*="loading"], [class*="skeleton"]')).filter(isVisible);
      const closeCandidates = Array.from(document.querySelectorAll('button, [role="button"], a, [aria-label]'))
        .filter(isVisible)
        .map((el) => ({ el, text: textOf(el) }))
        .filter((row) => !!row.text)
        .slice(0, 200);

      const cookieNodes = Array.from(document.querySelectorAll(
        '[id*="cookie" i], [class*="cookie" i], [data-testid*="cookie" i], [id*="consent" i], [class*="consent" i], [data-testid*="consent" i], [aria-modal="true"][data-consent], [role="dialog"][data-consent]'
      )).filter(isVisible);
      const tourNodes = Array.from(document.querySelectorAll(
        '[id*="tour" i], [class*="tour" i], [data-testid*="tour" i], [id*="onboard" i], [class*="onboard" i], [data-testid*="onboard" i], [data-tour], [data-onboarding], [data-walkthrough]'
      )).filter(isVisible);

      let targetCovered = false;
      let hitTag = "";
      if (${tx === null ? "false" : "true"}) {
        const hit = document.elementFromPoint(${tx ?? 0}, ${ty ?? 0});
        if (hit) {
          hitTag = (hit.tagName || "").toLowerCase();
          const hitStyle = getComputedStyle(hit);
          const isLikelyCover = hitStyle.pointerEvents !== "none" && (hitStyle.position === "fixed" || hitStyle.position === "sticky" || hit.closest('[role="dialog"], [aria-modal="true"], .overlay, .backdrop, [class*="overlay"], [class*="modal"]'));
          if (isLikelyCover) targetCovered = true;
        }
      }

      const closeKeywords = ["close", "dismiss", "skip", "got it", "not now", "later", "cancel", "no thanks", "continue", "ok", "understand", "accept", "reject", "deny"];
      const closePoints = closeCandidates
        .filter((row) => closeKeywords.some((k) => row.text.includes(k)))
        .slice(0, 12)
        .map((row) => centerOf(row.el, row.text));

      let backdropPoint = null;
      const biggestOverlay = [...dialogs, ...overlays]
        .map((el) => ({ el, area: el.getBoundingClientRect().width * el.getBoundingClientRect().height }))
        .sort((a, b) => b.area - a.area)[0];
      if (biggestOverlay) backdropPoint = centerOf(biggestOverlay.el, "backdrop");

      const hasCookie = cookieNodes.length > 0;
      const hasTour = tourNodes.length > 0;
      const topSurfaceIsCookie = hasCookie && (
        (dialogs.length > 0 && cookieNodes.some((n) => dialogs.some((d) => d === n || d.contains(n) || n.contains(d)))) ||
        (overlays.length > 0 && cookieNodes.some((n) => overlays.some((o) => o === n || o.contains(n) || n.contains(o))))
      );
      const topSurfaceIsTour = hasTour && (
        (dialogs.length > 0 && tourNodes.some((n) => dialogs.some((d) => d === n || d.contains(n) || n.contains(d)))) ||
        (overlays.length > 0 && tourNodes.some((n) => overlays.some((o) => o === n || o.contains(n) || n.contains(o))))
      );

      if (loading.length > 0) return { blockerClass: "loading_mask", reason: "loading-visible", closePoints, backdropPoint, targetCovered, hitTag };
      if (dialogs.length > 0) return { blockerClass: topSurfaceIsCookie ? "cookie_banner" : topSurfaceIsTour ? "onboarding_tour" : "modal_dialog", reason: "dialog-visible", closePoints, backdropPoint, targetCovered, hitTag };
      if (targetCovered && overlays.length > 0) return { blockerClass: "popover_menu", reason: "target-covered-by-overlay", closePoints, backdropPoint, targetCovered, hitTag };
      if (targetCovered) return { blockerClass: "click_intercept", reason: "target-covered", closePoints, backdropPoint, targetCovered, hitTag };
      if (overlays.length > 0) return { blockerClass: topSurfaceIsCookie ? "cookie_banner" : topSurfaceIsTour ? "onboarding_tour" : "unknown_overlay", reason: "overlay-visible", closePoints, backdropPoint, targetCovered, hitTag };
      return { blockerClass: "none", reason: "clear", closePoints: [], backdropPoint: null, targetCovered: false, hitTag: "" };
    })()
  `;
}

async function scanUiBlockers(
  runtime: UiToolRuntime,
  tabId: number,
  targetPoint?: { x: number; y: number },
): Promise<UiBlockerScan> {
  const data = (await runtime.cdpEval(tabId, buildUiBlockerScanScript(targetPoint))) as UiBlockerScan;
  return data ?? {
    blockerClass: "none",
    reason: "scan-empty",
    closePoints: [],
    backdropPoint: null,
    targetCovered: false,
    hitTag: "",
  };
}

function scoreClosePoint(point: BlockerPoint, blockerClass: BlockerClass): number {
  const label = (point.label || "").toLowerCase();
  if (UI_STABILIZER_POLICY.riskyKeywords.some((k) => label.includes(k))) return -100;
  if (blockerClass === "cookie_banner") {
    if (UI_STABILIZER_POLICY.cookiePreference === "accept" && label.includes("accept")) return 90;
    if (UI_STABILIZER_POLICY.cookiePreference === "reject" && (label.includes("reject") || label.includes("deny"))) return 90;
  }
  let score = 0;
  for (const k of UI_STABILIZER_POLICY.safeCloseKeywords) if (label.includes(k)) score += 10;
  if (label.includes("close") || label.includes("dismiss")) score += 15;
  if (label.includes("skip")) score += 12;
  return score;
}

export async function resolveBlockers(
  runtime: UiToolRuntime,
  tabId: number,
  targetPoint?: { x: number; y: number },
): Promise<BlockerResolutionResult> {
  for (let attempt = 1; attempt <= UI_STABILIZER_MAX_ATTEMPTS; attempt += 1) {
    const scan = await scanUiBlockers(runtime, tabId, targetPoint);
    if (scan.blockerClass === "none") {
      return { status: "cleared", blockerClass: "none", details: "ui-clear" };
    }
    if (scan.blockerClass === "security_gate" || scan.blockerClass === "system_permission") {
      return { status: "escalate", blockerClass: scan.blockerClass, details: scan.reason };
    }
    if (scan.blockerClass === "loading_mask") {
      await runtime.sleep(Math.min(1400, 350 + attempt * 300));
      continue;
    }

    let handled = false;
    if (scan.closePoints.length > 0) {
      const best = [...scan.closePoints]
        .map((p) => ({ p, score: scoreClosePoint(p, scan.blockerClass) }))
        .sort((a, b) => b.score - a.score)[0];
      if (best && best.score > 0) {
        await runtime.clickPoint(tabId, best.p.x, best.p.y);
        handled = true;
      }
    }
    if (!handled) {
      await runtime.pressKey(tabId, "Escape");
      handled = true;
    }
    if (!handled && scan.backdropPoint) {
      await runtime.clickPoint(tabId, scan.backdropPoint.x, scan.backdropPoint.y);
      handled = true;
    }

    if (!handled) {
      return { status: "failed", blockerClass: scan.blockerClass, details: "unable-to-apply-resolution" };
    }
    await runtime.sleep(180 + attempt * 80);
  }

  const finalScan = await scanUiBlockers(runtime, tabId, targetPoint);
  if (finalScan.blockerClass === "loading_mask") {
    return { status: "waiting", blockerClass: finalScan.blockerClass, details: finalScan.reason };
  }
  return { status: "failed", blockerClass: finalScan.blockerClass, details: finalScan.reason };
}
