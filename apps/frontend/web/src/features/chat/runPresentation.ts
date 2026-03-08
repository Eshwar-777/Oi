import type { RunState } from "@/domain/automation";

export function getRunActionLabel(state: RunState) {
  return state === "waiting_for_user_action" || state === "waiting_for_human"
    ? "Confirm & Resume"
    : "Resume";
}

export function getRunSummary(state: RunState, reason?: string | null) {
  if (state === "waiting_for_user_action" || state === "waiting_for_human") {
    return {
      title: "Manual action required",
      subtitle:
        reason?.trim() || "Complete the requested step in the target app, then resume the run.",
    };
  }

  if (state === "paused" || state === "human_controlling") {
    return {
      title: state === "human_controlling" ? "You have control" : "Run paused",
      subtitle: reason?.trim() || "The run is paused and can continue from the latest safe point.",
    };
  }

  return {
    title: "",
    subtitle: "",
  };
}

export function shouldSimulateManualAction(goal: string) {
  const normalized = goal.toLowerCase();
  return (
    normalized.includes("whatsapp") ||
    normalized.includes("play") ||
    normalized.includes("captcha") ||
    normalized.includes("verification") ||
    normalized.includes("verify")
  );
}
