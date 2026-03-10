import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { StatusChip, SurfaceCard, mobileTheme } from "@oi/design-system-mobile";

import type { AutomationRun, RunEventRecord, RunState } from "@/lib/automation";
import type { NotificationContext } from "@/features/assistant/MobileAssistantContext";

export function runStateLabel(state: RunState | string) {
  return state.replace(/_/g, " ");
}

export function runTone(
  state: RunState | string,
): "neutral" | "brand" | "warning" | "success" | "danger" | "info" {
  if (state === "completed" || state === "succeeded") return "success";
  if (state === "failed" || state === "cancelled" || state === "canceled" || state === "timed_out") return "danger";
  if (state === "paused" || state === "waiting_for_user_action" || state === "waiting_for_human" || state === "human_controlling") {
    return "warning";
  }
  if (state === "scheduled") return "info";
  if (state === "running" || state === "queued" || state === "retrying" || state === "starting" || state === "resuming") {
    return "brand";
  }
  return "neutral";
}

export function getRunActionLabel(state: RunState) {
  return state === "waiting_for_user_action" || state === "waiting_for_human" ? "Confirm & resume" : "Resume";
}

export function getRunSummary(run: AutomationRun | null, reason?: string | null) {
  if (!run) return { title: "", subtitle: "" };
  if (run.state === "waiting_for_user_action" || run.state === "waiting_for_human") {
    return {
      title: "Manual action required",
      subtitle: reason?.trim() || "Complete the requested step in the target app, then resume the run.",
    };
  }
  if (run.state === "paused" || run.state === "human_controlling") {
    return {
      title: run.state === "human_controlling" ? "You have control" : "Run paused",
      subtitle: reason?.trim() || "The run is paused and can continue from the latest safe point.",
    };
  }
  if (run.state === "failed") {
    return {
      title: "Something needs attention",
      subtitle: run.last_error?.message || "The run hit an issue and can be retried from the latest safe point.",
    };
  }
  return { title: "", subtitle: "" };
}

export function describeReplanReasons(reasons?: string[]) {
  if (!reasons?.length) return "the agent refreshed the plan against the current page";
  return reasons
    .map((reason) => {
      if (reason === "context_change") return "the page context changed";
      if (reason === "next_step_uses_ref") return "the next step needed fresh refs";
      if (reason === "next_step_interactive") return "the next step was interactive";
      return reason.replace(/_/g, " ");
    })
    .join(", ");
}

function incidentSummary(event: RunEventRecord | null) {
  const incident = event?.payload?.incident;
  if (!incident || typeof incident !== "object") return null;
  return String((incident as Record<string, unknown>).summary ?? (incident as Record<string, unknown>).code ?? "runtime incident");
}

