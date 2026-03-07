import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { mobileTheme } from "../theme";

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
  return (
    <View style={{ gap: 6 }}>
      {eyebrow ? (
        <Text
          style={{
            fontSize: mobileTheme.typography.fontSize.xs,
            letterSpacing: 1.2,
            color: mobileTheme.colors.textSoft,
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
          color: mobileTheme.colors.text,
          fontWeight: "700",
        }}
      >
        {title}
      </Text>
      {description ? (
        <Text
          style={{
            fontSize: mobileTheme.typography.fontSize.sm,
            lineHeight: 20,
            color: mobileTheme.colors.textMuted,
          }}
        >
          {description}
        </Text>
      ) : null}
    </View>
  );
}
