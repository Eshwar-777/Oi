import { useCallback, useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  Switch,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Notifications from "expo-notifications";
import { useFocusEffect, useRouter } from "expo-router";
import {
  MobileScreen,
  PrimaryButton,
  SecondaryButton,
  SectionHeader,
  StatusChip,
  SurfaceCard,
  useMobileTheme,
} from "@oi/design-system-mobile";

import { fetchWithTimeout, getApiBaseUrl, getPairingTimeoutMs } from "@/lib/api";
import { getAuthHeaders } from "@/lib/authHeaders";
import { parsePairingInput } from "@/lib/devicePairing";
import { useMobileAuth } from "@/features/auth/AuthContext";
import { createAuthQrHandoff, type NotificationPreferences } from "@/lib/automation";
import { isExpoGo } from "@/lib/devFlags";

type DeviceType = "mobile" | "desktop" | "web";

interface RegisteredDevice {
  device_id: string;
  device_type: string;
  device_name: string;
  is_online?: boolean;
  connected?: boolean;
  last_seen?: string;
}

interface RedeemPairingResponse {
  ok: boolean;
  device_id?: string;
  device_name?: string;
  device_type?: string;
  linked_at?: string;
}

type NotificationUrgencyMode = "all" | "important_only" | "none";

const NOTIFICATION_URGENCY_OPTIONS: Array<{
  label: string;
  value: NotificationUrgencyMode;
}> = [
  { label: "All alerts", value: "all" },
  { label: "Important only", value: "important_only" },
  { label: "None", value: "none" },
];

async function listDevices(): Promise<RegisteredDevice[]> {
  const api = getApiBaseUrl();
  const res = await fetchWithTimeout(`${api}/devices`, {
    headers: await getAuthHeaders(),
  });
  const body = await res.json().catch(() => []);
  if (!res.ok) {
    throw new Error(typeof body?.detail === "string" ? body.detail : "Failed to fetch devices");
  }
  return Array.isArray(body) ? body : [];
}

async function redeemPairing(payload: {
  pairing_id: string;
  code: string;
  device_type: DeviceType;
  device_name: string;
  device_id?: string;
  fcm_token?: string;
}): Promise<RedeemPairingResponse> {
  const api = getApiBaseUrl();
  const res = await fetchWithTimeout(
    `${api}/devices/pairing/redeem`,
    {
      method: "POST",
      headers: await getAuthHeaders(),
      body: JSON.stringify(payload),
    },
    getPairingTimeoutMs(),
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof body?.detail === "string" ? body.detail : "Failed to link device");
  }
  return body as RedeemPairingResponse;
}

async function updateDeviceRegistration(
  deviceId: string,
  payload: {
    device_name?: string;
    fcm_token?: string;
    is_online?: boolean;
  },
): Promise<void> {
  const api = getApiBaseUrl();
  const res = await fetchWithTimeout(`${api}/devices/${encodeURIComponent(deviceId)}`, {
    method: "PATCH",
    headers: await getAuthHeaders(),
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof body?.detail === "string" ? body.detail : "Failed to update device");
  }
}

async function getNotificationPreferences(): Promise<NotificationPreferences> {
  const api = getApiBaseUrl();
  const res = await fetchWithTimeout(`${api}/api/notification-preferences`, {
    headers: await getAuthHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof body?.detail === "string" ? body.detail : "Failed to load notification preferences");
  }
  return (body.preferences ?? body) as NotificationPreferences;
}

async function updateNotificationPreferences(
  payload: Omit<NotificationPreferences, "user_id" | "updated_at">,
): Promise<NotificationPreferences> {
  const api = getApiBaseUrl();
  const res = await fetchWithTimeout(`${api}/api/notification-preferences`, {
    method: "PUT",
    headers: await getAuthHeaders(),
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof body?.detail === "string" ? body.detail : "Failed to update notification preferences");
  }
  return (body.preferences ?? body) as NotificationPreferences;
}

