import { useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import {
  MobileScreen,
  SectionHeader,
  StatusChip,
  SurfaceCard,
  useMobileTheme,
} from "@oi/design-system-mobile";
import { useMobileAssistant } from "@/features/assistant/MobileAssistantContext";

import {
  listAutomationEngineAnalytics,
  listRuntimeIncidentAnalytics,
  listSchedules,
  type AutomationEngineAnalyticsItem,
  type RuntimeIncidentAnalyticsItem,
  type ScheduleSummaryCard,
} from "@/lib/automation";
import { AssistantStatusCard, describeNotificationContext } from "@/features/assistant/ui";

function prettyDateTime(value?: string | null) {
  if (!value) return "No recent activity";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

function scheduleTone(
  status: ScheduleSummaryCard["status"],
): "warning" | "success" {
  return status === "draft" ? "warning" : "success";
}

function incidentTone(
  category: RuntimeIncidentAnalyticsItem["category"],
): "warning" | "danger" | "brand" {
  if (category === "human_takeover" || category === "security") return "danger";
  if (category === "resume_reconciliation") return "brand";
  return "warning";
}

export default function SchedulesScreen() {
  const theme = useMobileTheme();
  const router = useRouter();
  const { activeRun, schedules: sessionSchedules, notificationContext } = useMobileAssistant();
  const [schedules, setSchedules] = useState<ScheduleSummaryCard[]>([]);
  const [analytics, setAnalytics] = useState<AutomationEngineAnalyticsItem[]>([]);
  const [incidents, setIncidents] = useState<RuntimeIncidentAnalyticsItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setErrorMessage("");
    try {
      const [scheduleItems, analyticsItems, incidentItems] = await Promise.all([
        listSchedules(),
        listAutomationEngineAnalytics(),
        listRuntimeIncidentAnalytics(),
      ]);
      setSchedules(scheduleItems);
      setAnalytics(analyticsItems);
      setIncidents(incidentItems);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadData();
    }, [loadData]),
  );

  const topIncidents = useMemo(() => incidents.slice(0, 6), [incidents]);
  const displayedSchedules = useMemo(() => {
    const merged = new Map<string, ScheduleSummaryCard>();
    for (const item of schedules) {
      merged.set(item.schedule_id, item);
    }
    for (const item of sessionSchedules) {
      merged.set(item.schedule_id, item);
    }
    return Array.from(merged.values());
  }, [schedules, sessionSchedules]);

  const styles = useMemo(() => getSchedulesStyles(theme), [theme]);

  return (
    <MobileScreen style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadData()} />}
      >
        <SectionHeader
          eyebrow="Schedules"
          title="Automation activity"
          description="Review engine health, blocker patterns, and the upcoming automations created from chat."
        />

        {notificationContext ? (
          <AssistantStatusCard
            eyebrow="Alert"
            title="Last alert context"
            description={describeNotificationContext(notificationContext)}
            variant="alert"
            metaItems={[
              notificationContext.runId ? `Run ${notificationContext.runId}` : "",
              notificationContext.browserSessionId ? `Session ${notificationContext.browserSessionId}` : "",
            ]}
            quickLinks={[
              ...(notificationContext.runId
                ? [{ label: "Open sessions", onPress: () => router.push(`/(tabs)/navigator?run_id=${encodeURIComponent(notificationContext.runId!)}`) }]
                : []),
              { label: "Open chat", onPress: () => router.push("/(tabs)/chat") },
            ]}
          />
        ) : null}

        {activeRun ? (
          <AssistantStatusCard
            eyebrow="Run"
            title="Live assistant run"
            description="The current assistant session is already tracking an active or recent run."
            state={activeRun.state}
            executionMode={activeRun.execution_mode}
            variant="run"
            metaItems={[
              `Run ${activeRun.run_id}`,
              sessionSchedules.length > 0
                ? `${sessionSchedules.length} session schedule${sessionSchedules.length === 1 ? "" : "s"}`
                : "No session schedules yet",
            ]}
            quickLinks={[
              { label: "Open live chat", onPress: () => router.push(activeRun.run_id ? `/(tabs)/chat?run_id=${encodeURIComponent(activeRun.run_id)}` : "/(tabs)/chat") },
              { label: "Open sessions", onPress: () => router.push(`/(tabs)/navigator?run_id=${encodeURIComponent(activeRun.run_id)}`) },
            ]}
          />
        ) : null}

        {errorMessage ? (
          <SurfaceCard>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </SurfaceCard>
        ) : null}

        <View style={styles.grid}>
          {analytics.map((item) => (
            <SurfaceCard key={item.automation_engine} style={styles.metricCard}>
              <Text style={styles.cardEyebrow}>Engine</Text>
              <Text style={styles.cardTitle}>{item.automation_engine.replace(/_/g, " ")}</Text>
              <Text style={styles.cardSub}>{item.total_runs} total runs</Text>
              <View style={styles.chipRow}>
                <StatusChip label={`Success ${(item.success_rate * 100).toFixed(0)}%`} tone="success" />
                <StatusChip label={`Fail ${(item.failure_rate * 100).toFixed(0)}%`} tone="danger" />
                <StatusChip label={`Human ${(item.human_pause_rate * 100).toFixed(0)}%`} tone="warning" />
              </View>
              <Text style={styles.bodyText}>
                Avg duration {item.avg_duration_seconds != null ? `${item.avg_duration_seconds.toFixed(1)}s` : "n/a"}
              </Text>
              <Text style={styles.bodyText}>
                Runtime split {item.server_runner_runs} server / {item.local_runner_runs} local
              </Text>
              <Text style={styles.captionText}>Last run {prettyDateTime(item.last_run_at)}</Text>
            </SurfaceCard>
          ))}
        </View>

        <SurfaceCard style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Runtime incidents</Text>
          <Text style={styles.sectionDescription}>
            These are the current blocker patterns forcing handoff or reconciliation.
          </Text>
          {topIncidents.length === 0 ? (
            <Text style={styles.bodyText}>No incident analytics yet.</Text>
          ) : (
            topIncidents.map((item) => (
              <View key={`${item.incident_code}-${item.site}`} style={styles.dividedRow}>
                <View style={styles.stack}>
                  <Text style={styles.rowTitle}>{item.incident_code.replace(/_/g, " ")}</Text>
                  <Text style={styles.rowSub}>
                    {item.site} · {item.total_runs} runs
                  </Text>
                  <View style={styles.chipRow}>
                    <StatusChip label={item.category.replace(/_/g, " ")} tone={incidentTone(item.category)} />
                    <StatusChip label={`Human ${item.waiting_for_human_runs}`} tone="danger" />
                    <StatusChip label={`Replan ${item.reconciliation_runs}`} tone="brand" />
                  </View>
                  <Text style={styles.captionText}>Last seen {prettyDateTime(item.last_seen_at)}</Text>
                </View>
              </View>
            ))
          )}
        </SurfaceCard>

        <SurfaceCard style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Upcoming events from chat</Text>
          <Text style={styles.sectionDescription}>
            Once, interval, and multi-time automations show up here after chat resolves the timing.
          </Text>
          {sessionSchedules.length > 0 ? (
            <Text style={styles.captionText}>
              {sessionSchedules.length} schedule{sessionSchedules.length === 1 ? "" : "s"} are already loaded from the live assistant session.
            </Text>
          ) : null}
          {displayedSchedules.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyTitle}>No scheduled automations yet</Text>
              <Text style={styles.emptyText}>
                Ask for a recurring or later run in chat and the event will appear here.
              </Text>
              <View style={styles.emptyButton}>
                <Pressable onPress={() => router.push("/(tabs)/chat")} style={styles.linkButton}>
                  <Text style={styles.linkButtonText}>Open chat</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            displayedSchedules.map((schedule) => (
              <Pressable
                key={schedule.schedule_id}
                onPress={() => schedule.run_id && router.push(`/(tabs)/navigator?run_id=${encodeURIComponent(schedule.run_id)}`)}
                disabled={!schedule.run_id}
                style={({ pressed }) => [styles.scheduleCard, pressed ? styles.pressed : null]}
              >
                <Text style={styles.cardEyebrow}>Upcoming event</Text>
                <Text style={styles.cardTitle}>{schedule.summary}</Text>
                <Text style={styles.cardSub}>{schedule.user_goal}</Text>
                <View style={styles.chipRow}>
                  <StatusChip
                    label={schedule.status === "draft" ? "pending setup" : "scheduled"}
                    tone={scheduleTone(schedule.status)}
                  />
                  <StatusChip label={schedule.execution_mode.replace(/_/g, " ")} tone="brand" />
                  {schedule.executor_mode ? (
                    <StatusChip label={schedule.executor_mode.replace(/_/g, " ")} tone="neutral" />
                  ) : null}
                  {schedule.automation_engine ? (
                    <StatusChip label={schedule.automation_engine.replace(/_/g, " ")} tone="brand" />
                  ) : null}
                </View>
                <View style={styles.metaGrid}>
                  <View style={styles.metaCard}>
                    <Text style={styles.metaLabel}>Created</Text>
                    <Text style={styles.metaValue}>{prettyDateTime(schedule.created_at)}</Text>
                  </View>
                  <View style={styles.metaCard}>
                    <Text style={styles.metaLabel}>Timezone</Text>
                    <Text style={styles.metaValue}>{schedule.timezone}</Text>
                  </View>
                </View>
                <Text style={styles.metaLabel}>Next occurrences</Text>
                {schedule.run_times.length > 0 ? (
                  schedule.run_times.map((time) => (
                    <Text key={time} style={styles.metaValue}>
                      {prettyDateTime(time)}
                    </Text>
                  ))
                ) : (
                  <Text style={styles.bodyText}>Waiting for the exact upcoming time from chat.</Text>
                )}
              </Pressable>
            ))
          )}
        </SurfaceCard>
      </ScrollView>
    </MobileScreen>
  );
}

