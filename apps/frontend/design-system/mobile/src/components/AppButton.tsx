import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text } from "react-native";
import { mobileTheme } from "../theme";

interface AppButtonProps {
  children: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
}

function ButtonContent({
  children,
  loading,
  tone,
}: {
  children: ReactNode;
  loading?: boolean;
  tone: "primary" | "secondary";
}) {
  if (loading) {
    return (
      <ActivityIndicator
        color={tone === "primary" ? mobileTheme.colors.primaryText : mobileTheme.colors.primary}
      />
    );
  }

  return (
    <Text
      style={{
        color: tone === "primary" ? mobileTheme.colors.primaryText : mobileTheme.colors.primary,
        fontSize: mobileTheme.typography.fontSize.sm,
        fontWeight: "700",
      }}
    >
      {children}
    </Text>
  );
}

export function PrimaryButton({
  children,
  onPress,
  disabled,
  loading,
}: AppButtonProps) {
  return (
    <Pressable
      disabled={disabled || loading}
      onPress={onPress}
      style={{
        minHeight: 48,
        borderRadius: mobileTheme.radii.sm,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: mobileTheme.colors.primary,
        opacity: disabled || loading ? 0.48 : 1,
        paddingHorizontal: mobileTheme.spacing[4],
      }}
    >
      <ButtonContent loading={loading} tone="primary">
        {children}
      </ButtonContent>
    </Pressable>
  );
}

export function SecondaryButton({
  children,
  onPress,
  disabled,
  loading,
}: AppButtonProps) {
  return (
    <Pressable
      disabled={disabled || loading}
      onPress={onPress}
      style={{
        minHeight: 44,
        borderRadius: mobileTheme.radii.sm,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: mobileTheme.colors.surface,
        borderWidth: 1,
        borderColor: mobileTheme.colors.border,
        opacity: disabled || loading ? 0.48 : 1,
        paddingHorizontal: mobileTheme.spacing[4],
      }}
    >
      <ButtonContent loading={loading} tone="secondary">
        {children}
      </ButtonContent>
    </Pressable>
  );
}
