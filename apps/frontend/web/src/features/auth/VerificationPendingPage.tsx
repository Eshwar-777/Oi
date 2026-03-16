import { Alert, Box, Button, Stack, Typography } from "@mui/material";
import { Navigate } from "react-router-dom";
import { SurfaceCard } from "@oi/design-system-web";
import { useAuth } from "./AuthContext";

export function VerificationPendingPage() {
  const {
    errorMessage,
    noticeMessage,
    pendingVerificationEmail,
    refreshVerificationStatus,
    resendVerificationEmail,
    signOut,
    status,
  } = useAuth();

  if (status === "authenticated") {
    return <Navigate to="/chat" replace />;
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
      <Box sx={{ width: "100%", maxWidth: 460, mx: "auto" }}>
        <SurfaceCard>
          <Stack spacing={2.5}>
            <Stack spacing={1}>
              <Typography variant="overline">Verification</Typography>
              <Typography variant="h3">Check your email</Typography>
              <Typography variant="body2" color="text.secondary">
                {pendingVerificationEmail
                  ? `We need to verify ${pendingVerificationEmail} before allowing access.`
                  : "We need to verify your email address before allowing access."}
              </Typography>
            </Stack>

            {errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}
            {noticeMessage ? <Alert severity="info">{noticeMessage}</Alert> : null}

            <Button variant="contained" onClick={() => void refreshVerificationStatus()}>
              I verified my email
            </Button>
            <Button variant="outlined" onClick={() => void resendVerificationEmail()}>
              Resend verification email
            </Button>
            <Button variant="text" onClick={() => void signOut()}>
              Use a different email
            </Button>
            <Typography variant="body2" color="text.secondary" sx={{ textAlign: "center" }}>
              Already verified and still blocked? Return to{" "}
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