async function getNativePushToken(): Promise<string | null> {
  if (isExpoGo()) {
    return null;
  }

  const permission = await Notifications.getPermissionsAsync();
  let finalStatus = permission.status;
  if (finalStatus !== "granted") {
    const request = await Notifications.requestPermissionsAsync();
    finalStatus = request.status;
  }
  if (finalStatus !== "granted") {
    throw new Error("Notification permission is required to receive automation alerts.");
  }

  try {
    const messagingModule = await import("@react-native-firebase/messaging");
    const messagingFactory = messagingModule.default;
    if (typeof messagingFactory === "function") {
      const messaging = messagingFactory();
      await messaging.registerDeviceForRemoteMessages();
      const token = await messaging.getToken();
      if (token) return token;
    }
  } catch {
    // Fall through to expo-notifications native device token.
  }

  const deviceToken = await Notifications.getDevicePushTokenAsync();
  const token = typeof deviceToken.data === "string" ? deviceToken.data : String(deviceToken.data || "");
  return token || null;
}

function formatRedeemError(err: unknown): string {
  if (err instanceof Error) {
    const message = err.message || "";
    if (message.toLowerCase().includes("timed out")) {
      return `${message}. Check mobile API reachability to ${getApiBaseUrl()} and verify the backend is running.`;
    }
    if (message.toLowerCase().includes("network request failed")) {
      return `Network request failed. Mobile cannot reach backend at ${getApiBaseUrl()}.`;
    }
    return message;
  }
  return "Failed to link device";
}

