import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

export default function SettingsScreen() {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <SettingsCard
        title="Devices"
        description="Manage your registered devices and notifications."
      />
      <SettingsCard
        title="Mesh Groups"
        description="Share tasks with family or colleagues."
      />
      <SettingsCard
        title="Account"
        description="Email, password, and sign out."
      />
      <SettingsCard
        title="About OI"
        description="Version 0.1.0"
      />
    </ScrollView>
  );
}

function SettingsCard({ title, description }: { title: string; description: string }) {
  return (
    <Pressable style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      <Text style={styles.cardDescription}>{description}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F9F5F6" },
  content: { padding: 16 },
  card: { backgroundColor: "#FFFFFF", borderRadius: 12, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: "#E0D0D4" },
  cardTitle: { fontSize: 15, fontWeight: "600", color: "#1A0A10", marginBottom: 4 },
  cardDescription: { fontSize: 13, color: "#9A8288" },
});
