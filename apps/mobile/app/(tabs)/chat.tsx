import { useCallback, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { getApiBaseUrl } from "@/lib/api";

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

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      const apiUrl = getApiBaseUrl();
      const response = await fetch(`${apiUrl}/chat`, {
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
      setMessages((prev) => [...prev, assistantMessage]);
    } catch {
      setMessages((prev) => [
        ...prev,
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
      <View style={[styles.messageBubble, isUser ? styles.userBubble : styles.assistantBubble]}>
        <Text style={[styles.messageText, isUser && styles.userText]}>{item.content}</Text>
        <Text style={[styles.timestamp, isUser && styles.userTimestamp]}>{item.timestamp}</Text>
      </View>
    );
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={["bottom"]}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={90}
      >
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
                Start chatting. Describe tasks to automate or ask anything.
              </Text>
            </View>
          }
        />

        {isLoading && (
          <View style={styles.loadingBar}>
            <Text style={styles.loadingText}>OI is thinking...</Text>
          </View>
        )}

        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="Type your message..."
            placeholderTextColor="#9A8288"
            multiline
            maxLength={2000}
            onSubmitEditing={sendMessage}
            blurOnSubmit={false}
          />
          <Pressable
            onPress={sendMessage}
            disabled={isLoading || !input.trim()}
            style={[styles.sendButton, (!input.trim() || isLoading) && styles.sendButtonDisabled]}
          >
            <Text style={styles.sendButtonText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9F5F6" },
  messagesList: { paddingHorizontal: 16, paddingVertical: 12 },
  messageBubble: { maxWidth: "78%", borderRadius: 16, padding: 12, marginBottom: 8 },
  userBubble: { alignSelf: "flex-end", backgroundColor: "#751636" },
  assistantBubble: { alignSelf: "flex-start", backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#E0D0D4" },
  messageText: { fontSize: 14, lineHeight: 20, color: "#1A0A10" },
  userText: { color: "#FFFFFF" },
  timestamp: { fontSize: 11, color: "#9A8288", marginTop: 4 },
  userTimestamp: { color: "#E08DA5" },
  emptyState: { flex: 1, justifyContent: "center", alignItems: "center", paddingTop: 120 },
  emptyTitle: { fontSize: 32, fontWeight: "700", color: "#9C2E50", marginBottom: 8 },
  emptyText: { fontSize: 14, color: "#9A8288", textAlign: "center", maxWidth: 260 },
  loadingBar: { paddingHorizontal: 16, paddingVertical: 6 },
  loadingText: { fontSize: 13, color: "#9A8288" },
  composer: { flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#E0D0D4", backgroundColor: "#FFFFFF" },
  input: { flex: 1, backgroundColor: "#F9F5F6", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, color: "#1A0A10", maxHeight: 100, borderWidth: 1, borderColor: "#E0D0D4" },
  sendButton: { marginLeft: 10, backgroundColor: "#751636", paddingHorizontal: 18, paddingVertical: 10, borderRadius: 12 },
  sendButtonDisabled: { opacity: 0.4 },
  sendButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "600" },
});
