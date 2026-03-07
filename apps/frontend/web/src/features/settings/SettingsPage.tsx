import {
  Box,
  Stack,
  Typography,
} from "@mui/material";
import {
  SectionHeader,
  SurfaceCard,
} from "@oi/design-system-web";

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
  return (
    <Stack spacing={3}>
      <SectionHeader
        eyebrow="Settings"
        title="System controls"
        description="The new UI keeps settings intentionally sparse and task-oriented: devices, mesh, and operational entry points."
      />

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
