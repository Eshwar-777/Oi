import { Button, Stack, Typography } from "@mui/material";
import { SectionHeader, SurfaceCard } from "@oi/design-system-web";

export function MeshPage() {
  return (
    <Stack spacing={3}>
      <Button href="/settings" variant="text" sx={{ alignSelf: "flex-start", px: 0 }}>
        Back to settings
      </Button>

      <SectionHeader
        eyebrow="Mesh"
        title="Mesh groups"
        description="Set up the people Oye can reach when a task needs human help."
      />

      <SurfaceCard
        title="Keep a human backup path ready"
        subtitle="Create a group that can respond when a live task reaches a real-world boundary."
        actions={<Button variant="contained">Create group</Button>}
      >
        <Typography variant="body2" color="text.secondary">
          Each member should have at least one linked Oye device so prompts, approvals, and follow-up requests reach them reliably.
        </Typography>
      </SurfaceCard>
    </Stack>
  );
}
