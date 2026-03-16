export type ConversationRecentsFilter =
  | "all"
  | "needs_attention"
  | "running"
  | "scheduled";

export interface ConversationRecentsItem {
  title?: string | null;
  last_run_state?: string | null;
  has_errors?: boolean | null;
  has_unread_updates?: boolean | null;
}

export type ConversationStatusTone =
  | "neutral"
  | "brand"
  | "warning"
  | "success"
  | "danger";

const RUNNING_STATES = new Set([
  "queued",
  "starting",
  "running",
  "resuming",
  "retrying",
]);

const NEEDS_ATTENTION_STATES = new Set([
  "waiting_for_user_action",
  "waiting_for_human",
  "failed",
]);

export const CONVERSATION_FILTER_LABELS: Record<
  ConversationRecentsFilter,
  string
> = {
  all: "All",
  needs_attention: "Needs attention",
  running: "Running",
  scheduled: "Scheduled",
};

export function conversationLabel(title?: string | null) {
  return title?.trim() || "Untitled conversation";
}

export function conversationMatchesFilter(
  conversation: ConversationRecentsItem,
  filter: ConversationRecentsFilter,
) {
  if (filter === "all") return true;
  if (filter === "running") {
    return RUNNING_STATES.has(conversation.last_run_state ?? "draft");
  }
  if (filter === "scheduled") {
    return conversation.last_run_state === "scheduled";
  }
  return Boolean(
    conversation.has_errors ||
      conversation.has_unread_updates ||
      NEEDS_ATTENTION_STATES.has(conversation.last_run_state ?? "draft"),
  );
}

export function conversationStatusTone(
  conversation: ConversationRecentsItem,
): ConversationStatusTone {
  if (conversation.has_errors || conversation.last_run_state === "failed") {
    return "danger";
  }
  if (
    conversation.has_unread_updates ||
    conversation.last_run_state === "waiting_for_human" ||
    conversation.last_run_state === "waiting_for_user_action"
  ) {
    return "warning";
  }
  if (conversation.last_run_state === "scheduled") return "success";
  if (
    conversation.last_run_state &&
    RUNNING_STATES.has(conversation.last_run_state)
  ) {
    return "brand";
  }
  return "neutral";
}
