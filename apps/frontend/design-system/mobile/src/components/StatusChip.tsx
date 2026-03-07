import { Text, View } from "react-native";
import { mobileTheme } from "../theme";

type StatusTone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

const toneStyles: Record<StatusTone, { bg: string; fg: string }> = {
  neutral: { bg: mobileTheme.colors.surfaceMuted, fg: mobileTheme.colors.textMuted },
  brand: { bg: mobileTheme.colors.primarySoft, fg: mobileTheme.colors.primaryStrong },
  success: { bg: "rgba(47, 107, 79, 0.12)", fg: mobileTheme.colors.success },
  warning: { bg: "rgba(138, 106, 47, 0.12)", fg: mobileTheme.colors.warning },
  danger: { bg: "rgba(138, 58, 58, 0.12)", fg: mobileTheme.colors.error },
  info: { bg: "rgba(47, 95, 122, 0.12)", fg: mobileTheme.colors.info },
};

interface StatusChipProps {
  label: string;
  tone?: StatusTone;
}

export function StatusChip({ label, tone = "neutral" }: StatusChipProps) {
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
          fontSize: mobileTheme.typography.fontSize.xs,
          fontWeight: "700",
          textTransform: "uppercase",
        }}
      >
        {label}
      </Text>
    </View>
  );
}