function pretty(value?: string): string {
  if (!value) return "Never";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

export default function SettingsScreen() {
  const theme = useMobileTheme();
  const styles = useMemo(() => getSettingsStyles(theme), [theme]);
  const router = useRouter();
  const { signOut, user } = useMobileAuth();
  const expoGo = isExpoGo();
  const [devices, setDevices] = useState<RegisteredDevice[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  const [pairingInput, setPairingInput] = useState("");
  const [pairingId, setPairingId] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [deviceType, setDeviceType] = useState<DeviceType>("mobile");
  const [deviceName, setDeviceName] = useState("My Phone");
  const [deviceId, setDeviceId] = useState("");
  const [fcmToken, setFcmToken] = useState("");
  const [resolvingPushToken, setResolvingPushToken] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferences | null>(null);
  const [savingPreferences, setSavingPreferences] = useState(false);

  const [scannerOpen, setScannerOpen] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [creatingAuthQr, setCreatingAuthQr] = useState(false);
  const [authQrPayload, setAuthQrPayload] = useState("");
  const [authQrCode, setAuthQrCode] = useState("");
  const [authQrExpiry, setAuthQrExpiry] = useState("");
  const userEmail = user?.email || "Authenticated user";
  const userUid = user?.uid || "Unknown";
  const initials = (userEmail[0] || "O").slice(0, 1).toUpperCase();

  const loadDevices = useCallback(async () => {
    setLoadingDevices(true);
    setErrorMessage("");
    try {
      const rows = await listDevices();
      setDevices(rows);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to fetch devices");
    } finally {
      setLoadingDevices(false);
    }
  }, []);

  const loadNotificationPreferences = useCallback(async () => {
    try {
      const prefs = await getNotificationPreferences();
      setNotificationPreferences(prefs);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to load notification preferences");
    }
  }, []);

  const resolvePushToken = useCallback(async () => {
    if (expoGo) {
      setErrorMessage("Native push registration is unavailable in Expo Go. Use a development build so this phone can register its FCM or APNs token directly.");
      return null;
    }
    setResolvingPushToken(true);
    setErrorMessage("");
    try {
      const token = await getNativePushToken();
      if (!token) {
        setErrorMessage("Could not resolve a device push token on this device.");
        return null;
      }
      setFcmToken(token);
      if (deviceId.trim()) {
        await updateDeviceRegistration(deviceId.trim(), {
          fcm_token: token,
          is_online: true,
        });
        setSuccessMessage("Push token updated for this device.");
        await loadDevices();
      }
      return token;
    } catch (err) {
      setErrorMessage(formatRedeemError(err));
      return null;
    } finally {
      setResolvingPushToken(false);
    }
  }, [deviceId, expoGo, loadDevices]);

  useFocusEffect(
    useCallback(() => {
      void loadDevices();
      void loadNotificationPreferences();
      if (!expoGo && !fcmToken.trim()) {
        void resolvePushToken();
      }
    }, [expoGo, fcmToken, loadDevices, loadNotificationPreferences, resolvePushToken]),
  );

  const linkedCount = useMemo(() => devices.length, [devices.length]);

  const applyParsedPairing = useCallback((raw: string) => {
    const parsed = parsePairingInput(raw);
    if (!parsed) return false;
    setPairingId(parsed.pairingId);
    setPairingCode(parsed.code);
    return true;
  }, []);

  const onRedeem = useCallback(async () => {
    setErrorMessage("");
    setSuccessMessage("");

    if (!pairingId.trim() || !pairingCode.trim() || !deviceName.trim()) {
      setErrorMessage("Pairing ID, code, and device name are required.");
      return;
    }

    setRedeeming(true);
    try {
      const token = fcmToken.trim() || (await resolvePushToken()) || undefined;
      const result = await redeemPairing({
        pairing_id: pairingId.trim(),
        code: pairingCode.trim().toUpperCase(),
        device_type: deviceType,
        device_name: deviceName.trim(),
        device_id: deviceId.trim() || undefined,
        fcm_token: token,
      });
      if (result.device_id) {
        setDeviceId(result.device_id);
      }
      setSuccessMessage("Device linked successfully.");
      await loadDevices();
    } catch (err) {
      setErrorMessage(formatRedeemError(err));
    } finally {
      setRedeeming(false);
    }
  }, [deviceId, deviceName, deviceType, fcmToken, loadDevices, pairingCode, pairingId, resolvePushToken]);

  const onOpenScanner = useCallback(async () => {
    if (!permission?.granted) {
      const next = await requestPermission();
      if (!next.granted) {
        setErrorMessage("Camera permission is required to scan QR.");
        return;
      }
    }
    setScannerOpen(true);
  }, [permission?.granted, requestPermission]);

  const saveNotificationPreferencePatch = useCallback(
    async (patch: Partial<Omit<NotificationPreferences, "user_id" | "updated_at">>) => {
      if (!notificationPreferences) return;
      setSavingPreferences(true);
      setErrorMessage("");
      try {
        const next = {
          desktop_enabled: notificationPreferences.desktop_enabled,
          browser_enabled: notificationPreferences.browser_enabled,
          mobile_push_enabled: notificationPreferences.mobile_push_enabled,
          connected_device_only_for_noncritical: notificationPreferences.connected_device_only_for_noncritical,
          urgency_mode: notificationPreferences.urgency_mode,
          ...patch,
        };
        const updated = await updateNotificationPreferences(next);
        setNotificationPreferences(updated);
        setSuccessMessage("Notification preferences updated.");
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "Failed to update notification preferences");
      } finally {
        setSavingPreferences(false);
      }
    },
    [notificationPreferences],
  );

  const generateAuthQr = useCallback(async () => {
    setCreatingAuthQr(true);
    setErrorMessage("");
    setSuccessMessage("");
    try {
      const handoff = await createAuthQrHandoff();
      setAuthQrPayload(handoff.qr_payload);
      setAuthQrCode(handoff.code);
      setAuthQrExpiry(pretty(handoff.expires_at));
      setSuccessMessage("Mobile sign-in handoff generated.");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to generate mobile sign-in handoff");
    } finally {
      setCreatingAuthQr(false);
    }
  }, []);

  return (
    <MobileScreen scrollable contentContainerStyle={styles.content}>
      <SectionHeader
        eyebrow="Settings"
        title="System controls"
        description="Manage mobile sign-in, linked devices, alert routing, and the main operational surfaces from one place."
      />

      <SurfaceCard>
        <View style={styles.userRow}>
          <View style={styles.userAvatar}>
            <Text style={styles.userAvatarText}>{initials}</Text>
          </View>
          <View style={styles.userCopy}>
            <Text style={styles.cardTitle}>User details</Text>
            <Text style={styles.deviceSub}>{userEmail}</Text>
            <Text style={styles.endpointHint}>UID: {userUid}</Text>
          </View>
        </View>
        <Text style={styles.endpointHint}>Backend: {getApiBaseUrl()}</Text>
        {expoGo ? (
          <Text style={styles.endpointHint}>
            Expo Go detected. Remote mobile push registration is disabled; use a development build for `expo-notifications` push flows.
          </Text>
        ) : null}
        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
        {successMessage ? <Text style={styles.successText}>{successMessage}</Text> : null}
        <View style={styles.signOutGap}>
          <SecondaryButton onPress={() => void signOut()}>Sign out</SecondaryButton>
        </View>
      </SurfaceCard>

      <SurfaceCard style={styles.section}>
        <Text style={styles.cardTitle}>Operational surfaces</Text>
        <Text style={styles.inventorySub}>
          Jump to the current mobile equivalents of chat, sessions, and schedules while the rest of settings stays task-oriented.
        </Text>
        <View style={styles.navGrid}>
          {[
            {
              title: "Chat",
              description: "Launch runs, draft flows, and create automations.",
              route: "/(tabs)/chat" as const,
            },
            {
              title: "Sessions",
              description: "Inspect browser frames and take temporary control when automation stalls.",
              route: "/(tabs)/navigator" as const,
            },
            {
              title: "Schedules",
              description: "Review upcoming automations and current engine health.",
              route: "/(tabs)/schedules" as const,
            },
          ].map((card) => (
            <Pressable
              key={card.title}
              onPress={() => router.push(card.route)}
              style={({ pressed }) => [styles.navCard, pressed ? styles.navCardPressed : null]}
            >
              <Text style={styles.navTitle}>{card.title}</Text>
              <Text style={styles.navDescription}>{card.description}</Text>
            </Pressable>
          ))}
        </View>
      </SurfaceCard>

      <SurfaceCard style={styles.section}>
        <Text style={styles.cardTitle}>Mobile sign-in handoff</Text>
        <Text style={styles.inventorySub}>
          Generate a one-time payload from this signed-in device, then scan or paste it on another mobile client to finish sign-in.
        </Text>
        <SecondaryButton onPress={() => void generateAuthQr()} loading={creatingAuthQr}>
          Generate handoff
        </SecondaryButton>
        {authQrCode ? (
          <View style={styles.authCard}>
            <Text style={styles.deviceName}>Manual code</Text>
            <Text style={styles.authCode}>{authQrCode}</Text>
            <Text style={styles.deviceSub}>Expires {authQrExpiry}</Text>
            <Text style={[styles.deviceName, styles.authLabel]}>Payload</Text>
            <Text selectable style={styles.authPayload}>
              {authQrPayload}
            </Text>
          </View>
        ) : null}
      </SurfaceCard>

      <SurfaceCard style={styles.section}>
        <Text style={styles.cardTitle}>Notification preferences</Text>
        <Text style={styles.inventorySub}>
          Control which surfaces receive automation alerts and whether low-urgency updates stay on connected devices only.
        </Text>

        {notificationPreferences ? (
          <View style={styles.preferenceStack}>
            <View style={styles.preferenceRow}>
              <View style={styles.deviceCopy}>
                <Text style={styles.deviceName}>Desktop notifications</Text>
                <Text style={styles.deviceSub}>Allow desktop alerts for automation incidents.</Text>
              </View>
              <Switch
                value={notificationPreferences.desktop_enabled}
                onValueChange={(value) => void saveNotificationPreferencePatch({ desktop_enabled: value })}
              />
            </View>

            <View style={styles.preferenceRow}>
              <View style={styles.deviceCopy}>
                <Text style={styles.deviceName}>Browser notifications</Text>
                <Text style={styles.deviceSub}>Show automation alerts in browser-supported notifications.</Text>
              </View>
              <Switch
                value={notificationPreferences.browser_enabled}
                onValueChange={(value) => void saveNotificationPreferencePatch({ browser_enabled: value })}
              />
            </View>

            <View style={styles.preferenceRow}>
              <View style={styles.deviceCopy}>
                <Text style={styles.deviceName}>Mobile push notifications</Text>
                <Text style={styles.deviceSub}>Send incident alerts to this phone through the native FCM or APNs delivery path.</Text>
              </View>
              <Switch
                value={notificationPreferences.mobile_push_enabled}
                onValueChange={(value) => void saveNotificationPreferencePatch({ mobile_push_enabled: value })}
              />
            </View>

            <View style={styles.preferenceRow}>
              <View style={styles.deviceCopy}>
                <Text style={styles.deviceName}>Connected devices only for non-critical</Text>
                <Text style={styles.deviceSub}>Keep replanning and soft incident alerts on active devices when possible.</Text>
              </View>
              <Switch
                value={notificationPreferences.connected_device_only_for_noncritical}
                onValueChange={(value) =>
                  void saveNotificationPreferencePatch({ connected_device_only_for_noncritical: value })
                }
              />
            </View>

            <View style={styles.preferenceGroup}>
              <Text style={styles.deviceName}>Alert level</Text>
              <Text style={styles.deviceSub}>Choose how broadly automation updates should interrupt you.</Text>
              <View style={styles.optionRow}>
                {NOTIFICATION_URGENCY_OPTIONS.map((option) => {
                  const selected = notificationPreferences.urgency_mode === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      onPress={() => void saveNotificationPreferencePatch({ urgency_mode: option.value })}
                      style={({ pressed }) => [
                        styles.optionChip,
                        selected ? styles.optionChipSelected : null,
                        pressed ? styles.optionChipPressed : null,
                      ]}
                    >
                      <Text
                        style={[
                          styles.optionChipText,
                          selected ? styles.optionChipTextSelected : null,
                        ]}
                      >
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

              <Text style={styles.inventorySub}>
                {savingPreferences ? "Saving notification preferences..." : "Preferences save automatically."}
              </Text>
              {expoGo ? (
                <Text style={styles.inventorySub}>
                  Expo Go cannot register native push tokens here. Use a development build for production-style mobile push.
                </Text>
              ) : null}
            </View>
        ) : (
          <Text style={styles.inventorySub}>Loading notification preferences...</Text>
        )}
      </SurfaceCard>

      <SurfaceCard style={styles.section}>
        <Text style={styles.cardTitle}>Pair via QR or code</Text>
        <TextInput
          style={styles.input}
          value={pairingInput}
          onChangeText={setPairingInput}
          placeholder="Paste oi://pair-device?... or '<pairing_id> <code>'"
          placeholderTextColor={theme.colors.textSoft}
          autoCapitalize="none"
        />

        <View style={styles.row}>
          <View style={styles.halfButton}>
            <SecondaryButton
              onPress={() => {
                const ok = applyParsedPairing(pairingInput);
                if (!ok) setErrorMessage("Could not parse pairing payload.");
              }}
            >
              Parse
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
                if (!scannerOpen) return;
                const ok = applyParsedPairing(String(event.data || ""));
                if (ok) {
                  setScannerOpen(false);
                  setSuccessMessage("QR scanned. Confirm the details and redeem.");
                } else {
                  setErrorMessage("Scanned QR is not a valid Oye pairing payload.");
                }
              }}
            />
            <SecondaryButton onPress={() => setScannerOpen(false)}>Close scanner</SecondaryButton>
          </View>
        ) : null}

        <TextInput
          style={styles.input}
          value={pairingId}
          onChangeText={setPairingId}
          placeholder="Pairing ID"
          placeholderTextColor={theme.colors.textSoft}
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          value={pairingCode}
          onChangeText={(value) => setPairingCode(value.toUpperCase())}
          placeholder="Pairing code"
          placeholderTextColor={theme.colors.textSoft}
          autoCapitalize="characters"
        />
        <TextInput
          style={styles.input}
          value={deviceType}
          onChangeText={(value) => setDeviceType((value || "mobile") as DeviceType)}
          placeholder="Device type (mobile/desktop/web)"
          placeholderTextColor={theme.colors.textSoft}
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          value={deviceName}
          onChangeText={setDeviceName}
          placeholder="Device name"
          placeholderTextColor={theme.colors.textSoft}
        />
        <TextInput
          style={styles.input}
          value={deviceId}
          onChangeText={setDeviceId}
          placeholder="Optional device_id"
          placeholderTextColor={theme.colors.textSoft}
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          value={fcmToken}
          onChangeText={setFcmToken}
          placeholder={Platform.OS === "ios" ? "APNs/FCM token" : "FCM token"}
          placeholderTextColor={theme.colors.textSoft}
          autoCapitalize="none"
        />

        <SecondaryButton onPress={() => void resolvePushToken()} loading={resolvingPushToken} disabled={expoGo}>
          Detect native push token
        </SecondaryButton>

        <PrimaryButton onPress={() => void onRedeem()} loading={redeeming}>
          Redeem and link
        </PrimaryButton>
      </SurfaceCard>

      <SurfaceCard style={styles.section}>
        <View style={styles.inventoryHeader}>
          <View>
            <Text style={styles.cardTitle}>Linked devices</Text>
            <Text style={styles.inventorySub}>{linkedCount} currently registered</Text>
          </View>
          <View style={styles.inventoryButton}>
            <SecondaryButton onPress={() => void loadDevices()} loading={loadingDevices}>
              Refresh
            </SecondaryButton>
          </View>
        </View>

        {loadingDevices && devices.length === 0 ? (
          <Text style={styles.inventorySub}>Loading devices...</Text>
        ) : null}

        {!loadingDevices && devices.length === 0 ? (
          <Text style={styles.inventorySub}>No devices linked yet.</Text>
        ) : null}

        {devices.map((device) => {
          const online = Boolean(device.connected ?? device.is_online);
          return (
            <View key={device.device_id} style={styles.deviceRow}>
              <View style={styles.deviceCopy}>
                <Text style={styles.deviceName}>{device.device_name}</Text>
                <Text style={styles.deviceSub}>
                  {device.device_type} · Last seen {pretty(device.last_seen)}
                </Text>
                <Text style={styles.deviceId}>{device.device_id}</Text>
              </View>
              <StatusChip label={online ? "online" : "offline"} tone={online ? "success" : "neutral"} />
            </View>
          );
        })}
      </SurfaceCard>
    </MobileScreen>
  );
}

