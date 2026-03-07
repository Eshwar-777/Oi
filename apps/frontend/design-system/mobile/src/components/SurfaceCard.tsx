import type { PropsWithChildren } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { View } from "react-native";
import { mobileTheme } from "../theme";

interface SurfaceCardProps extends PropsWithChildren {
  style?: StyleProp<ViewStyle>;
}

export function SurfaceCard({ children, style }: SurfaceCardProps) {
  return (
    <View
      style={[
        {
          backgroundColor: mobileTheme.colors.surface,
          borderRadius: mobileTheme.radii.md,
          borderWidth: 1,
          borderColor: mobileTheme.colors.border,
          padding: mobileTheme.spacing[4],
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