export function describeNotificationContext(context: NotificationContext | null) {
  if (!context) return "";
  return [
    context.eventType?.replace(/_/g, " ") || "Notification",
    context.incidentCode,
    context.reasonCode,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function AssistantQuickLinks({
  links,
}: {
  links: Array<{ label: string; onPress: () => void }>;
}) {
  if (links.length === 0) return null;

  return (
    <View style={styles.quickLinksRow}>
      {links.map((link) => (
        <Pressable key={link.label} onPress={link.onPress} style={({ pressed }) => [styles.quickLink, pressed ? styles.pressed : null]}>
          <Text style={styles.quickLinkText}>{link.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function AssistantStatusCard({
  eyebrow,
  title,
  description,
  state,
  executionMode,
  variant = "default",
  metaItems = [],
  quickLinks = [],
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  state?: RunState | string | null;
  executionMode?: string | null;
  variant?: "default" | "run" | "alert";
  metaItems?: string[];
  quickLinks?: Array<{ label: string; onPress: () => void }>;
  children?: ReactNode;
}) {
  const cardTone =
    variant === "run"
      ? styles.statusCardRun
      : variant === "alert"
        ? styles.statusCardAlert
        : null;

  return (
    <SurfaceCard style={[styles.statusCard, cardTone]}>
      <View style={[styles.accentBar, variant === "run" ? styles.accentBarRun : variant === "alert" ? styles.accentBarAlert : styles.accentBarDefault]} />
      {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
      <View style={styles.stack}>
        <Text style={styles.title}>{title}</Text>
        {description ? <Text style={styles.bodyText}>{description}</Text> : null}
      </View>
      {metaItems.length > 0 ? (
        <View style={styles.metaRow}>
          {metaItems.filter(Boolean).map((item) => (
            <Text key={item} style={styles.metaText}>
              {item}
            </Text>
          ))}
        </View>
      ) : null}
      {state ? <RunStatusChips state={state} executionMode={executionMode} /> : null}
      {children}
      <AssistantQuickLinks links={quickLinks} />
    </SurfaceCard>
  );
}

export function RunStatusChips({
  state,
  executionMode,
}: {
  state: RunState | string;
  executionMode?: string | null;
}) {
  return (
    <View style={styles.chipRow}>
      <StatusChip label={runStateLabel(state)} tone={runTone(state)} />
      {executionMode ? (
        <StatusChip label={executionMode.replace(/_/g, " ")} tone="brand" />
      ) : null}
    </View>
  );
}

export function IncidentSummaryBlock({
  latestReplanEvent,
  latestIncidentEvent,
  requestedRunId,
}: {
  latestReplanEvent: RunEventRecord | null;
  latestIncidentEvent: RunEventRecord | null;
  requestedRunId?: string | null;
}) {
  const latestIncident = incidentSummary(latestIncidentEvent);

  return (
    <View style={styles.stack}>
      <View style={styles.summaryBlock}>
        <Text style={styles.summaryLabel}>Latest replan</Text>
        <Text style={styles.bodyText}>
          {latestReplanEvent?.payload
            ? `After ${latestReplanEvent.payload.completed_command ?? "the last step"}, the agent replanned because ${describeReplanReasons(latestReplanEvent.payload.replan_reasons)}. Next command: ${latestReplanEvent.payload.next_command ?? "unknown"}.`
            : requestedRunId
              ? `If the agent replans from the current UI state for run ${requestedRunId}, the reason will appear here.`
              : "No recent replans for this run."}
        </Text>
      </View>
      {latestIncident ? (
        <View style={styles.summaryBlock}>
          <Text style={styles.summaryLabel}>Latest incident</Text>
          <Text style={styles.bodyText}>{latestIncident}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: mobileTheme.spacing[2],
  },
  statusCard: {
    gap: mobileTheme.spacing[3],
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
  },
  statusCardRun: {
    backgroundColor: "#FFF8E8",
    borderColor: "rgba(184, 134, 11, 0.28)",
  },
  statusCardAlert: {
    backgroundColor: "#FFF3F0",
    borderColor: "rgba(194, 77, 32, 0.22)",
  },
  stack: {
    gap: mobileTheme.spacing[1],
  },
  accentBar: {
    height: 4,
    borderRadius: mobileTheme.radii.full,
  },
  accentBarDefault: {
    backgroundColor: mobileTheme.colors.border,
  },
  accentBarRun: {
    backgroundColor: "#C88B1E",
  },
  accentBarAlert: {
    backgroundColor: "#D2643F",
  },
  eyebrow: {
    fontSize: mobileTheme.typography.fontSize.xs,
    fontWeight: "700",
    letterSpacing: 1,
    color: mobileTheme.colors.textSoft,
    textTransform: "uppercase",
  },
  title: {
    fontSize: mobileTheme.typography.fontSize.lg,
    fontWeight: "700",
    color: mobileTheme.colors.text,
  },
  bodyText: {
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.textMuted,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: mobileTheme.spacing[2],
  },
  metaText: {
    fontSize: mobileTheme.typography.fontSize.xs,
    color: mobileTheme.colors.textSoft,
  },
  quickLinksRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: mobileTheme.spacing[2],
    paddingTop: mobileTheme.spacing[1],
    borderTopWidth: 1,
    borderTopColor: mobileTheme.colors.border,
  },
  quickLink: {
    minHeight: 40,
    justifyContent: "center",
    borderRadius: mobileTheme.radii.full,
    backgroundColor: "rgba(255,255,255,0.78)",
    borderWidth: 1,
    borderColor: "rgba(15,23,42,0.08)",
    paddingHorizontal: mobileTheme.spacing[3],
    paddingVertical: mobileTheme.spacing[2],
  },
  quickLinkText: {
    fontSize: mobileTheme.typography.fontSize.sm,
    fontWeight: "700",
    color: mobileTheme.colors.primary,
  },
  pressed: {
    opacity: 0.84,
  },
  summaryBlock: {
    gap: mobileTheme.spacing[1],
    borderRadius: mobileTheme.radii.sm,
    backgroundColor: "rgba(255,255,255,0.72)",
    borderWidth: 1,
    borderColor: "rgba(15,23,42,0.08)",
    padding: mobileTheme.spacing[3],
  },
  summaryLabel: {
    fontSize: mobileTheme.typography.fontSize.xs,
    fontWeight: "700",
    textTransform: "uppercase",
    color: mobileTheme.colors.textSoft,
    letterSpacing: 0.8,
  },
});
