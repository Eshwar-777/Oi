export type SharedRunTone =
  | "neutral"
  | "brand"
  | "warning"
  | "success"
  | "danger"
  | "info";

export function runStateLabel(state?: string | null) {
  return (state || "unknown").replace(/_/g, " ");
}

export function runStateTone(state?: string | null): SharedRunTone {
  if (state === "completed" || state === "succeeded") return "success";
  if (
    state === "failed" ||
    state === "cancelled" ||
    state === "canceled" ||
    state === "timed_out"
  ) {
    return "danger";
  }
  if (
    state === "paused" ||
    state === "waiting_for_user_action" ||
    state === "waiting_for_human" ||
    state === "human_controlling"
  ) {
    return "warning";
  }
  if (state === "scheduled") return "info";
  if (
    state === "running" ||
    state === "queued" ||
    state === "retrying" ||
    state === "starting" ||
    state === "resuming"
  ) {
    return "brand";
  }
  return "neutral";
}

export function runStateHeadline(state?: string | null) {
  switch (state) {
    case "running":
    case "starting":
    case "resuming":
      return "Running";
    case "paused":
      return "Paused";
    case "waiting_for_user_action":
      return "Waiting for login";
    case "waiting_for_human":
      return "Needs confirmation";
    case "retrying":
      return "Retrying after rate limit";
    case "failed":
      return "Failed";
    case "completed":
    case "succeeded":
      return "Completed";
    default:
      return "Planning";
  }
}
