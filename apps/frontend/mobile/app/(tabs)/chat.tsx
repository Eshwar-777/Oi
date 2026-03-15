import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import {
  MobileScreen,
  PrimaryButton,
  SecondaryButton,
  SectionHeader,
  StatusChip,
  SurfaceCard,
  mobileTheme,
} from "@oi/design-system-mobile";
import { chatConversationTurn, computerUseConversationTurn } from "@/lib/automation";
import type { AutomationEngine, ComposerAttachment } from "@/lib/automation";
import { useMobileAssistant } from "@/features/assistant/MobileAssistantContext";
import { AssistantStatusCard, describeNotificationContext, runStateLabel, runTone } from "@/features/assistant/ui";
import { MessageAttachmentStrip } from "@/features/chat/MessageAttachmentStrip";
import { MobileLiveModal } from "@/features/chat/MobileLiveModal";
import { useLiveMultimodal } from "@/features/chat/useLiveMultimodal";

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
  const params = useLocalSearchParams<{ conversation_id?: string }>();
  const {
    sessionId,
    selectedConversationId,
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
    selectConversation,
  } = useMobileAssistant();
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [selectedAutomationEngine, setSelectedAutomationEngine] = useState<AutomationEngine>("agent_browser");
  const [liveOpen, setLiveOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const scrollRef = useRef<ScrollView | null>(null);
  const activityRef = useRef<ScrollView | null>(null);
  const requestedConversationId = Array.isArray(params.conversation_id) ? params.conversation_id[0] : params.conversation_id;
  const sendConversationTurn = useCallback(async (
    text: string,
    nextAttachments: ComposerAttachment[] = [],
    options?: { appendUser?: boolean },
  ) => {
    const trimmed = text.trim();
    if ((!trimmed && nextAttachments.length === 0) || !selectedConversationId) {
      return null;
    }

    if (options?.appendUser !== false) {
      appendUserMessage(trimmed, { attachments: nextAttachments });
    }

    const request = {
      conversation_id: selectedConversationId,
      session_id: sessionId,
      inputs: [
        ...(trimmed ? [{ type: "text", text: trimmed } as const] : []),
        ...nextAttachments.map((attachment) => attachment.part),
      ],
      client_context: {
        timezone: currentTimezone(),
        locale: currentLocale(),
        automation_engine: selectedAutomationEngine,
      },
    };
    const response = selectedAutomationEngine === "computer_use"
      ? await computerUseConversationTurn(selectedConversationId, request)
      : await chatConversationTurn(selectedConversationId, request);
    appendAssistantMessage(response.assistant_message.text);
    await hydrateRemoteState();
    return response;
  }, [appendAssistantMessage, appendUserMessage, hydrateRemoteState, selectedAutomationEngine, selectedConversationId, sessionId]);

  const live = useLiveMultimodal({
    automationEngine: selectedAutomationEngine,
    onVoiceTurn: async (spokenText) => {
      const response = await sendConversationTurn(spokenText, []);
      return { assistantText: response?.assistant_message.text || "" };
    },
  });

  useEffect(() => {
    if (!requestedConversationId || requestedConversationId === selectedConversationId) return;
    void selectConversation(requestedConversationId).catch(() => undefined);
  }, [requestedConversationId, selectConversation, selectedConversationId]);

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
    if ((!text && attachments.length === 0) || isSending) return;

    setIsSending(true);
    setErrorMessage("");
    setInput("");
    setAttachments([]);

    try {
      if (!selectedConversationId) {
        throw new Error("No conversation selected.");
      }
      await sendConversationTurn(text, attachments);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to send message");
    } finally {
      setIsSending(false);
    }
  }, [attachments, input, isSending, selectedConversationId, sendConversationTurn]);

  const addCameraCapture = useCallback((payload: { dataUrl: string; label: string }) => {
    setAttachments((current) => [
      ...current,
      {
        id: `camera-${Date.now()}`,
        label: payload.label,
        part: {
          type: "image",
          file_id: payload.dataUrl,
          caption: payload.label,
        },
      },
    ]);
  }, []);

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

        <View style={styles.engineRow}>
          <Pressable
            onPress={() => setSelectedAutomationEngine("agent_browser")}
            style={[styles.engineChip, selectedAutomationEngine === "agent_browser" ? styles.engineChipActive : null]}
          >
            <Text style={[styles.engineChipText, selectedAutomationEngine === "agent_browser" ? styles.engineChipTextActive : null]}>
              Playwright MCP
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setSelectedAutomationEngine("computer_use")}
            style={[styles.engineChip, selectedAutomationEngine === "computer_use" ? styles.engineChipActive : null]}
          >
            <Text style={[styles.engineChipText, selectedAutomationEngine === "computer_use" ? styles.engineChipTextActive : null]}>
              Computer Use
            </Text>
          </Pressable>
        </View>

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
                    {message.text ? (
                      <Text style={[styles.messageText, isUser ? styles.userText : null]}>{message.text}</Text>
                    ) : null}
                    <MessageAttachmentStrip
                      attachments={(message.attachments ?? []).map((attachment) => ({
                        type: attachment.part.type,
                        preview_url: attachment.part.file_id,
                        caption: attachment.part.type === "image" ? attachment.part.caption : undefined,
                        name: attachment.label,
                      }))}
                    />
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

          <MobileLiveModal
            open={liveOpen}
            onClose={() => setLiveOpen(false)}
            live={live}
            onAddImage={() => setLiveOpen(false)}
            onCapture={addCameraCapture}
          />

          <View style={styles.composer}>
            {attachments.length > 0 ? (
              <View style={styles.attachmentPreviewRow}>
                {attachments.map((attachment) => (
                  <View key={attachment.id} style={styles.attachmentPreviewCard}>
                    {attachment.part.type === "image" ? (
                      <Image source={{ uri: attachment.part.file_id }} style={styles.attachmentPreviewImage} />
                    ) : null}
                    <Text style={styles.attachmentPreviewLabel}>{attachment.label}</Text>
                  </View>
                ))}
              </View>
            ) : null}
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
              <View style={styles.composerActions}>
                <View style={styles.sendButton}>
                  <PrimaryButton onPress={() => void sendMessage()} disabled={isSending || (!input.trim() && attachments.length === 0)}>
                    {isSending ? <ActivityIndicator color={mobileTheme.colors.primaryText} /> : "Send"}
                  </PrimaryButton>
                </View>
              </View>
            </View>
          </View>
        </SurfaceCard>

        <Pressable
          style={styles.liveTrigger}
          onPress={() => setLiveOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Open live"
        >
          <View style={styles.liveTriggerOrb} />
        </Pressable>
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
  engineRow: {
    flexDirection: "row",
    gap: mobileTheme.spacing[2],
  },
  engineChip: {
    paddingHorizontal: mobileTheme.spacing[3],
    paddingVertical: mobileTheme.spacing[2],
    borderRadius: mobileTheme.radii.full,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    backgroundColor: mobileTheme.colors.surface,
  },
  engineChipActive: {
    borderColor: mobileTheme.colors.primary,
    backgroundColor: "rgba(99,102,241,0.12)",
  },
  engineChipText: {
    color: mobileTheme.colors.textMuted,
    fontSize: mobileTheme.typography.fontSize.sm,
    fontWeight: "600",
  },
  engineChipTextActive: {
    color: mobileTheme.colors.text,
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
  attachmentPreviewRow: {
    flexDirection: "row",
    gap: mobileTheme.spacing[2],
    flexWrap: "wrap",
  },
  attachmentPreviewCard: {
    width: 100,
    gap: mobileTheme.spacing[1],
  },
  attachmentPreviewImage: {
    width: 100,
    height: 100,
    borderRadius: mobileTheme.radii.md,
    backgroundColor: mobileTheme.colors.surfaceMuted,
  },
  attachmentPreviewLabel: {
    fontSize: mobileTheme.typography.fontSize.xs,
    color: mobileTheme.colors.textSoft,
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
    gap: mobileTheme.spacing[3],
  },
  composerMeta: {
    flex: 1,
    fontSize: mobileTheme.typography.fontSize.xs,
    color: mobileTheme.colors.textSoft,
  },
  composerActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: mobileTheme.spacing[3],
  },
  sendButton: {
    minWidth: 120,
  },
  liveTrigger: {
    position: "absolute",
    right: mobileTheme.spacing[4],
    bottom: mobileTheme.spacing[4],
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(15,23,42,0.08)",
    backgroundColor: "rgba(255,255,255,0.94)",
    shadowColor: "#111827",
    shadowOpacity: 0.16,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  liveTriggerOrb: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#D8E8FF",
    shadowColor: "#60A5FA",
    shadowOpacity: 0.32,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    borderWidth: 1,
    borderColor: "rgba(191,219,254,0.9)",
  },
  errorText: {
    color: "#B54A2F",
    fontSize: mobileTheme.typography.fontSize.sm,
  },
});
