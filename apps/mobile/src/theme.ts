import { colors } from "@oi/theme";

export const mobileTheme = {
  colors: {
    bg: colors.neutral[50],
    surface: colors.neutral[0],
    surfaceMuted: colors.neutral[100],
    border: colors.neutral[200],
    text: colors.neutral[900],
    textMuted: colors.neutral[400],
    primary: colors.maroon[500],
    primarySoft: colors.maroon[50],
    primaryText: colors.neutral[0],
    success: colors.status.success,
    warning: colors.status.warning,
    error: colors.status.error,
  },
} as const;

