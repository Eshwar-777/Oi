import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useMobileTheme } from "../MobileThemeContext";

interface SectionHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
}

export function SectionHeader({
  eyebrow,
  title,
  description,
}: SectionHeaderProps) {
  const theme = useMobileTheme();
  return (
    <View style={{ gap: 6 }}>
      {eyebrow ? (
        <Text
          style={{
            fontSize: theme.typography.fontSize.xs,
            letterSpacing: 1.2,
            color: theme.colors.textSoft,
            fontWeight: "700",
            textTransform: "uppercase",
          }}
        >
          {eyebrow}
        </Text>
      ) : null}
      <Text
        style={{
          fontSize: 28,
          lineHeight: 32,
          color: theme.colors.text,
          fontWeight: "700",
        }}
      >
        {title}
      </Text>
      {description ? (
        <Text
          style={{
            fontSize: theme.typography.fontSize.sm,
            lineHeight: 20,
            color: theme.colors.textMuted,
          }}
        >
          {description}
        </Text>
      ) : null}
    </View>
  );
}
