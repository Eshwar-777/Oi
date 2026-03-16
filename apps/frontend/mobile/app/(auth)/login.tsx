import { useMemo, useState } from "react";
import { Redirect } from "expo-router";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import {
  MobileScreen,
  PrimaryButton,
  SecondaryButton,
  SectionHeader,
  SurfaceCard,
  useMobileTheme,
} from "@oi/design-system-mobile";
import { useMobileAuth } from "@/features/auth/AuthContext";
import { fetchWithTimeout, getApiBaseUrl } from "@/lib/api";

function parseAuthHandoff(raw: string): { handoffId: string; code: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("oi://auth?")) {
    try {
      const url = new URL(trimmed.replace("oi://", "https://"));
      const handoffId = url.searchParams.get("handoff_id")?.trim() ?? "";
      const code = url.searchParams.get("code")?.trim() ?? "";
      if (handoffId && code) {
        return { handoffId, code };
      }
    } catch {
      return null;
    }
  }
  const [handoffId, code] = trimmed.split(/\s+/);
  if (!handoffId || !code) return null;
  return { handoffId, code: code.toUpperCase() };
}

async function redeemQrHandoff(handoffId: string, code: string): Promise<string> {
  const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/auth/qr-handoff/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handoff_id: handoffId, code }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body?.detail === "string" ? body.detail : "Failed to redeem QR sign-in");
  }
  const customToken = String(body.custom_token ?? "");
  if (!customToken) {
    throw new Error("QR handoff did not return a custom token.");
  }
  return customToken;
}

