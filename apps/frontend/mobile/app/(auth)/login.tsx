import { Redirect } from "expo-router";
import { StyleSheet, Text, TextInput, View } from "react-native";
import {
  MobileScreen,
  PrimaryButton,
  SectionHeader,
  SurfaceCard,
  mobileTheme,
} from "@oi/design-system-mobile";
import { isMobileAuthBypassEnabled } from "@/lib/devFlags";

export default function LoginScreen() {
  if (isMobileAuthBypassEnabled()) {
    return <Redirect href="/(tabs)/navigator" />;
  }

  return (
    <MobileScreen>
      <View style={styles.container}>
        <SectionHeader
          eyebrow="Mobile"
          title="Welcome back"
          description="The mobile client now shares tokens and design primitives with the rest of the frontend stack."
        />

        <SurfaceCard style={styles.card}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor={mobileTheme.colors.textSoft}
            keyboardType="email-address"
            autoCapitalize="none"
          />

          <Text style={[styles.label, styles.labelGap]}>Password</Text>
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor={mobileTheme.colors.textSoft}
            secureTextEntry
          />

          <View style={styles.buttonGap}>
            <PrimaryButton>Sign in</PrimaryButton>
          </View>

          <Text style={styles.link}>Do not have an account? Sign up</Text>
        </SurfaceCard>
      </View>
    </MobileScreen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    gap: mobileTheme.spacing[5],
  },
  card: {
    gap: mobileTheme.spacing[2],
  },
  label: {
    fontSize: mobileTheme.typography.fontSize.xs,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    color: mobileTheme.colors.textSoft,
  },
  labelGap: {
    marginTop: mobileTheme.spacing[2],
  },
  input: {
    minHeight: 48,
    borderRadius: mobileTheme.radii.sm,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    backgroundColor: mobileTheme.colors.surfaceMuted,
    paddingHorizontal: mobileTheme.spacing[4],
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.text,
  },
  buttonGap: {
    marginTop: mobileTheme.spacing[3],
  },
  link: {
    marginTop: mobileTheme.spacing[3],
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.primary,
    fontWeight: "600",
    textAlign: "center",
  },
});
