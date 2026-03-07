import type { ReactNode } from "react";
import { Chip } from "@mui/material";

type StatusTone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

const toneStyles: Record<StatusTone, { bg: string; fg: string }> = {
  neutral: { bg: "var(--surface-card-muted)", fg: "var(--text-secondary)" },
  brand: { bg: "var(--c-brand-100)", fg: "var(--c-brand-700)" },
  success: { bg: "rgba(47, 107, 79, 0.12)", fg: "var(--c-success-600)" },
  warning: { bg: "rgba(138, 106, 47, 0.12)", fg: "var(--c-warning-600)" },
  danger: { bg: "rgba(138, 58, 58, 0.12)", fg: "var(--c-danger-600)" },
  info: { bg: "rgba(47, 95, 122, 0.12)", fg: "var(--c-info-600)" },
};

interface StatusPillProps {
  label: ReactNode;
  tone?: StatusTone;
}

export function StatusPill({ label, tone = "neutral" }: StatusPillProps) {
  return (
    <Chip
      label={label}
      size="small"
      sx={{
        backgroundColor: toneStyles[tone].bg,
        color: toneStyles[tone].fg,
        borderRadius: "999px",
      }}
    />
  );
}
