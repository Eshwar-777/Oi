import type { ConversationDecision, RunState } from "@/domain/automation";

export function decisionLabel(decision: ConversationDecision) {
  switch (decision) {
    case "GENERAL_CHAT":
      return "Conversation";
    case "ASK_CLARIFICATION":
      return "Needs more detail";
    case "ASK_EXECUTION_MODE":
      return "Choose a run style";
    case "REQUIRES_CONFIRMATION":
      return "Review before action";
    case "READY_TO_EXECUTE":
      return "Ready to run";
    case "READY_TO_SCHEDULE":
      return "Ready to schedule";
    case "READY_FOR_MULTI_TIME_SCHEDULE":
      return "Ready for repeated schedule";
    default:
      return "Blocked";
  }
}

export function missingFieldLabel(field: string) {
  const map: Record<string, string> = {
    goal: "Goal",
    message_text: "Message text",
    recipient: "Recipient",
    app: "App",
    timing_mode: "When and how to run it",
  };
  return map[field] ?? field.replaceAll("_", " ");
}

export function runStateLabel(state: RunState) {
  switch (state) {
    case "draft":
      return "Preparing";
    case "awaiting_clarification":
      return "Waiting for more detail";
    case "awaiting_execution_mode":
      return "Waiting for run style";
    case "awaiting_confirmation":
      return "Waiting for confirmation";
    case "scheduled":
      return "Scheduled";
    case "queued":
      return "Queued";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "waiting_for_user_action":
    case "waiting_for_human":
      return "Waiting on you";
    case "human_controlling":
      return "In takeover";
    case "resuming":
      return "Resuming";
    case "retrying":
      return "Retrying";
    case "completed":
    case "succeeded":
      return "Completed";
    case "failed":
      return "Needs attention";
    case "cancelled":
    case "canceled":
      return "Stopped";
    case "timed_out":
      return "Timed out";
    case "expired":
      return "Expired";
    default:
      return "In progress";
  }
}

export function errorCopy(code: string) {
  const map: Record<string, string> = {
    USER_INTERRUPTION: "The run was stopped because someone took over the interface.",
    ELEMENT_NOT_FOUND: "I could not find the control I expected.",
    ELEMENT_AMBIGUOUS: "I found more than one matching control and need clearer guidance.",
    PAGE_CHANGED: "The target page changed before I could finish the step.",
    AUTH_REQUIRED: "A login or re-authentication step is required before continuing.",
    SECURITY_CHALLENGE: "A security check blocked the automation.",
    APP_UNAVAILABLE: "The target application is not available right now.",
    DEVICE_DISCONNECTED: "The linked device disconnected during the run.",
    TAB_DETACHED: "The target surface is no longer attached.",
    PERMISSION_DENIED: "I do not have permission to complete that action.",
    TIMEOUT: "The task took too long and timed out.",
    SENSITIVE_ACTION_BLOCKED: "I stopped because the action appears too sensitive to proceed automatically.",
    MODEL_UNCERTAIN: "I am not confident enough in the current plan.",
    FILE_PARSE_FAILED: "I could not understand the uploaded file.",
    CROSS_APP_HANDOFF_FAILED: "The workflow could not move into the next app cleanly.",
    SCHEDULE_MISFIRED: "The scheduled run did not start at the expected time.",
    RESUME_NOT_POSSIBLE: "This run cannot resume from its current state.",
  };

  return map[code] ?? "The run hit an issue and needs a manual decision.";
}
