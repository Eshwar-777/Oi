import { useCallback, useMemo, useState } from "react";
import {
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useFocusEffect } from "expo-router";
import {
  MobileScreen,
  PrimaryButton,
  SecondaryButton,
  SectionHeader,
  StatusChip,
  SurfaceCard,
  mobileTheme,
} from "@oi/design-system-mobile";

import { fetchWithTimeout, getApiBaseUrl, getPairingTimeoutMs } from "@/lib/api";
import { getAuthHeaders } from "@/lib/authHeaders";
import { parsePairingInput } from "@/lib/devicePairing";
import { useMobileAuth } from "@/features/auth/AuthContext";

type DeviceType = "mobile" | "desktop" | "web" | "extension";

interface RegisteredDevice {
  device_id: string;
  device_type: string;
  device_name: string;
  is_online?: boolean;
  connected?: boolean;
  last_seen?: string;
}

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
}): Promise<void> {
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
  const { signOut, user } = useMobileAuth();
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
  const [redeeming, setRedeeming] = useState(false);

  const [scannerOpen, setScannerOpen] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

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

  useFocusEffect(
    useCallback(() => {
      void loadDevices();
    }, [loadDevices]),
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
      await redeemPairing({
        pairing_id: pairingId.trim(),
        code: pairingCode.trim().toUpperCase(),
        device_type: deviceType,
        device_name: deviceName.trim(),
        device_id: deviceId.trim() || undefined,
        fcm_token: fcmToken.trim() || undefined,
      });
      setSuccessMessage("Device linked successfully.");
      await loadDevices();
    } catch (err) {
      setErrorMessage(formatRedeemError(err));
    } finally {
      setRedeeming(false);
    }
  }, [deviceId, deviceName, deviceType, fcmToken, loadDevices, pairingCode, pairingId]);

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

  return (
    <MobileScreen scrollable contentContainerStyle={styles.content}>
      <SectionHeader
        eyebrow="Settings"
        title="Link mobile devices"
        description="Pairing, QR scanning, and device inventory now sit on the shared mobile design system."
      />

      <SurfaceCard>
        <Text style={styles.endpointHint}>Backend: {getApiBaseUrl()}</Text>
        <Text style={styles.endpointHint}>Signed in: {user?.email || "Authenticated user"}</Text>
        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
        {successMessage ? <Text style={styles.successText}>{successMessage}</Text> : null}
        <View style={styles.signOutGap}>
          <SecondaryButton onPress={() => void signOut()}>Sign out</SecondaryButton>
        </View>
      </SurfaceCard>

      <SurfaceCard style={styles.section}>
        <Text style={styles.cardTitle}>Pair via QR or code</Text>
        <TextInput
          style={styles.input}
          value={pairingInput}
          onChangeText={setPairingInput}
          placeholder="Paste oi://pair-device?... or '<pairing_id> <code>'"
          placeholderTextColor={mobileTheme.colors.textSoft}
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
                  setErrorMessage("Scanned QR is not a valid OI pairing payload.");
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
          placeholderTextColor={mobileTheme.colors.textSoft}
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          value={pairingCode}
          onChangeText={(value) => setPairingCode(value.toUpperCase())}
          placeholder="Pairing code"
          placeholderTextColor={mobileTheme.colors.textSoft}
          autoCapitalize="characters"
        />
        <TextInput
          style={styles.input}
          value={deviceType}
          onChangeText={(value) => setDeviceType((value || "mobile") as DeviceType)}
          placeholder="Device type (mobile/desktop/web/extension)"
          placeholderTextColor={mobileTheme.colors.textSoft}
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          value={deviceName}
          onChangeText={setDeviceName}
          placeholder="Device name"
          placeholderTextColor={mobileTheme.colors.textSoft}
        />
        <TextInput
          style={styles.input}
          value={deviceId}
          onChangeText={setDeviceId}
          placeholder="Optional device_id"
          placeholderTextColor={mobileTheme.colors.textSoft}
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          value={fcmToken}
          onChangeText={setFcmToken}
          placeholder="Optional FCM token"
          placeholderTextColor={mobileTheme.colors.textSoft}
          autoCapitalize="none"
        />

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

const styles = StyleSheet.create({
  content: {
    gap: mobileTheme.spacing[4],
    paddingBottom: mobileTheme.spacing[6],
  },
  section: {
    gap: mobileTheme.spacing[3],
  },
  endpointHint: {
    fontSize: mobileTheme.typography.fontSize.xs,
    color: mobileTheme.colors.textMuted,
  },
  errorText: {
    marginTop: mobileTheme.spacing[2],
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.error,
  },
  successText: {
    marginTop: mobileTheme.spacing[2],
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.success,
  },
  signOutGap: {
    marginTop: mobileTheme.spacing[3],
  },
  cardTitle: {
    fontSize: mobileTheme.typography.fontSize.lg,
    fontWeight: "700",
    color: mobileTheme.colors.text,
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
  row: {
    flexDirection: "row",
    gap: mobileTheme.spacing[2],
  },
  halfButton: {
    flex: 1,
  },
  scannerWrap: {
    gap: mobileTheme.spacing[3],
  },
  scanner: {
    width: "100%",
    height: 260,
    borderRadius: mobileTheme.radii.md,
    overflow: "hidden",
  },
  inventoryHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: mobileTheme.spacing[3],
  },
  inventorySub: {
    marginTop: mobileTheme.spacing[1],
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.textMuted,
  },
  inventoryButton: {
    minWidth: 108,
  },
  deviceRow: {
    paddingTop: mobileTheme.spacing[3],
    marginTop: mobileTheme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: mobileTheme.colors.border,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: mobileTheme.spacing[3],
  },
  deviceCopy: {
    flex: 1,
  },
  deviceName: {
    fontSize: mobileTheme.typography.fontSize.sm,
    fontWeight: "700",
    color: mobileTheme.colors.text,
  },
  deviceSub: {
    marginTop: mobileTheme.spacing[1],
    fontSize: mobileTheme.typography.fontSize.xs,
    color: mobileTheme.colors.textMuted,
  },
  deviceId: {
    marginTop: mobileTheme.spacing[1],
    fontSize: mobileTheme.typography.fontSize.xs,
    color: mobileTheme.colors.textSoft,
  },
});
