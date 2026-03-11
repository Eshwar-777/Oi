import { useState } from "react";
import { Alert, Box, Button, Stack, TextField, Typography } from "@mui/material";
import { Navigate } from "react-router-dom";
import { SurfaceCard } from "@oi/design-system-web";
import { useAuth } from "./AuthContext";

export function LoginPage() {
  const { errorMessage, isBypassMode, signIn, status } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState("");

  if (status === "authenticated") {
    return <Navigate to="/chat" replace />;
  }

  async function onSubmit() {
    setSubmitting(true);
    setLocalError("");
    try {
      await signIn(email.trim(), password);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Sign in failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", px: 2 }}>
      <Box sx={{ width: "100%", maxWidth: 440 }}>
        <SurfaceCard>
          <Stack spacing={2.5}>
            <Stack spacing={1}>
              <Typography variant="overline">Web</Typography>
              <Typography variant="h3">Sign in</Typography>
            <Typography variant="body2" color="text.secondary">
              Use your Firebase account to access protected automation, device, and browser controls.
            </Typography>
          </Stack>

          {errorMessage ? <Alert severity="warning">{errorMessage}</Alert> : null}
          {localError ? <Alert severity="error">{localError}</Alert> : null}
          {isBypassMode ? <Alert severity="info">Bypass mode is enabled for local development.</Alert> : null}

          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
          />
          <TextField
            label="Password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />

          <Button
            variant="contained"
            disabled={submitting || (!isBypassMode && (!email.trim() || !password))}
            onClick={() => void onSubmit()}
          >
            Sign in
          </Button>
          <Typography variant="body2" color="text.secondary" sx={{ textAlign: "center" }}>
            Need an account?{" "}
            <a
              href="/signup"
              style={{ color: "inherit", fontWeight: 600, textDecoration: "none" }}
            >
              Create one
            </a>
          </Typography>
          </Stack>
        </SurfaceCard>
      </Box>
    </Box>
  );
}
