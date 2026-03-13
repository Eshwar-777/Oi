import { useEffect, useState } from "react";
import { Alert, Box, Button, Stack, Typography } from "@mui/material";
import { Navigate, useSearchParams } from "react-router-dom";
import { SurfaceCard } from "@oi/design-system-web";
import { useAuth } from "./AuthContext";

export function AuthActionPage() {
  const { completeEmailVerification, status } = useAuth();
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<"working" | "success" | "error">("working");
  const [message, setMessage] = useState("Applying your authentication action...");

  useEffect(() => {
    const mode = searchParams.get("mode") || "";
    const oobCode = searchParams.get("oobCode") || "";

    if (mode !== "verifyEmail" || !oobCode) {
      setState("error");
      setMessage("This authentication link is invalid or unsupported.");
      return;
    }

    void completeEmailVerification(oobCode)
      .then(() => {
        setState("success");
        setMessage("Email verified. You can continue into the app.");
      })
      .catch((error) => {
        setState("error");
        setMessage(error instanceof Error ? error.message : "Could not complete email verification.");
      });
  }, [completeEmailVerification, searchParams]);

  if (status === "authenticated") {
    return <Navigate to="/chat" replace />;
  }

  return (
    <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", px: 2 }}>
      <Box sx={{ width: "100%", maxWidth: 440 }}>
        <SurfaceCard>
          <Stack spacing={2.5}>
            <Stack spacing={1}>
              <Typography variant="overline">Authentication</Typography>
              <Typography variant="h3">Processing link</Typography>
            </Stack>

            {state === "working" ? <Alert severity="info">{message}</Alert> : null}
            {state === "success" ? <Alert severity="success">{message}</Alert> : null}
            {state === "error" ? <Alert severity="error">{message}</Alert> : null}

            <Button variant="contained" href={state === "success" ? "/login" : "/signup"}>
              {state === "success" ? "Continue to sign in" : "Back to account setup"}
            </Button>
          </Stack>
        </SurfaceCard>
      </Box>
    </Box>
  );
}
