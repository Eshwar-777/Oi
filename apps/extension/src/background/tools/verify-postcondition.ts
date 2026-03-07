import type {
  UiToolRuntime,
  VerifyPostconditionInput,
  VerifyPostconditionResult,
} from "./interfaces";
import { locateTarget } from "./locate-target";

export async function verifyPostcondition(
  runtime: UiToolRuntime,
  tabId: number,
  input: VerifyPostconditionInput,
): Promise<VerifyPostconditionResult> {
  if (input.action === "type" || input.action === "select") {
    const value = String(input.intendedValue || "");
    if (!value) return { ok: true, reason: "no-value-to-verify" };

    const located = await locateTarget(runtime, tabId, input.target);
    const pointLiteral =
      located.ok && typeof located.x === "number" && typeof located.y === "number"
        ? `{ x: ${Math.round(located.x)}, y: ${Math.round(located.y)} }`
        : "null";

    const check = (await runtime.cdpEval(tabId, `
      (() => {
        const expected = ${JSON.stringify(value)};
        const point = ${pointLiteral};
        const seen = new Set();
        const candidates = [];

        function normalizeCandidate(el) {
          if (!el || !(el instanceof Element)) return null;
          if (el instanceof HTMLLabelElement) {
            if (el.control) return el.control;
            const htmlFor = el.getAttribute("for");
            if (htmlFor) {
              const byFor = document.getElementById(htmlFor);
              if (byFor) return byFor;
            }
          }
          return el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"]')
            || el.querySelector?.('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"]')
            || el;
        }

        function push(el) {
          const candidate = normalizeCandidate(el);
          if (!candidate) return;
          if (seen.has(candidate)) return;
          seen.add(candidate);
          candidates.push(candidate);
        }

        function candidateText(el) {
          if (!el) return "";
          if ("value" in el && typeof el.value !== "undefined") {
            return String(el.value || "");
          }
          return String(el.textContent || "");
        }

        push(document.activeElement);
        if (point) {
          push(document.elementFromPoint(point.x, point.y));
        }

        for (const candidate of candidates) {
          const text = candidateText(candidate).trim();
          if (!text) continue;
          if (text.includes(expected)) {
            return { ok: true, reason: candidate === document.activeElement ? "active-value-check" : "target-value-check" };
          }
          if (${JSON.stringify(input.action)} === "select" && candidate instanceof HTMLSelectElement) {
            const selected = candidate.selectedOptions?.[0];
            const selectedText = String(selected?.textContent || "").trim();
            if (selectedText.includes(expected)) {
              return { ok: true, reason: "selected-option-text-check" };
            }
          }
        }

        if (!candidates.length) return { ok: false, reason: "no-candidate-element" };
        return { ok: false, reason: "value-mismatch" };
      })()
    `)) as { ok?: boolean; reason?: string };

    return { ok: Boolean(check?.ok), reason: String(check?.reason || "postcondition-check") };
  }

  return { ok: true, reason: "no-postcondition-required" };
}
