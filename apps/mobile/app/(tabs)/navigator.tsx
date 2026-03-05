import { View, Text, StyleSheet } from "react-native";

const MAROON = "#751636";

export default function NavigatorScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.icon}>🧭</Text>
      <Text style={styles.title}>Navigator</Text>
      <Text style={styles.subtitle}>
        Browser automation is available on the desktop and web app. Open OI on
        your computer to control browser tabs with natural language.
      </Text>
      <View style={styles.featureList}>
        <Text style={styles.feature}>• Attach multiple tabs to the OI group</Text>
        <Text style={styles.feature}>• Switch between tabs from the Navigator</Text>
        <Text style={styles.feature}>• Track each step: waiting, processing, success, error</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
    backgroundColor: "#FFFFFF",
  },
  icon: {
    fontSize: 48,
    marginBottom: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: MAROON,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: "#6B5C61",
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 20,
  },
  featureList: {
    alignSelf: "stretch",
    paddingHorizontal: 16,
  },
  feature: {
    fontSize: 14,
    color: "#6B5C61",
    lineHeight: 24,
  },
});
