import type {
  UiToolRuntime,
  VerifyPostconditionInput,
  VerifyPostconditionResult,
} from "./interfaces";

export async function verifyPostcondition(
  runtime: UiToolRuntime,
  tabId: number,
  input: VerifyPostconditionInput,
): Promise<VerifyPostconditionResult> {
  if (input.action === "type" || input.action === "select") {
    const value = String(input.intendedValue || "");
    if (!value) return { ok: true, reason: "no-value-to-verify" };

    const check = (await runtime.cdpEval(tabId, `
      (() => {
        const active = document.activeElement;
        if (!active) return { ok: false, reason: "no-active-element" };
        const val = (active && typeof active === "object" && "value" in active)
          ? active.value
          : (active.textContent ?? "");
        const text = String(val || "");
        return { ok: text.includes(${JSON.stringify(value)}), reason: text.length ? "active-value-check" : "empty-active-value" };
      })()
    `)) as { ok?: boolean; reason?: string };

    return { ok: Boolean(check?.ok), reason: String(check?.reason || "postcondition-check") };
  }

  return { ok: true, reason: "no-postcondition-required" };
}
