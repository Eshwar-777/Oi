import type { RepairContext, RepairPlan, UiToolRuntime } from "./interfaces";

/**
 * Placeholder constrained repair module.
 *
 * This intentionally does deterministic micro-repair (Escape + short wait)
 * and avoids free-form autonomous behavior. Backend planner repair remains
 * the primary higher-level recovery path.
 */
export async function repairWithLlm(
  runtime: UiToolRuntime,
  tabId: number,
  context: RepairContext,
): Promise<RepairPlan> {
  const reason = context.failureReason.toLowerCase();
  if (reason.includes("captcha") || reason.includes("security") || reason.includes("permission")) {
    return { status: "skipped", reason: "manual-intervention-required" };
  }

  await runtime.pressKey(tabId, "Escape");
  await runtime.sleep(160);
  return { status: "applied", reason: "deterministic-escape-repair" };
}
