import { useCallback, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  MobileScreen,
  PrimaryButton,
  SectionHeader,
  SurfaceCard,
  mobileTheme,
} from "@oi/design-system-mobile";

import { fetchWithTimeout, getApiBaseUrl } from "@/lib/api";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export default function ChatScreen() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const listRef = useRef<FlatList>(null);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((current) => [...current, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      const apiUrl = getApiBaseUrl();
      const response = await fetchWithTimeout(`${apiUrl}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: "mobile-user",
          session_id: "mobile-session",
          message: text,
        }),
      });
      const data = await response.json();

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: data.response || "No response.",
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setMessages((current) => [...current, assistantMessage]);
    } catch {
      setMessages((current) => [
        ...current,
        {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: "Connection error. Check that the backend is running.",
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading]);

  const renderMessage = useCallback(({ item }: { item: Message }) => {
    const isUser = item.role === "user";
    return (
      <View style={[styles.messageRow, isUser ? styles.messageRowEnd : styles.messageRowStart]}>
        <View style={[styles.messageBubble, isUser ? styles.userBubble : styles.assistantBubble]}>
          <Text style={[styles.messageText, isUser && styles.userText]}>{item.content}</Text>
          <Text style={[styles.timestamp, isUser && styles.userTimestamp]}>{item.timestamp}</Text>
        </View>
      </View>
    );
  }, []);

  return (
    <MobileScreen style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={90}
      >
        <SectionHeader
          eyebrow="Conversation"
          title="Chat"
          description="Shared mobile tokens now drive the transcript, composer, and response states."
        />

        <SurfaceCard style={styles.chatSurface}>
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => item.id}
            renderItem={renderMessage}
            contentContainerStyle={styles.messagesList}
            onContentSizeChange={() => listRef.current?.scrollToEnd()}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>OI</Text>
                <Text style={styles.emptyText}>
                  Start chatting. Describe a task to automate or ask for an update.
                </Text>
              </View>
            }
          />

          {isLoading ? (
            <Text style={styles.loadingText}>OI is thinking...</Text>
          ) : null}

          <View style={styles.composer}>
            <TextInput
              style={styles.input}
              value={input}
              onChangeText={setInput}
              placeholder="Type your message..."
              placeholderTextColor={mobileTheme.colors.textSoft}
              multiline
              maxLength={2000}
              onSubmitEditing={sendMessage}
              blurOnSubmit={false}
            />
            <View style={styles.sendButton}>
              <PrimaryButton onPress={() => void sendMessage()} disabled={isLoading || !input.trim()}>
                Send
              </PrimaryButton>
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
    paddingHorizontal: mobileTheme.spacing[4],
    paddingVertical: mobileTheme.spacing[4],
    gap: mobileTheme.spacing[2],
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
    maxWidth: "82%",
    borderRadius: mobileTheme.radii.md,
    padding: mobileTheme.spacing[3],
  },
  userBubble: {
    backgroundColor: mobileTheme.colors.primary,
  },
  assistantBubble: {
    backgroundColor: mobileTheme.colors.surface,
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
  emptyState: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingTop: 120,
    paddingHorizontal: mobileTheme.spacing[4],
  },
  emptyTitle: {
    fontSize: 32,
    fontWeight: "700",
    color: mobileTheme.colors.primary,
    marginBottom: mobileTheme.spacing[2],
  },
  emptyText: {
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.textMuted,
    textAlign: "center",
    maxWidth: 260,
  },
  loadingText: {
    paddingHorizontal: mobileTheme.spacing[4],
    paddingBottom: mobileTheme.spacing[2],
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.textMuted,
  },
  composer: {
    padding: mobileTheme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: mobileTheme.colors.border,
    backgroundColor: mobileTheme.colors.surface,
    gap: mobileTheme.spacing[3],
  },
  input: {
    minHeight: 54,
    maxHeight: 120,
    borderRadius: mobileTheme.radii.sm,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    backgroundColor: mobileTheme.colors.surfaceMuted,
    paddingHorizontal: mobileTheme.spacing[4],
    paddingVertical: mobileTheme.spacing[3],
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.text,
  },
  sendButton: {
    alignSelf: "stretch",
  },
});
