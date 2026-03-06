import type { ClickableAssertionResult, UiToolRuntime } from "./interfaces";

export async function assertClickable(
  runtime: UiToolRuntime,
  tabId: number,
  x: number,
  y: number,
): Promise<ClickableAssertionResult> {
  const result = (await runtime.cdpEval(tabId, `
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
  `)) as ClickableAssertionResult;
  return result ?? { ok: false, reason: "actionability-check-failed" };
}