function getSettingsStyles(theme: ReturnType<typeof useMobileTheme>) {
  return StyleSheet.create({
  content: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  section: {
    gap: theme.spacing[3],
  },
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  userAvatar: {
    width: 46,
    height: 46,
    borderRadius: theme.radii.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(117, 22, 54, 0.12)",
  },
  userAvatarText: {
    fontSize: theme.typography.fontSize.base,
    fontWeight: "700",
    color: theme.colors.text,
  },
  userCopy: {
    flex: 1,
    gap: 2,
  },
  endpointHint: {
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textMuted,
  },
  errorText: {
    marginTop: theme.spacing[2],
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.error,
  },
  successText: {
    marginTop: theme.spacing[2],
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.success,
  },
  signOutGap: {
    marginTop: theme.spacing[3],
  },
  cardTitle: {
    fontSize: theme.typography.fontSize.lg,
    fontWeight: "700",
    color: theme.colors.text,
  },
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
  row: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  halfButton: {
    flex: 1,
  },
  scannerWrap: {
    gap: theme.spacing[3],
  },
  scanner: {
    width: "100%",
    height: 260,
    borderRadius: theme.radii.md,
    overflow: "hidden",
  },
  inventoryHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  inventorySub: {
    marginTop: theme.spacing[1],
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textMuted,
  },
  inventoryButton: {
    minWidth: 108,
  },
  navGrid: {
    gap: theme.spacing[2],
  },
  navCard: {
    gap: theme.spacing[1],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.sm,
    backgroundColor: theme.colors.surfaceMuted,
    padding: theme.spacing[3],
  },
  navCardPressed: {
    opacity: 0.84,
  },
  navTitle: {
    fontSize: theme.typography.fontSize.base,
    fontWeight: "700",
    color: theme.colors.text,
  },
  navDescription: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.textMuted,
  },
  authCard: {
    gap: theme.spacing[1],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.sm,
    backgroundColor: theme.colors.surfaceMuted,
    padding: theme.spacing[3],
  },
  authCode: {
    fontSize: 24,
    fontWeight: "700",
    color: theme.colors.primary,
    letterSpacing: 1.2,
  },
  authLabel: {
    marginTop: theme.spacing[2],
  },
  authPayload: {
    fontSize: theme.typography.fontSize.xs,
    lineHeight: 18,
    color: theme.colors.textSoft,
  },
  preferenceStack: {
    gap: theme.spacing[3],
  },
  preferenceGroup: {
    gap: theme.spacing[2],
  },
  preferenceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  optionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  optionChip: {
    minHeight: 40,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.radii.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceMuted,
    justifyContent: "center",
  },
  optionChipSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  optionChipPressed: {
    opacity: 0.85,
  },
  optionChipText: {
    fontSize: theme.typography.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.text,
  },
  optionChipTextSelected: {
    color: theme.colors.primary,
  },
  deviceRow: {
    paddingTop: theme.spacing[3],
    marginTop: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  deviceCopy: {
    flex: 1,
  },
  deviceName: {
    fontSize: theme.typography.fontSize.sm,
    fontWeight: "700",
    color: theme.colors.text,
  },
  deviceSub: {
    marginTop: theme.spacing[1],
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textMuted,
  },
  deviceId: {
    marginTop: theme.spacing[1],
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.textSoft,
  },
});
}
