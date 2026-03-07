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
        description="This surface keeps the current mesh workflow lightweight while the design system stabilizes across all clients."
      />

      <SurfaceCard
        title="Human backup is still part of the product"
        subtitle="Create a mesh group to define who can respond when navigator or automation flow hits a real-world boundary."
        actions={<Button variant="contained">Create group</Button>}
      >
        <Typography variant="body2" color="text.secondary">
          Each member should have at least one linked Oye device so prompts, approvals, and fallbacks can route reliably.
        </Typography>
      </SurfaceCard>
    </Stack>
  );
}
