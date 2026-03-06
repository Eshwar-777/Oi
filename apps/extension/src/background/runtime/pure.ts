import {
  DEBUG_INFOBAR_GUARD_TOP_PX,
  DEBUG_INFOBAR_SAFE_OFFSET_PX,
  UI_STABILIZER_POLICY,
} from "./constants";
import type { BlockerClass, BlockerPoint, CoordsTarget, ElementBox, ExtensionErrorCode } from "./types";

export function parseCoordsTarget(target: unknown): CoordsTarget | null {
  if (!target || typeof target !== "object") return null;
  const maybe = target as Record<string, unknown>;
  if (maybe.by !== "coords") return null;
  const x = Number(maybe.x);
  const y = Number(maybe.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { by: "coords", x, y };
}

export function isPotentiallyUnderDebuggerInfobar(y: number): boolean {
  return y < DEBUG_INFOBAR_GUARD_TOP_PX;
}

export function infobarGuardError(y: number): string {
  return `Blocked by browser debugger infobar at top (y=${y}). Prefer ref/semantic target or close debug banner and retry.`;
}

export function tryAdjustPointForInfobar(
  box: ElementBox | undefined,
  x: number,
  y: number,
): { x: number; y: number; adjusted: boolean } {
  if (!isPotentiallyUnderDebuggerInfobar(y)) {
    return { x, y, adjusted: false };
  }
  if (!box) {
    return { x, y, adjusted: false };
  }
  const top = Math.round(box.y - box.height / 2);
  const bottom = Math.round(box.y + box.height / 2);
  const candidateY = Math.max(DEBUG_INFOBAR_GUARD_TOP_PX + DEBUG_INFOBAR_SAFE_OFFSET_PX, top + 2);
  if (candidateY <= bottom - 2) {
    return { x, y: candidateY, adjusted: true };
  }
  return { x, y, adjusted: false };
}

export function normalizeDisambiguation(raw: unknown): Record<string, unknown> {
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const maxRaw = Number(data.max_matches);
  const maxMatches = Number.isFinite(maxRaw) ? Math.max(1, Math.min(5, Math.round(maxRaw))) : 1;
  return {
    max_matches: maxMatches,
    must_be_visible: data.must_be_visible !== false,
    must_be_enabled: data.must_be_enabled !== false,
    prefer_topmost: data.prefer_topmost !== false,
  };
}

export function scoreClosePoint(point: BlockerPoint, blockerClass: BlockerClass): number {
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

export function classifyActionResult(resultMessage: string): { status: "done" | "error"; errorCode?: ExtensionErrorCode } {
  const text = (resultMessage || "").toLowerCase();
  if (!text) return { status: "done" };
  if (text.startsWith("unknown action kind")) return { status: "error", errorCode: "INVALID_ACTION" };
  if (text.startsWith("unknown ref") || text.startsWith("ref not found")) return { status: "error", errorCode: "STALE_REF" };
  if (text.startsWith("element not found") || text.startsWith("not found")) return { status: "error", errorCode: "NOT_FOUND" };
  if (text.startsWith("timeout waiting")) return { status: "error", errorCode: "TIMEOUT" };
  if (text.startsWith("manual intervention required")) return { status: "error", errorCode: "SECURITY_GATE" };
  if (text.startsWith("blocked by browser debugger infobar")) return { status: "error", errorCode: "INFOBAR_INTERCEPT" };
  if (text.startsWith("not clickable") || text.startsWith("not editable") || text.startsWith("not selectable")) {
    if (text.includes("blocker-")) return { status: "error", errorCode: "BLOCKED_UI" };
    return { status: "error", errorCode: "NOT_ACTIONABLE" };
  }
  if (text.startsWith("error:") || text.startsWith("js error")) return { status: "error", errorCode: "EXECUTION_ERROR" };
  return { status: "done" };
}

