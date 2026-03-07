import {
  Box,
  Button,
  Container,
  Stack,
  Typography,
} from "@mui/material";
import {
  BrandMark,
  SectionHeader,
  SurfaceCard,
} from "@oi/design-system-web";

const features = [
  {
    title: "Converse",
    description: "One place for natural chat, status checks, and task intake across every frontend surface.",
  },
  {
    title: "Automate",
    description: "Chat drives execution, scheduling, confirmation, and progress tracking in one unified interface.",
  },
  {
    title: "Mesh",
    description: "Device pairing and mesh management now sit inside a common design system instead of app-specific styling.",
  },
] as const;

const platforms = [
  { label: "Web", description: "React + MUI + TypeScript application shell" },
  { label: "Desktop", description: "Electron shell aligned to the same shared web/desktop design system" },
  { label: "Mobile", description: "Expo surfaces rebuilt on shared tokens and React Native components" },
] as const;

export function LandingPage() {
  return (
    <Box sx={{ minHeight: "100vh", py: { xs: 3, md: 4 } }}>
      <Container maxWidth="lg">
        <Stack spacing={{ xs: 6, md: 9 }}>
          <Stack
            direction={{ xs: "column", md: "row" }}
            alignItems={{ xs: "flex-start", md: "center" }}
            justifyContent="space-between"
            gap={3}
          >
            <BrandMark />
            <Stack direction="row" spacing={1.5}>
              <Button href="/chat" variant="outlined" color="primary">
                Open app
              </Button>
              <Button href="/settings/devices" variant="contained" color="primary">
                Pair devices
              </Button>
            </Stack>
          </Stack>

          <Box
            sx={{
              position: "relative",
              overflow: "hidden",
              borderRadius: "32px",
              border: "1px solid var(--border-subtle)",
              background:
                "linear-gradient(135deg, rgba(255,255,255,0.72) 0%, rgba(244,244,242,0.92) 100%)",
              px: { xs: 3, md: 6 },
              py: { xs: 5, md: 7 },
            }}
          >
            <Stack spacing={4} maxWidth={840}>
              <SectionHeader
                eyebrow="OI Frontend"
                title="A single frontend foundation for web, desktop, and mobile."
                description="The UI now pivots away from maroon-heavy Tailwind styling toward a token-first system built for React, MUI, Electron, and React Native."
              />
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                <Button href="/chat" variant="contained" color="primary">
                  Launch chat
                </Button>
              </Stack>
            </Stack>
          </Box>

          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", md: "repeat(3, minmax(0, 1fr))" },
              gap: 2,
            }}
          >
            {features.map((feature) => (
              <SurfaceCard key={feature.title} eyebrow="Capability" title={feature.title}>
                <Typography variant="body2" color="text.secondary">
                  {feature.description}
                </Typography>
              </SurfaceCard>
            ))}
          </Box>

      <SurfaceCard
        eyebrow="Architecture shift"
        title="Frontend packages"
        subtitle="Each app now sits under apps/frontend/ with a shared design-system split by platform."
      >
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", md: "repeat(3, minmax(0, 1fr))" },
                gap: 2,
              }}
            >
              {platforms.map((platform) => (
                <Box
                  key={platform.label}
                  sx={{
                    p: 2.5,
                    borderRadius: "20px",
                    border: "1px solid var(--border-subtle)",
                    backgroundColor: "var(--surface-card-muted)",
                  }}
                >
                  <Typography variant="h3" sx={{ fontSize: "1.1rem", mb: 1 }}>
                    {platform.label}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {platform.description}
                  </Typography>
                </Box>
              ))}
            </Box>
          </SurfaceCard>
        </Stack>
      </Container>
    </Box>
  );
}
