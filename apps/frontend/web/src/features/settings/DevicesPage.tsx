import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "react-qr-code";
import {
  SectionHeader,
  StatusPill,
  SurfaceCard,
} from "@oi/design-system-web";
import { toApiUrl } from "@/lib/api";

const QRCodeGraphic = QRCode as unknown as (props: {
  value: string;
  size?: number;
}) => JSX.Element;

type DeviceType = "web" | "mobile" | "desktop" | "extension" | string;

interface RegisteredDevice {
  device_id: string;
  device_type: DeviceType;
  device_name: string;
  is_online?: boolean;
  connected?: boolean;
  last_seen?: string;
}

interface PairingSession {
  pairing_id: string;
  code: string;
  status: string;
  created_at: string;
  expires_at: string;
  pairing_uri: string;
  qr_payload: string;
}

interface PairingSessionStatus {
  pairing_id: string;
  status: string;
  created_at?: string;
  expires_at?: string;
  linked_device_id?: string;
  linked_device_name?: string;
  linked_device_type?: string;
}

function toErrorMessage(value: unknown, fallback: string) {
  if (value instanceof Error && value.message) return value.message;
  return fallback;
}

async function parseApiError(res: Response, fallback: string) {
  const body = await res.json().catch(() => ({}));
  if (body && typeof body === "object" && typeof (body as { detail?: unknown }).detail === "string") {
    return (body as { detail: string }).detail;
  }
  return fallback;
}

