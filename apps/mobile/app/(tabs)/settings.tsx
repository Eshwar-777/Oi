import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

import { fetchWithTimeout, getApiBaseUrl } from "@/lib/api";
import { getAuthHeaders } from "@/lib/authHeaders";
import { parsePairingInput } from "@/lib/devicePairing";
import { mobileTheme } from "@/theme";

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
  const res = await fetchWithTimeout(`${api}/devices`, { headers: await getAuthHeaders() });
  const body = await res.json().catch(() => []);
  if (!res.ok) throw new Error(typeof body?.detail === "string" ? body.detail : "Failed to fetch devices");
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
  const res = await fetchWithTimeout(`${api}/devices/pairing/redeem`, {
    method: "POST",
    headers: await getAuthHeaders(),
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body?.detail === "string" ? body.detail : "Failed to link device");
}

function pretty(value?: string): string {
  if (!value) return "Never";
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return value;
  return new Date(ts).toLocaleString();
}

export default function SettingsScreen() {
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
      setErrorMessage(err instanceof Error ? err.message : "Failed to link device");
    } finally {
      setRedeeming(false);
    }
  }, [pairingCode, pairingId, deviceName, deviceType, deviceId, fcmToken, loadDevices]);

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
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Link Device (QR / Code)</Text>
      <Text style={styles.sectionDescription}>
        Scan pairing QR from web Settings or paste pairing payload/code below.
      </Text>

      {errorMessage ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </View>
      ) : null}
      {successMessage ? (
        <View style={styles.successBox}>
          <Text style={styles.successText}>{successMessage}</Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <TextInput
          style={styles.input}
          value={pairingInput}
          onChangeText={setPairingInput}
          placeholder="Paste oi://pair-device?... or '<pairing_id> <code>'"
          placeholderTextColor={mobileTheme.colors.textMuted}
          autoCapitalize="none"
        />
        <View style={styles.row}>
          <Pressable
            style={styles.secondaryButton}
            onPress={() => {
              const ok = applyParsedPairing(pairingInput);
              if (!ok) setErrorMessage("Could not parse pairing payload.");
            }}
          >
            <Text style={styles.secondaryButtonText}>Parse</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={onOpenScanner}>
            <Text style={styles.secondaryButtonText}>Scan QR</Text>
          </Pressable>
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
                  setSuccessMessage("QR scanned. Confirm details and redeem.");
                } else {
                  setErrorMessage("Scanned QR is not a valid OI pairing payload.");
                }
              }}
            />
            <Pressable style={styles.secondaryButton} onPress={() => setScannerOpen(false)}>
              <Text style={styles.secondaryButtonText}>Close Scanner</Text>
            </Pressable>
          </View>
        ) : null}

        <TextInput
          style={styles.input}
          value={pairingId}
          onChangeText={setPairingId}
          placeholder="Pairing ID"
          placeholderTextColor={mobileTheme.colors.textMuted}
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          value={pairingCode}
          onChangeText={(v) => setPairingCode(v.toUpperCase())}
          placeholder="Pairing Code"
          placeholderTextColor={mobileTheme.colors.textMuted}
          autoCapitalize="characters"
        />
        <TextInput
          style={styles.input}
          value={deviceType}
          onChangeText={(v) => setDeviceType((v || "mobile") as DeviceType)}
          placeholder="Device type (mobile/desktop/web/extension)"
          placeholderTextColor={mobileTheme.colors.textMuted}
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          value={deviceName}
          onChangeText={setDeviceName}
          placeholder="Device name"
          placeholderTextColor={mobileTheme.colors.textMuted}
        />
        <TextInput
          style={styles.input}
          value={deviceId}
          onChangeText={setDeviceId}
          placeholder="Optional device_id"
          placeholderTextColor={mobileTheme.colors.textMuted}
          autoCapitalize="none"
        />
        <TextInput
          style={styles.input}
          value={fcmToken}
          onChangeText={setFcmToken}
          placeholder="Optional FCM token"
          placeholderTextColor={mobileTheme.colors.textMuted}
          autoCapitalize="none"
        />

        <Pressable style={styles.primaryButton} onPress={onRedeem} disabled={redeeming}>
          {redeeming ? (
            <ActivityIndicator color={mobileTheme.colors.primaryText} />
          ) : (
            <Text style={styles.primaryButtonText}>Redeem & Link Device</Text>
          )}
        </Pressable>
      </View>

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>Linked Devices ({linkedCount})</Text>
          <Pressable style={styles.linkButton} onPress={loadDevices}>
            <Text style={styles.linkText}>{loadingDevices ? "Refreshing..." : "Refresh"}</Text>
          </Pressable>
        </View>

        {!loadingDevices && devices.length === 0 ? (
          <Text style={styles.emptyText}>No linked devices yet.</Text>
        ) : null}

        {devices.map((d) => {
          const online = Boolean(d.connected ?? d.is_online);
          return (
            <View key={d.device_id} style={styles.deviceRow}>
              <View style={styles.deviceMeta}>
                <Text style={styles.deviceName}>{d.device_name}</Text>
                <Text style={styles.deviceSub}>
                  {d.device_type} · {online ? "Online" : "Offline"} · Last seen: {pretty(d.last_seen)}
                </Text>
                <Text style={styles.deviceId}>ID: {d.device_id}</Text>
              </View>
              <View style={[styles.dot, online ? styles.dotOnline : styles.dotOffline]} />
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: mobileTheme.colors.bg },
  content: { padding: 16, paddingBottom: 28 },
  sectionTitle: { fontSize: 18, fontWeight: "700", color: mobileTheme.colors.text },
  sectionDescription: { marginTop: 6, marginBottom: 12, fontSize: 13, color: mobileTheme.colors.textMuted },
  card: {
    backgroundColor: mobileTheme.colors.surface,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    marginBottom: 12,
  },
  cardTitle: { fontSize: 14, fontWeight: "600", color: mobileTheme.colors.text },
  input: {
    backgroundColor: mobileTheme.colors.bg,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 14,
    color: mobileTheme.colors.text,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    marginBottom: 8,
  },
  row: { flexDirection: "row", gap: 8, marginBottom: 8 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  primaryButton: {
    backgroundColor: mobileTheme.colors.primary,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4,
  },
  primaryButtonText: { color: mobileTheme.colors.primaryText, fontSize: 14, fontWeight: "600" },
  secondaryButton: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    backgroundColor: mobileTheme.colors.surface,
    paddingVertical: 10,
    alignItems: "center",
  },
  secondaryButtonText: { color: mobileTheme.colors.primary, fontWeight: "600", fontSize: 13 },
  linkButton: { paddingVertical: 4, paddingHorizontal: 6 },
  linkText: { fontSize: 13, color: mobileTheme.colors.primary, fontWeight: "600" },
  scannerWrap: { marginBottom: 8 },
  scanner: { width: "100%", height: 240, borderRadius: 12, overflow: "hidden", marginBottom: 8 },
  errorBox: {
    backgroundColor: "#FEF2F2",
    borderColor: "#FCA5A5",
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
  },
  errorText: { color: mobileTheme.colors.error, fontSize: 12 },
  successBox: {
    backgroundColor: "#F0FDF4",
    borderColor: "#86EFAC",
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
  },
  successText: { color: mobileTheme.colors.success, fontSize: 12 },
  emptyText: { marginTop: 8, color: mobileTheme.colors.textMuted, fontSize: 13 },
  deviceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: mobileTheme.colors.surfaceMuted,
  },
  deviceMeta: { flex: 1, paddingRight: 12 },
  deviceName: { fontSize: 13, fontWeight: "600", color: mobileTheme.colors.text },
  deviceSub: { marginTop: 2, fontSize: 12, color: mobileTheme.colors.textMuted },
  deviceId: { marginTop: 2, fontSize: 11, color: mobileTheme.colors.textMuted },
  dot: { width: 10, height: 10, borderRadius: 99, marginTop: 4 },
  dotOnline: { backgroundColor: mobileTheme.colors.success },
  dotOffline: { backgroundColor: mobileTheme.colors.surfaceMuted },
});
