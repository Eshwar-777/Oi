import { colorTokens, semanticColorTokens } from "./colors";
import { radii, spacing } from "./spacing";
import { typography } from "./typography";

export const mobileTheme = {
  colors: {
    bg: semanticColorTokens.light.surfaceCanvas,
    surface: semanticColorTokens.light.surfaceCard,
    surfaceMuted: semanticColorTokens.light.surfaceCardMuted,
    border: semanticColorTokens.light.borderDefault,
    borderStrong: semanticColorTokens.light.borderStrong,
    text: semanticColorTokens.light.textPrimary,
    textMuted: semanticColorTokens.light.textSecondary,
    textSoft: semanticColorTokens.light.textTertiary,
    primary: semanticColorTokens.light.accentMain,
    primarySoft: semanticColorTokens.light.accentSoft,
    primaryStrong: semanticColorTokens.light.accentStrong,
    primaryText: semanticColorTokens.light.textInverse,
    success: colorTokens.status.success,
    warning: colorTokens.status.warning,
    error: colorTokens.status.danger,
    info: colorTokens.status.info,
  },
  radii,
  spacing,
  typography,
} as const;
