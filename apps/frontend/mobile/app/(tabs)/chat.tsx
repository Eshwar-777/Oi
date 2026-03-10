import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import {
  MobileScreen,
  PrimaryButton,
  SectionHeader,
  StatusChip,
  SurfaceCard,
  mobileTheme,
} from "@oi/design-system-mobile";
import { chatTurn } from "@/lib/automation";
import { useMobileAssistant } from "@/features/assistant/MobileAssistantContext";
import { AssistantStatusCard, describeNotificationContext, runStateLabel, runTone } from "@/features/assistant/ui";

function currentLocale() {
  try {
    const options = Intl.DateTimeFormat().resolvedOptions();
    return options.locale || "en-US";
  } catch {
    return "en-US";
  }
}

function currentTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function prettyDateTime(value?: string | null) {
  if (!value) return "Waiting for next run";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

export default function ChatScreen() {
  const router = useRouter();
  const {
    sessionId,
    hasHydrated,
    streamStatus,
    messages,
    activeRun,
    runDetail,
    schedules,
    appendUserMessage,
    appendAssistantMessage,
    hydrateRemoteState,
    notificationContext,
  } = useMobileAssistant();
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const scrollRef = useRef<ScrollView | null>(null);
  const activityRef = useRef<ScrollView | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!hasHydrated) return () => undefined;
      void hydrateRemoteState();
      return () => undefined;
    }, [hasHydrated, hydrateRemoteState]),
  );

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages.length, isSending]);

  const executionProgress = activeRun?.execution_progress ?? runDetail?.run.execution_progress ?? null;
  const activityLog = executionProgress?.recent_action_log ?? [];
  const interruption = executionProgress?.interruption ?? null;
  const predictedPhases = executionProgress?.predicted_phases ?? [];

  useEffect(() => {
    activityRef.current?.scrollToEnd({ animated: true });
  }, [activityLog.length, interruption, activeRun?.state]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isSending) return;

    setIsSending(true);
    setErrorMessage("");
    appendUserMessage(text);
    setInput("");

    try {
      const response = await chatTurn({
        session_id: sessionId,
        inputs: [{ type: "text", text }],
        client_context: {
          timezone: currentTimezone(),
          locale: currentLocale(),
        },
      });
      appendAssistantMessage(response.assistant_message.text);
      await hydrateRemoteState();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to send message");
    } finally {
      setIsSending(false);
    }
  }, [appendAssistantMessage, appendUserMessage, hydrateRemoteState, input, isSending, sessionId]);

  const runMeta = useMemo(() => {
    if (!activeRun) return [];
    return [
      `Run ${activeRun.run_id}`,
      activeRun.execution_mode.replace(/_/g, " "),
    ];
  }, [activeRun]);

  return (
    <MobileScreen style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
        <SectionHeader
          eyebrow="Conversation"
          title="Chat"
          description="Type what you want. The assistant will clarify missing details, run when ready, and keep the execution log visible here."
        />

        {notificationContext ? (
          <AssistantStatusCard
            eyebrow="Alert"
            title="Last alert"
            description={describeNotificationContext(notificationContext)}
            variant="alert"
            quickLinks={[
              { label: "Open schedules", onPress: () => router.push("/(tabs)/schedules") },
            ]}
          />
        ) : null}

        {errorMessage ? (
          <SurfaceCard>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </SurfaceCard>
        ) : null}

        <SurfaceCard style={styles.chatSurface}>
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.messagesList}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          >
            {messages.length === 0 ? (
              <SurfaceCard style={styles.emptyState}>
                <Text style={styles.emptyTitle}>Describe the task</Text>
                <Text style={styles.emptyText}>
                  Example: send the weekly summary email tomorrow at 9 AM, or open the dashboard and export the latest report.
                </Text>
              </SurfaceCard>
            ) : null}

            {messages.map((message) => {
              const isUser = message.role === "user";
              return (
                <View key={message.id} style={[styles.messageRow, isUser ? styles.messageRowEnd : styles.messageRowStart]}>
                  <View style={[styles.messageBubble, isUser ? styles.userBubble : styles.assistantBubble]}>
                    <Text style={[styles.messageText, isUser ? styles.userText : null]}>{message.text}</Text>
                    <Text style={[styles.timestamp, isUser ? styles.userTimestamp : null]}>{message.timestamp}</Text>
                  </View>
                </View>
              );
            })}
          </ScrollView>

          <SurfaceCard style={styles.statusCard}>
            <Text style={styles.statusEyebrow}>Live execution</Text>
            <Text style={styles.statusTitle}>{activeRun ? runStateLabel(activeRun.state) : "Waiting for a run"}</Text>
            <View style={styles.chipRow}>
              {activeRun ? (
                <>
                  <StatusChip label={runStateLabel(activeRun.state)} tone={runTone(activeRun.state)} />
                  <StatusChip label={activeRun.execution_mode.replace(/_/g, " ")} tone="brand" />
                </>
              ) : null}
            </View>
            {runMeta.length > 0 ? (
              <Text style={styles.statusMeta}>{runMeta.join(" · ")}</Text>
            ) : (
              <Text style={styles.statusMeta}>The agent starts automatically once the task is fully resolved.</Text>
            )}

            {predictedPhases.length > 0 ? (
              <View style={styles.phaseList}>
                {predictedPhases.map((phase) => (
                  <View key={`${phase.phase_index}-${phase.label}`} style={styles.phaseRow}>
                    <Text style={styles.phaseLabel}>{phase.label}</Text>
                    <StatusChip label={phase.status} tone={phase.status === "completed" ? "success" : phase.status === "active" ? "brand" : phase.status === "blocked" ? "warning" : "neutral"} />
                  </View>
                ))}
              </View>
            ) : null}

            <ScrollView ref={activityRef} style={styles.activityLog} contentContainerStyle={styles.activityLogContent}>
              {activityLog.map((entry, index) => (
                <Text key={`${index}-${String(entry.label ?? entry.message ?? "log")}`} style={styles.activityLine}>
                  {String(entry.message ?? entry.label ?? entry.command ?? "Step update")}
                </Text>
              ))}
              {interruption && typeof interruption.message === "string" ? (
                <View style={styles.interruptionCard}>
                  <Text style={styles.interruptionText}>{interruption.message}</Text>
                </View>
              ) : null}
              {activityLog.length === 0 && !interruption ? (
                <Text style={styles.activityPlaceholder}>The live step log will appear here.</Text>
              ) : null}
            </ScrollView>
          </SurfaceCard>

          {schedules.length > 0 ? (
            <SurfaceCard style={styles.scheduleCard}>
              <Text style={styles.inlineTitle}>Upcoming schedules</Text>
              {schedules.slice(0, 3).map((schedule) => (
                <View key={schedule.schedule_id} style={styles.scheduleRow}>
                  <View style={styles.scheduleCopy}>
                    <Text style={styles.scheduleTitle}>{schedule.summary}</Text>
                    <Text style={styles.scheduleText}>
                      {prettyDateTime(schedule.run_times?.[0])} · {schedule.timezone}
                    </Text>
                  </View>
                  <StatusChip label="scheduled" tone="success" />
                </View>
              ))}
            </SurfaceCard>
          ) : null}

          <View style={styles.composer}>
            <TextInput
              style={styles.composerInput}
              value={input}
              onChangeText={setInput}
              placeholder="Describe the task or reply to the current interruption..."
              placeholderTextColor={mobileTheme.colors.textSoft}
              multiline
              maxLength={4000}
            />
            <View style={styles.composerFooter}>
              <Text style={styles.composerMeta}>
                {streamStatus === "live"
                  ? "Live updates connected"
                  : streamStatus === "reconnecting"
                    ? "Reconnecting live updates..."
                    : "Connecting live updates..."}
              </Text>
              <View style={styles.sendButton}>
                <PrimaryButton onPress={() => void sendMessage()} disabled={isSending || !input.trim()}>
                  {isSending ? <ActivityIndicator color={mobileTheme.colors.primaryText} /> : "Send"}
                </PrimaryButton>
              </View>
            </View>
          </View>
        </SurfaceCard>
      </KeyboardAvoidingView>
    </MobileScreen>
  );
}

