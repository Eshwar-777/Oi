import type { ReactNode } from "react";
import { Stack, Typography } from "@mui/material";

interface SectionHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  align?: "left" | "center";
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  align = "left",
}: SectionHeaderProps) {
  return (
    <Stack
      spacing={1.25}
      alignItems={align === "center" ? "center" : "flex-start"}
      textAlign={align}
    >
      {eyebrow ? (
        <Typography variant="overline" color="text.secondary" sx={{ opacity: 0.9 }}>
          {eyebrow}
        </Typography>
      ) : null}
      <Typography variant="h2">{title}</Typography>
      {description ? (
        <Typography variant="body1" color="text.secondary" maxWidth={760}>
          {description}
        </Typography>
      ) : null}
    </Stack>
  );
}
