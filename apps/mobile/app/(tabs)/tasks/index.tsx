import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";

export default function TasksScreen() {
  return (
    <View style={styles.container}>
      <View style={styles.emptyState}>
        <Text style={styles.emptyIcon}>📋</Text>
        <Text style={styles.emptyTitle}>No tasks yet</Text>
        <Text style={styles.emptyText}>
          Go to Chat and describe something you want automated. OI will plan it and you can
          track progress here.
        </Text>
        <Pressable
          style={styles.ctaButton}
          onPress={() => router.push("/(tabs)/chat")}
        >
          <Text style={styles.ctaButtonText}>Start a Chat</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9F5F6" },
  emptyState: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { fontSize: 16, fontWeight: "600", color: "#1A0A10", marginBottom: 8 },
  emptyText: { fontSize: 14, color: "#9A8288", textAlign: "center", maxWidth: 280, marginBottom: 20, lineHeight: 20 },
  ctaButton: { backgroundColor: "#751636", paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12 },
  ctaButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "600" },
});
