import {
  Alert,
  Button,
  Box,
  Stack,
  Typography,
} from "@mui/material";
import { useState } from "react";
import QRCode from "react-qr-code";
import {
  SectionHeader,
  SurfaceCard,
} from "@oi/design-system-web";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/features/auth/AuthContext";
import { authFetch } from "@/api/authFetch";

const settingsCards = [
  {
    href: "/settings/devices",
    title: "Devices",
    description: "Pair and manage the web, desktop, mobile, and extension clients from one place.",
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
              <QRCode value={qrPayload} size={180} />
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
    </Stack>
  );
}
