import {
  Alert,
  Box,
  Button,
  FormControl,
  FormControlLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
} from "@mui/material";
import { useEffect, useState } from "react";
import QRCode from "react-qr-code";
import {
  SectionHeader,
  SurfaceCard,
} from "@oi/design-system-web";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/features/auth/AuthContext";
import { authFetch } from "@/api/authFetch";
import type { NotificationPreferences } from "@/domain/automation";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from "@/api/notificationPreferences";

const QRCodeGraphic = QRCode as unknown as (props: {
  value: string;
  size?: number;
}) => JSX.Element;

const settingsCards = [
  {
    href: "/sessions",
    title: "Live sessions",
    description: "Inspect browser frames, acquire the control lock, and hand control back to the agent.",
  },
  {
    href: "/settings/devices",
    title: "Devices",
    description: "Pair and manage the web, desktop, and mobile clients from one place.",
  },
  {
    href: "/settings/mesh",
    title: "Mesh groups",
    description: "Organize human fallback groups for situations where Oye needs someone to step in.",
  },
  {
    href: "/chat",
    title: "Conversation",
    description: "Jump back into the main chat surface with the updated design system applied.",
  },
] as const;

export function SettingsPage() {
  const navigate = useNavigate();
  const { signOut, user } = useAuth();
  const [qrPayload, setQrPayload] = useState("");
  const [qrCodeValue, setQrCodeValue] = useState("");
  const [qrError, setQrError] = useState("");
  const [creatingQr, setCreatingQr] = useState(false);
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    void getNotificationPreferences()
      .then((result) => setPreferences(result))
      .catch((error) => setErrorMessage(error instanceof Error ? error.message : "Failed to load notification preferences"));
  }, []);

  async function savePreferencePatch(
    patch: Partial<Omit<NotificationPreferences, "user_id" | "updated_at">>,
  ) {
    if (!preferences) return;
    const next = {
      desktop_enabled: preferences.desktop_enabled,
      browser_enabled: preferences.browser_enabled,
      mobile_push_enabled: preferences.mobile_push_enabled,
      connected_device_only_for_noncritical: preferences.connected_device_only_for_noncritical,
      urgency_mode: preferences.urgency_mode,
      ...patch,
    };
    setSaving(true);
    setErrorMessage("");
    try {
      const updated = await updateNotificationPreferences(next);
      setPreferences(updated);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update notification preferences");
    } finally {
      setSaving(false);
    }
  }

  async function createMobileAuthQr() {
    setCreatingQr(true);
    setQrError("");
    try {
      const response = await authFetch("/api/auth/qr-handoff", {
        method: "POST",
        body: JSON.stringify({ expires_in_seconds: 300 }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body?.detail === "string" ? body.detail : "Failed to create auth handoff");
      }
      setQrPayload(String(body.qr_payload ?? ""));
      setQrCodeValue(String(body.code ?? ""));
    } catch (error) {
      setQrError(error instanceof Error ? error.message : "Failed to create auth handoff");
    } finally {
      setCreatingQr(false);
    }
  }

  return (
    <Stack spacing={3}>
      <SectionHeader
        eyebrow="Settings"
        title="System controls"
        description="The new UI keeps settings intentionally sparse and task-oriented: devices, mesh, and operational entry points."
      />

      <SurfaceCard>
        <Stack direction={{ xs: "column", md: "row" }} spacing={2} justifyContent="space-between" alignItems={{ xs: "flex-start", md: "center" }}>
          <Box>
            <Typography variant="body2" color="text.secondary">
              Signed in as
            </Typography>
            <Typography variant="h3" sx={{ fontSize: "1rem" }}>
              {user?.email || "Authenticated user"}
            </Typography>
          </Box>
          <Button
            variant="outlined"
            onClick={() => {
              void signOut().then(() => navigate("/login", { replace: true }));
            }}
          >
            Sign out
          </Button>
        </Stack>
      </SurfaceCard>

      <SurfaceCard>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h3" sx={{ fontSize: "1rem" }}>
              Mobile sign-in QR
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Generate a one-time QR/code handoff so the mobile app can sign in without typing credentials.
            </Typography>
          </Box>
          {qrError ? <Alert severity="error">{qrError}</Alert> : null}
          <Stack direction={{ xs: "column", md: "row" }} spacing={2} alignItems={{ xs: "stretch", md: "center" }}>
            <Button variant="contained" onClick={() => void createMobileAuthQr()} disabled={creatingQr}>
              {creatingQr ? "Generating..." : "Generate QR"}
            </Button>
            {qrCodeValue ? (
              <Typography variant="body2" color="text.secondary">
                Manual code: <strong>{qrCodeValue}</strong>
              </Typography>
            ) : null}
          </Stack>
          {qrPayload ? (
            <Box sx={{ width: "fit-content", p: 1.5, borderRadius: 2, backgroundColor: "#fff" }}>
              <QRCodeGraphic value={qrPayload} size={180} />
            </Box>
          ) : null}
        </Stack>
      </SurfaceCard>

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "1fr", md: "repeat(3, minmax(0, 1fr))" },
          gap: 2,
        }}
      >
        {settingsCards.map((card) => (
          <SurfaceCard key={card.href}>
            <Box
              component="a"
              href={card.href}
              sx={{ color: "inherit", textDecoration: "none", display: "block" }}
            >
              <Stack spacing={1}>
                <Typography variant="h3" sx={{ fontSize: "1.125rem" }}>
                  {card.title}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {card.description}
                </Typography>
              </Stack>
            </Box>
          </SurfaceCard>
        ))}
      </Box>

      <SurfaceCard>
        <Stack spacing={2}>
          <Typography variant="h3" sx={{ fontSize: "1.125rem" }}>
            Notification preferences
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Choose which surfaces receive automation alerts and whether low-urgency replanning updates should stay on connected devices only.
          </Typography>
          {errorMessage ? (
            <Typography variant="body2" color="error.main">
              {errorMessage}
            </Typography>
          ) : null}
          {preferences ? (
            <Stack spacing={1.5}>
              <FormControlLabel
                control={
                  <Switch
                    checked={preferences.desktop_enabled}
                    onChange={(event) => void savePreferencePatch({ desktop_enabled: event.target.checked })}
                  />
                }
                label="Desktop notifications"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={preferences.browser_enabled}
                    onChange={(event) => void savePreferencePatch({ browser_enabled: event.target.checked })}
                  />
                }
                label="Browser notifications"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={preferences.mobile_push_enabled}
                    onChange={(event) => void savePreferencePatch({ mobile_push_enabled: event.target.checked })}
                  />
                }
                label="Mobile push notifications"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={preferences.connected_device_only_for_noncritical}
                    onChange={(event) =>
                      void savePreferencePatch({ connected_device_only_for_noncritical: event.target.checked })
                    }
                  />
                }
                label="Keep non-critical alerts on connected devices only"
              />
              <FormControl size="small">
                <Typography variant="body2" color="text.secondary" sx={{ mb: 0.75 }}>
                  Alert level
                </Typography>
                <Select
                  value={preferences.urgency_mode}
                  onChange={(event) =>
                    void savePreferencePatch({
                      urgency_mode: event.target.value as NotificationPreferences["urgency_mode"],
                    })
                  }
                >
                  <MenuItem value="all">All automation alerts</MenuItem>
                  <MenuItem value="important_only">Only human-review alerts</MenuItem>
                  <MenuItem value="none">Disable automation alerts</MenuItem>
                </Select>
              </FormControl>
              <Box display="flex" justifyContent="flex-start">
                <Button variant="text" disabled={saving}>
                  {saving ? "Saving…" : "Preferences saved automatically"}
                </Button>
              </Box>
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Loading notification preferences...
            </Typography>
          )}
        </Stack>
      </SurfaceCard>
    </Stack>
  );
}
