import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function LoginScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.brand}>OI</Text>
        <Text style={styles.subtitle}>Sign in to your account</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor="#9A8288"
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#9A8288"
          secureTextEntry
        />

        <Pressable style={styles.button}>
          <Text style={styles.buttonText}>Sign In</Text>
        </Pressable>

        <Pressable style={styles.linkButton}>
          <Text style={styles.linkText}>Don&apos;t have an account? Sign Up</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF" },
  content: { flex: 1, justifyContent: "center", paddingHorizontal: 24 },
  brand: { fontSize: 36, fontWeight: "700", color: "#751636", textAlign: "center", marginBottom: 8 },
  subtitle: { fontSize: 15, color: "#9A8288", textAlign: "center", marginBottom: 32 },
  input: { backgroundColor: "#F9F5F6", borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14, fontSize: 15, color: "#1A0A10", marginBottom: 12, borderWidth: 1, borderColor: "#E0D0D4" },
  button: { backgroundColor: "#751636", borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 8 },
  buttonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
  linkButton: { marginTop: 16, alignItems: "center" },
  linkText: { fontSize: 13, color: "#751636" },
});
