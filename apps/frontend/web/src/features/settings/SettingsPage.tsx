import {
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
import {
  SectionHeader,
  SurfaceCard,
} from "@oi/design-system-web";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/features/auth/AuthContext";
import type { NotificationPreferences } from "@/domain/automation";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from "@/api/notificationPreferences";

const settingsCards = [
  {
    href: "/sessions",
    title: "Live sessions",
    description: "Open browser sessions, step in when needed, and hand work back to Oye.",
  },
  {
    href: "/settings/devices",
    title: "Devices",
    description: "Connect and manage web, desktop, and mobile devices from one place.",
  },
  {
    href: "/settings/mesh",
    title: "Mesh groups",
    description: "Set up backup people who can step in when Oye needs help.",
  },
  {
    href: "/chat",
    title: "Conversation",
    description: "Go back to the main workspace and continue the conversation.",
  },
] as const;

export function SettingsPage() {
  const navigate = useNavigate();
  const { isBypassMode, needsEmailVerification, signOut, user } = useAuth();
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const userEmail = user?.email || "Authenticated user";
  const userUid = user?.uid || "Unknown";
  const authModeLabel = isBypassMode ? "Local bypass" : "Firebase";
  const verificationLabel = isBypassMode ? "Bypassed" : needsEmailVerification ? "Pending" : "Verified";
  const initials = (userEmail[0] || "O").slice(0, 1).toUpperCase();

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

  return (
    <Stack spacing={3}>
      <SectionHeader
        eyebrow="Settings"
        title="Workspace settings"
        description="Manage devices, backups, and alerts without leaving the main workspace."
      />

      <SurfaceCard>
        <Stack direction={{ xs: "column", md: "row" }} spacing={2} justifyContent="space-between" alignItems={{ xs: "flex-start", md: "center" }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Box
              sx={{
                width: 44,
                height: 44,
                borderRadius: "999px",
                display: "grid",
                placeItems: "center",
                backgroundColor: "rgba(125, 88, 63, 0.12)",
                color: "var(--text-primary)",
                fontWeight: 700,
              }}
            >
              {initials}
            </Box>
            <Stack spacing={0.4}>
              <Typography variant="body2" color="text.secondary">
                User details
              </Typography>
              <Typography variant="h3" sx={{ fontSize: "1rem" }}>
                {userEmail}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                UID: {userUid}
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Typography variant="caption" sx={{ px: 1, py: 0.35, borderRadius: "999px", backgroundColor: "var(--surface-card-muted)" }}>
                  {authModeLabel}
                </Typography>
                <Typography variant="caption" sx={{ px: 1, py: 0.35, borderRadius: "999px", backgroundColor: "var(--surface-card-muted)" }}>
                  {verificationLabel}
                </Typography>
              </Stack>
            </Stack>
          </Stack>
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
            Choose where alerts appear and whether low-priority updates stay on active devices only.
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
                label="Desktop alerts"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={preferences.browser_enabled}
                    onChange={(event) => void savePreferencePatch({ browser_enabled: event.target.checked })}
                  />
                }
                label="Browser alerts"
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={preferences.mobile_push_enabled}
                    onChange={(event) => void savePreferencePatch({ mobile_push_enabled: event.target.checked })}
                  />
                }
                label="Mobile alerts"
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
                label="Keep low-priority alerts on active devices only"
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
