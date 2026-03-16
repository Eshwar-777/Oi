import { Text, View } from "react-native";
import { useMobileTheme } from "../MobileThemeContext";

type StatusTone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

function getToneStyles(theme: ReturnType<typeof useMobileTheme>): Record<StatusTone, { bg: string; fg: string }> {
  return {
    neutral: { bg: theme.colors.surfaceMuted, fg: theme.colors.textMuted },
    brand: { bg: theme.colors.primarySoft, fg: theme.colors.primaryStrong },
    success: { bg: "rgba(47, 107, 79, 0.12)", fg: theme.colors.success },
    warning: { bg: "rgba(138, 106, 47, 0.12)", fg: theme.colors.warning },
    danger: { bg: "rgba(138, 58, 58, 0.12)", fg: theme.colors.error },
    info: { bg: "rgba(47, 95, 122, 0.12)", fg: theme.colors.info },
  };
}

interface StatusChipProps {
  label: string;
  tone?: StatusTone;
}

export function StatusChip({ label, tone = "neutral" }: StatusChipProps) {
  const theme = useMobileTheme();
  const toneStyles = getToneStyles(theme);
  return (
    <View
      style={{
        alignSelf: "flex-start",
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 6,
        backgroundColor: toneStyles[tone].bg,
      }}
    >
      <Text
        style={{
          color: toneStyles[tone].fg,
          fontSize: theme.typography.fontSize.xs,
          fontWeight: "700",
          textTransform: "uppercase",
        }}
      >
        {label}
      </Text>
    </View>
  );
}
