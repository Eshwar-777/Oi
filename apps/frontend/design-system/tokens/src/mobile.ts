import { colorTokens, semanticColorTokens } from "./colors";
import { radii, spacing } from "./spacing";
import { typography } from "./typography";

export type MobileThemeMode = "light" | "dark";

function buildMobileTheme(mode: MobileThemeMode) {
  const c = semanticColorTokens[mode];
  return {
    colors: {
      bg: c.surfaceCanvas,
      surface: c.surfaceCard,
      surfaceMuted: c.surfaceCardMuted,
      border: c.borderDefault,
      borderStrong: c.borderStrong,
      text: c.textPrimary,
      textMuted: c.textSecondary,
      textSoft: c.textTertiary,
      primary: c.accentMain,
      primarySoft: c.accentSoft,
      primaryStrong: c.accentStrong,
      primaryText: c.textInverse,
      success: colorTokens.status.success,
      warning: colorTokens.status.warning,
      error: colorTokens.status.danger,
      info: colorTokens.status.info,
    },
    radii,
    spacing,
    typography,
  } as const;
}

export function getMobileTheme(mode: MobileThemeMode) {
  return buildMobileTheme(mode);
}

/** Default theme (light). Use getMobileTheme(mode) for dark. */
export const mobileTheme = buildMobileTheme("light");