async function fetchDevices() {
  const res = await fetch(toApiUrl("/api/devices"), {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to fetch devices"));
  const data = (await res.json()) as RegisteredDevice[];
  return Array.isArray(data) ? data : [];
}

async function createPairingSession(expiresInSeconds = 300) {
  const res = await fetch(toApiUrl("/api/devices/pairing/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expires_in_seconds: expiresInSeconds }),
  });
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to create pairing session"));
  return (await res.json()) as PairingSession;
}

async function fetchPairingStatus(pairingId: string) {
  const res = await fetch(toApiUrl(`/api/devices/pairing/session/${encodeURIComponent(pairingId)}`), {
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to fetch pairing status"));
  return (await res.json()) as PairingSessionStatus;
}

async function redeemPairing(payload: {
  pairing_id: string;
  code: string;
  device_type: DeviceType;
  device_name: string;
  device_id?: string;
  fcm_token?: string;
}) {
  const res = await fetch(toApiUrl("/api/devices/pairing/redeem"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to redeem pairing code"));
}

async function deleteDevice(deviceId: string) {
  const res = await fetch(toApiUrl(`/api/devices/${encodeURIComponent(deviceId)}`), {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(await parseApiError(res, "Failed to remove device"));
}

function pretty(value?: string) {
  if (!value) return "Never";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

export function DevicesPage() {
  const queryClient = useQueryClient();
  const [activeSession, setActiveSession] = useState<PairingSession | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [redeemPairingId, setRedeemPairingId] = useState("");
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemType, setRedeemType] = useState<DeviceType>("desktop");
  const [redeemName, setRedeemName] = useState("");
  const [redeemDeviceId, setRedeemDeviceId] = useState("");
  const [redeemFcm, setRedeemFcm] = useState("");

  const devicesQuery = useQuery({
    queryKey: ["settings-devices"],
    queryFn: fetchDevices,
  });

  const pairingStatusQuery = useQuery({
    queryKey: ["pairing-status", activeSession?.pairing_id],
    queryFn: () => fetchPairingStatus(activeSession!.pairing_id),
    enabled: Boolean(activeSession?.pairing_id),
    refetchInterval: 8_000,
  });

  const createPairingMutation = useMutation({
    mutationFn: createPairingSession,
    onSuccess: (session) => {
      setActiveSession(session);
      setRedeemPairingId(session.pairing_id);
      setRedeemCode(session.code);
      setErrorMessage("");
    },
    onError: (err) => setErrorMessage(toErrorMessage(err, "Failed to create pairing session")),
  });

  const redeemMutation = useMutation({
    mutationFn: redeemPairing,
    onSuccess: async () => {
      setErrorMessage("");
      await queryClient.invalidateQueries({ queryKey: ["settings-devices"] });
      if (activeSession?.pairing_id) {
        await queryClient.invalidateQueries({ queryKey: ["pairing-status", activeSession.pairing_id] });
      }
    },
    onError: (err) => setErrorMessage(toErrorMessage(err, "Failed to redeem code")),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteDevice,
    onSuccess: async () => {
      setErrorMessage("");
      await queryClient.invalidateQueries({ queryKey: ["settings-devices"] });
    },
    onError: (err) => setErrorMessage(toErrorMessage(err, "Failed to remove device")),
  });

  const pairingStatus = pairingStatusQuery.data ?? null;
  const isLinked = pairingStatus?.status?.toLowerCase() === "linked";
  const expiresText = useMemo(
    () => pretty(activeSession?.expires_at || pairingStatus?.expires_at),
    [activeSession?.expires_at, pairingStatus?.expires_at],
  );

  useEffect(() => {
    if (!isLinked) return;
    void queryClient.invalidateQueries({ queryKey: ["settings-devices"] });
  }, [isLinked, queryClient]);

  return (
    <Stack spacing={3}>
      <Button href="/settings" variant="text" sx={{ alignSelf: "flex-start", px: 0 }}>
        Back to settings
      </Button>

      <SectionHeader
        eyebrow="Devices"
        title="Pair and manage clients"
        description="The pairing flow is now framed as a reusable settings surface instead of a one-off page, with inline QR generation and cleaner form structure."
      />

      {errorMessage ? (
        <SurfaceCard>
          <Typography variant="body2" color="error.main">
            {errorMessage}
          </Typography>
        </SurfaceCard>
      ) : null}

      <SurfaceCard
        eyebrow="Pairing"
        title="Link a new device"
        subtitle="Generate a short-lived code and QR payload for desktop, mobile, or browser clients."
        actions={
          <Button
            variant="contained"
            onClick={() => createPairingMutation.mutate(300)}
            disabled={createPairingMutation.isPending}
          >
            {createPairingMutation.isPending ? "Generating..." : "Generate code"}
          </Button>
        }
      >
        {activeSession ? (
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", lg: "320px minmax(0, 1fr)" },
              gap: 2,
            }}
          >
            <Box
              sx={{
                p: 3,
                borderRadius: "20px",
                backgroundColor: "var(--surface-card-muted)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <Typography variant="overline" color="text.secondary">
                Pairing code
              </Typography>
              <Typography variant="h2" sx={{ fontSize: "2.5rem", mt: 1 }}>
                {activeSession.code}
              </Typography>
              <Typography variant="body2" color="text.secondary" mt={1.5}>
                Expires: {expiresText}
              </Typography>
              <Stack direction="row" spacing={1} alignItems="center" mt={1.5}>
                <Typography variant="body2" color="text.secondary">
                  Status
                </Typography>
                <StatusPill label={pairingStatus?.status || activeSession.status} tone={isLinked ? "success" : "warning"} />
              </Stack>
              {isLinked ? (
                <Typography variant="body2" color="success.main" mt={1.5}>
                  Linked: {pairingStatus?.linked_device_name} ({pairingStatus?.linked_device_type})
                </Typography>
              ) : null}
            </Box>

            <Box
              sx={{
                p: 3,
                borderRadius: "20px",
                backgroundColor: "var(--surface-card-muted)",
                border: "1px solid var(--border-subtle)",
              }}
            >
              <Typography variant="overline" color="text.secondary">
                QR payload
              </Typography>
              <Box
                sx={{
                  mt: 2,
                  mb: 2,
                  p: 2,
                  display: "inline-flex",
                  borderRadius: "18px",
                  backgroundColor: "var(--surface-card)",
                }}
              >
                <QRCodeGraphic value={activeSession.qr_payload} size={176} />
              </Box>
              <Typography
                variant="body2"
                sx={{
                  p: 2,
                  borderRadius: "16px",
                  backgroundColor: "var(--surface-card)",
                  wordBreak: "break-word",
                }}
              >
                {activeSession.qr_payload}
              </Typography>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25} mt={2}>
                <Button
                  variant="outlined"
                  onClick={async () => navigator.clipboard.writeText(activeSession.qr_payload)}
                >
                  Copy payload
                </Button>
                <Button
                  variant="outlined"
                  onClick={async () => navigator.clipboard.writeText(activeSession.code)}
                >
                  Copy code
                </Button>
                <Button variant="text" onClick={() => pairingStatusQuery.refetch()}>
                  Refresh status
                </Button>
              </Stack>
            </Box>
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No active pairing session yet. Generate one to display its QR payload and code.
          </Typography>
        )}
      </SurfaceCard>

      <SurfaceCard
        eyebrow="Redeem"
        title="Manual pairing"
        subtitle="Use this when a device needs the pairing ID and code pasted directly."
      >
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" },
            gap: 2,
          }}
        >
          <TextField value={redeemPairingId} onChange={(event) => setRedeemPairingId(event.target.value)} label="Pairing ID" />
          <TextField value={redeemCode} onChange={(event) => setRedeemCode(event.target.value.toUpperCase())} label="Pairing code" />
          <TextField select value={redeemType} onChange={(event) => setRedeemType(event.target.value)} label="Device type">
            <MenuItem value="mobile">Mobile</MenuItem>
            <MenuItem value="desktop">Desktop</MenuItem>
            <MenuItem value="web">Web</MenuItem>
            <MenuItem value="extension">Extension</MenuItem>
          </TextField>
          <TextField value={redeemName} onChange={(event) => setRedeemName(event.target.value)} label="Device name" />
          <TextField value={redeemDeviceId} onChange={(event) => setRedeemDeviceId(event.target.value)} label="Optional device ID" />
          <TextField value={redeemFcm} onChange={(event) => setRedeemFcm(event.target.value)} label="Optional FCM token" />
        </Box>

        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} mt={3}>
          <Button
            variant="contained"
            disabled={redeemMutation.isPending}
            onClick={() => {
              if (!redeemPairingId.trim() || !redeemCode.trim() || !redeemName.trim()) {
                setErrorMessage("Pairing ID, code, and device name are required.");
                return;
              }

              redeemMutation.mutate({
                pairing_id: redeemPairingId.trim(),
                code: redeemCode.trim(),
                device_type: redeemType,
                device_name: redeemName.trim(),
                device_id: redeemDeviceId.trim() || undefined,
                fcm_token: redeemFcm.trim() || undefined,
              });
            }}
          >
            {redeemMutation.isPending ? "Linking..." : "Redeem and link"}
          </Button>
        </Stack>
      </SurfaceCard>

      <SurfaceCard
        eyebrow="Inventory"
        title="Registered devices"
        subtitle="All currently linked clients show here with their last-seen state."
        actions={
          <Button variant="text" onClick={() => devicesQuery.refetch()}>
            Refresh
          </Button>
        }
      >
        <Stack spacing={1.5}>
          {devicesQuery.isLoading ? (
            <Typography variant="body2" color="text.secondary">
              Loading devices...
            </Typography>
          ) : null}

          {!devicesQuery.isLoading && (devicesQuery.data ?? []).length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No devices linked yet.
            </Typography>
          ) : null}

          {(devicesQuery.data ?? []).map((device) => {
            const online = Boolean(device.connected ?? device.is_online);
            return (
              <Box
                key={device.device_id}
                sx={{
                  p: 2.5,
                  borderRadius: "18px",
                  border: "1px solid var(--border-subtle)",
                  backgroundColor: "var(--surface-card-muted)",
                }}
              >
                <Stack
                  direction={{ xs: "column", md: "row" }}
                  justifyContent="space-between"
                  alignItems={{ xs: "flex-start", md: "center" }}
                  gap={2}
                >
                  <Stack spacing={0.75}>
                    <Typography fontWeight={700}>{device.device_name}</Typography>
                    <Typography variant="body2" color="text.secondary">
                      {device.device_type} · {pretty(device.last_seen)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {device.device_id}
                    </Typography>
                  </Stack>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <StatusPill label={online ? "Online" : "Offline"} tone={online ? "success" : "neutral"} />
                    <Button
                      variant="outlined"
                      color="error"
                      disabled={deleteMutation.isPending}
                      onClick={() => {
                        if (!window.confirm(`Remove device "${device.device_name}"?`)) return;
                        deleteMutation.mutate(device.device_id);
                      }}
                    >
                      Remove
                    </Button>
                  </Stack>
                </Stack>
              </Box>
            );
          })}
        </Stack>
      </SurfaceCard>
    </Stack>
  );
}