export default function LoginScreen() {
  const theme = useMobileTheme();
  const styles = useMemo(() => getLoginStyles(theme), [theme]);
  const { authAvailable, signIn, signInWithCustomToken, status } = useMobileAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [handoffInput, setHandoffInput] = useState("");
  const [handoffId, setHandoffId] = useState("");
  const [handoffCode, setHandoffCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [redeemingQr, setRedeemingQr] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  if (status === "authenticated") {
    return <Redirect href="/(tabs)/chat" />;
  }

  async function onSubmit() {
    setSubmitting(true);
    setErrorMessage("");
    try {
      await signIn(email.trim(), password);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to sign in");
    } finally {
      setSubmitting(false);
    }
  }

  async function onRedeemQr() {
    setRedeemingQr(true);
    setErrorMessage("");
    try {
      const customToken = await redeemQrHandoff(handoffId.trim(), handoffCode.trim().toUpperCase());
      await signInWithCustomToken(customToken);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to sign in with QR");
    } finally {
      setRedeemingQr(false);
    }
  }

  async function onOpenScanner() {
    if (!permission?.granted) {
      const next = await requestPermission();
      if (!next.granted) {
        setErrorMessage("Camera permission is required to scan the mobile sign-in QR.");
        return;
      }
    }
    setScannerOpen(true);
  }

  return (
    <MobileScreen scrollable contentContainerStyle={styles.content}>
      <View style={styles.container}>
        <SectionHeader
          eyebrow="Mobile"
          title="Welcome back"
          description="The mobile client now shares tokens and design primitives with the rest of the frontend stack."
        />

        <SurfaceCard style={styles.card}>
          <Text style={styles.sectionTitle}>Email and password</Text>
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            placeholder="Email"
            placeholderTextColor={theme.colors.textSoft}
            keyboardType="email-address"
            autoCapitalize="none"
          />

          <Text style={[styles.label, styles.labelGap]}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={theme.colors.textSoft}
            secureTextEntry
          />

          {!authAvailable ? (
            <Text style={styles.errorText}>
              Firebase mobile auth is not configured for this build. Add the Firebase mobile config or enable `EXPO_PUBLIC_BYPASS_MOBILE_AUTH=true` for local dev.
            </Text>
          ) : null}
          {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

          <View style={styles.buttonGap}>
            <PrimaryButton
              onPress={() => void onSubmit()}
              loading={submitting}
              disabled={!authAvailable || !email.trim() || !password}
            >
              Sign in
            </PrimaryButton>
          </View>

          <SecondaryButton disabled>Sign up coming soon</SecondaryButton>
        </SurfaceCard>

        <SurfaceCard style={styles.card}>
          <Text style={styles.sectionTitle}>QR or handoff code</Text>
          <Text style={styles.helperText}>
            Generate a one-time mobile sign-in QR from the web settings screen, then scan it here or paste the payload.
          </Text>
          <TextInput
            style={styles.input}
            value={handoffInput}
            onChangeText={setHandoffInput}
            placeholder="Paste oi://auth?... or '<handoff_id> <code>'"
            placeholderTextColor={theme.colors.textSoft}
            autoCapitalize="none"
          />

          <View style={styles.row}>
            <View style={styles.halfButton}>
              <SecondaryButton
                onPress={() => {
                  const parsed = parseAuthHandoff(handoffInput);
                  if (!parsed) {
                    setErrorMessage("Could not parse the QR handoff payload.");
                    return;
                  }
                  setHandoffId(parsed.handoffId);
                  setHandoffCode(parsed.code);
                  setErrorMessage("");
                }}
              >
                Parse code
              </SecondaryButton>
            </View>
            <View style={styles.halfButton}>
              <SecondaryButton onPress={() => void onOpenScanner()}>Scan QR</SecondaryButton>
            </View>
          </View>

          {scannerOpen ? (
            <View style={styles.scannerWrap}>
              <CameraView
                style={styles.scanner}
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={(event) => {
                  const parsed = parseAuthHandoff(String(event.data || ""));
                  if (!parsed) {
                    setErrorMessage("Scanned QR is not a valid auth handoff.");
                    return;
                  }
                  setHandoffId(parsed.handoffId);
                  setHandoffCode(parsed.code);
                  setScannerOpen(false);
                  setErrorMessage("");
                }}
              />
              <SecondaryButton onPress={() => setScannerOpen(false)}>Close scanner</SecondaryButton>
            </View>
          ) : null}

          <TextInput
            style={styles.input}
            value={handoffId}
            onChangeText={setHandoffId}
            placeholder="Handoff ID"
            placeholderTextColor={theme.colors.textSoft}
            autoCapitalize="none"
          />
          <TextInput
            style={styles.input}
            value={handoffCode}
            onChangeText={(value) => setHandoffCode(value.toUpperCase())}
            placeholder="Handoff code"
            placeholderTextColor={theme.colors.textSoft}
            autoCapitalize="characters"
          />

          <PrimaryButton
            onPress={() => void onRedeemQr()}
            loading={redeemingQr}
            disabled={!authAvailable || !handoffId.trim() || !handoffCode.trim()}
          >
            Sign in with QR
          </PrimaryButton>
        </SurfaceCard>
      </View>
    </MobileScreen>
  );
}

function getLoginStyles(theme: ReturnType<typeof useMobileTheme>) {
  return StyleSheet.create({
    content: { paddingBottom: theme.spacing[6] },
    container: { flex: 1, justifyContent: "center", gap: theme.spacing[5] },
    card: { gap: theme.spacing[2] },
    label: {
      fontSize: theme.typography.fontSize.xs,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 1,
      color: theme.colors.textSoft,
    },
    labelGap: { marginTop: theme.spacing[2] },
    input: {
      minHeight: 48,
      borderRadius: theme.radii.sm,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surfaceMuted,
      paddingHorizontal: theme.spacing[4],
      fontSize: theme.typography.fontSize.sm,
      color: theme.colors.text,
    },
    buttonGap: { marginTop: theme.spacing[3] },
    sectionTitle: { fontSize: theme.typography.fontSize.lg, fontWeight: "700", color: theme.colors.text },
    helperText: { fontSize: theme.typography.fontSize.sm, color: theme.colors.textMuted },
    errorText: { fontSize: theme.typography.fontSize.sm, color: theme.colors.error },
    row: { flexDirection: "row", gap: theme.spacing[2] },
    halfButton: { flex: 1 },
    scannerWrap: { gap: theme.spacing[3] },
    scanner: { width: "100%", height: 260, borderRadius: theme.radii.md, overflow: "hidden" },
  });
}
