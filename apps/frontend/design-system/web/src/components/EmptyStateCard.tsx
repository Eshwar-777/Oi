import type { ReactNode } from "react";
import { Stack, Typography } from "@mui/material";
import { SurfaceCard } from "./SurfaceCard";

interface EmptyStateCardProps {
  title: ReactNode;
  description: ReactNode;
  action?: ReactNode;
}

export function EmptyStateCard({
  title,
  description,
  action,
}: EmptyStateCardProps) {
  return (
    <SurfaceCard>
      <Stack spacing={1.5} alignItems="flex-start">
        <Typography variant="h3">{title}</Typography>
        <Typography variant="body2" color="text.secondary">
          {description}
        </Typography>
        {action}
      </Stack>
    </SurfaceCard>
  );
}
