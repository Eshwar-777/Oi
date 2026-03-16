import { useState } from "react";
import { Alert, Box, Button, CircularProgress, Stack, TextField, Typography } from "@mui/material";
import { Navigate } from "react-router-dom";
import { SurfaceCard } from "@oi/design-system-web";
import { useAuth } from "./AuthContext";

export function ForgotPasswordPage() {
  const { errorMessage, noticeMessage, sendPasswordReset, status } = useAuth();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState("");

  if (status === "authenticated") {
    return <Navigate to="/chat" replace />;
  }

  async function onSubmit() {
    setSubmitting(true);
    setLocalError("");
    try {
      await sendPasswordReset(email.trim());
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Could not send reset email.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Box
      sx={{
        minHeight: "100dvh",
        width: "100vw",
        maxWidth: "100%",
        display: "grid",
        placeItems: "center",
        px: 2,
        py: 4,
      }}
    >
      <Box sx={{ width: "100%", maxWidth: 440, mx: "auto" }}>
        <SurfaceCard>
          <Stack component="form" spacing={2.5} onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}>
            <Stack spacing={1}>
              <Typography variant="overline">Recovery</Typography>
              <Typography variant="h3">Reset password</Typography>
              <Typography variant="body2" color="text.secondary">
                Enter your account email and we’ll send password reset instructions.
              </Typography>
            </Stack>

            {errorMessage ? <Alert severity="warning">{errorMessage}</Alert> : null}
            {noticeMessage ? <Alert severity="info">{noticeMessage}</Alert> : null}
            {localError ? <Alert severity="error">{localError}</Alert> : null}

            <TextField
              label="Email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
            />

            <Button
              type="submit"
              variant="contained"
              disabled={submitting || !email.trim()}
              startIcon={submitting ? <CircularProgress color="inherit" size={16} /> : undefined}
            >
              {submitting ? "Sending..." : "Send reset email"}
            </Button>

            <Typography variant="body2" color="text.secondary" sx={{ textAlign: "center" }}>
              Return to{" "}
              <a href="/login" style={{ color: "inherit", fontWeight: 600, textDecoration: "none" }}>
                sign in
              </a>
              .
            </Typography>
          </Stack>
        </SurfaceCard>
      </Box>
    </Box>
  );
}