const styles = StyleSheet.create({
  screen: {
    paddingTop: mobileTheme.spacing[4],
    paddingBottom: mobileTheme.spacing[2],
  },
  container: {
    flex: 1,
    gap: mobileTheme.spacing[4],
  },
  chatSurface: {
    flex: 1,
    padding: 0,
    overflow: "hidden",
  },
  messagesList: {
    gap: mobileTheme.spacing[3],
    paddingHorizontal: mobileTheme.spacing[4],
    paddingVertical: mobileTheme.spacing[4],
  },
  emptyState: {
    gap: mobileTheme.spacing[2],
  },
  emptyTitle: {
    fontSize: mobileTheme.typography.fontSize.lg,
    fontWeight: "700",
    color: mobileTheme.colors.text,
  },
  emptyText: {
    fontSize: mobileTheme.typography.fontSize.sm,
    lineHeight: 20,
    color: mobileTheme.colors.textMuted,
  },
  messageRow: {
    width: "100%",
  },
  messageRowStart: {
    alignItems: "flex-start",
  },
  messageRowEnd: {
    alignItems: "flex-end",
  },
  messageBubble: {
    maxWidth: "86%",
    borderRadius: mobileTheme.radii.md,
    padding: mobileTheme.spacing[3],
  },
  userBubble: {
    backgroundColor: mobileTheme.colors.primary,
  },
  assistantBubble: {
    backgroundColor: mobileTheme.colors.surfaceMuted,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
  },
  messageText: {
    fontSize: mobileTheme.typography.fontSize.sm,
    lineHeight: 20,
    color: mobileTheme.colors.text,
  },
  userText: {
    color: mobileTheme.colors.primaryText,
  },
  timestamp: {
    marginTop: mobileTheme.spacing[2],
    fontSize: mobileTheme.typography.fontSize.xs,
    color: mobileTheme.colors.textSoft,
  },
  userTimestamp: {
    color: "rgba(255,255,255,0.72)",
  },
  statusCard: {
    marginHorizontal: mobileTheme.spacing[4],
    marginBottom: mobileTheme.spacing[3],
    gap: mobileTheme.spacing[2],
  },
  statusEyebrow: {
    fontSize: mobileTheme.typography.fontSize.xs,
    fontWeight: "700",
    letterSpacing: 1,
    color: mobileTheme.colors.textSoft,
    textTransform: "uppercase",
  },
  statusTitle: {
    fontSize: mobileTheme.typography.fontSize.lg,
    fontWeight: "700",
    color: mobileTheme.colors.text,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: mobileTheme.spacing[2],
  },
  statusMeta: {
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.textMuted,
  },
  phaseList: {
    gap: mobileTheme.spacing[2],
  },
  phaseRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: mobileTheme.spacing[2],
  },
  phaseLabel: {
    flex: 1,
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.text,
  },
  activityLog: {
    maxHeight: 220,
    borderRadius: mobileTheme.radii.md,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    backgroundColor: mobileTheme.colors.surfaceMuted,
  },
  activityLogContent: {
    padding: mobileTheme.spacing[3],
    gap: mobileTheme.spacing[2],
    justifyContent: "flex-end",
  },
  activityLine: {
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.text,
  },
  interruptionCard: {
    borderRadius: mobileTheme.radii.md,
    padding: mobileTheme.spacing[3],
    backgroundColor: "#FFF2DB",
  },
  interruptionText: {
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.text,
  },
  activityPlaceholder: {
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.textSoft,
  },
  scheduleCard: {
    marginHorizontal: mobileTheme.spacing[4],
    marginBottom: mobileTheme.spacing[3],
    gap: mobileTheme.spacing[2],
  },
  inlineTitle: {
    fontSize: mobileTheme.typography.fontSize.lg,
    fontWeight: "700",
    color: mobileTheme.colors.text,
  },
  scheduleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: mobileTheme.spacing[2],
  },
  scheduleCopy: {
    flex: 1,
    gap: mobileTheme.spacing[1],
  },
  scheduleTitle: {
    fontSize: mobileTheme.typography.fontSize.sm,
    fontWeight: "600",
    color: mobileTheme.colors.text,
  },
  scheduleText: {
    fontSize: mobileTheme.typography.fontSize.xs,
    color: mobileTheme.colors.textMuted,
  },
  composer: {
    borderTopWidth: 1,
    borderTopColor: mobileTheme.colors.border,
    paddingHorizontal: mobileTheme.spacing[4],
    paddingVertical: mobileTheme.spacing[3],
    gap: mobileTheme.spacing[3],
  },
  composerInput: {
    minHeight: 72,
    maxHeight: 180,
    borderRadius: mobileTheme.radii.md,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    backgroundColor: mobileTheme.colors.surface,
    paddingHorizontal: mobileTheme.spacing[3],
    paddingVertical: mobileTheme.spacing[3],
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.text,
  },
  composerFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: mobileTheme.spacing[3],
  },
  composerMeta: {
    flex: 1,
    fontSize: mobileTheme.typography.fontSize.xs,
    color: mobileTheme.colors.textSoft,
  },
  sendButton: {
    minWidth: 120,
  },
  errorText: {
    color: "#B54A2F",
    fontSize: mobileTheme.typography.fontSize.sm,
  },
});