function getSchedulesStyles(theme: ReturnType<typeof useMobileTheme>) {
  return StyleSheet.create({
  screen: {
    paddingTop: theme.spacing[4],
  },
  content: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  grid: {
    gap: theme.spacing[3],
  },
  metricCard: {
    gap: theme.spacing[2],
  },
  liveCard: {
    gap: theme.spacing[3],
  },
  sectionCard: {
    gap: theme.spacing[3],
  },
  cardEyebrow: {
    fontSize: theme.typography.fontSize.xs,
    fontWeight: "700",
    letterSpacing: 1,
    color: theme.colors.textSoft,
    textTransform: "uppercase",
  },
  cardTitle: {
    fontSize: theme.typography.fontSize.lg,
    fontWeight: "700",
    color: theme.colors.text,
  },
  cardSub: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textMuted,
  },
  sectionTitle: {
    fontSize: theme.typography.fontSize.lg,
    fontWeight: "700",
    color: theme.colors.text,
  },
  sectionDescription: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textMuted,
  },
  bodyText: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textMuted,
  },
  captionText: {
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textSoft,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  dividedRow: {
    paddingTop: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  stack: {
    gap: theme.spacing[2],
  },
  rowTitle: {
    fontSize: theme.typography.fontSize.sm,
    fontWeight: "700",
    color: theme.colors.text,
  },
  rowSub: {
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textMuted,
  },
  errorText: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.error,
  },
  emptyState: {
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  emptyTitle: {
    fontSize: theme.typography.fontSize.base,
    fontWeight: "700",
    color: theme.colors.text,
  },
  emptyText: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textMuted,
  },
  emptyButton: {
    paddingTop: theme.spacing[1],
  },
  linkButton: {
    alignSelf: "flex-start",
    minHeight: 40,
    justifyContent: "center",
  },
  linkButtonText: {
    fontSize: theme.typography.fontSize.sm,
    fontWeight: "700",
    color: theme.colors.primary,
  },
  scheduleCard: {
    gap: theme.spacing[3],
    paddingTop: theme.spacing[3],
    marginTop: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  pressed: {
    opacity: 0.84,
  },
  metaGrid: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  metaCard: {
    flex: 1,
    gap: theme.spacing[1],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.sm,
    backgroundColor: theme.colors.surfaceMuted,
    padding: theme.spacing[3],
  },
  metaLabel: {
    fontSize: theme.typography.fontSize.xs,
    fontWeight: "700",
    color: theme.colors.textSoft,
    textTransform: "uppercase",
  },
  metaValue: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.text,
  },
});
}
