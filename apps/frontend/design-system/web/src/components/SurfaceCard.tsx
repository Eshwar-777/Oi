import type { PropsWithChildren, ReactNode } from "react";
import { Paper, Stack, Typography } from "@mui/material";

interface SurfaceCardProps extends PropsWithChildren {
  eyebrow?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

export function SurfaceCard({
  children,
  eyebrow,
  title,
  subtitle,
  actions,
}: SurfaceCardProps) {
  return (
    <Paper
      sx={{
        p: { xs: 2.75, md: 3 },
        borderRadius: "18px",
        backgroundColor: "var(--surface-card)",
      }}
    >
      {(eyebrow || title || subtitle || actions) ? (
        <Stack
          direction={{ xs: "column", md: "row" }}
          justifyContent="space-between"
          alignItems={{ xs: "flex-start", md: "center" }}
          gap={1.75}
          mb={children ? 2.5 : 0}
        >
          <Stack gap={0.75}>
            {eyebrow ? (
              <Typography variant="overline" color="text.secondary" sx={{ opacity: 0.88 }}>
                {eyebrow}
              </Typography>
            ) : null}
            {title ? <Typography variant="h3">{title}</Typography> : null}
            {subtitle ? (
              <Typography variant="body2" color="text.secondary">
                {subtitle}
              </Typography>
            ) : null}
          </Stack>
          {actions}
        </Stack>
      ) : null}
      {children}
    </Paper>
  );
}
