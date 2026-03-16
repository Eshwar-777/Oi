import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text } from "react-native";
import { useMobileTheme } from "../MobileThemeContext";

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
  theme,
}: {
  children: ReactNode;
  loading?: boolean;
  tone: "primary" | "secondary";
  theme: ReturnType<typeof useMobileTheme>;
}) {
  if (loading) {
    return (
      <ActivityIndicator
        color={tone === "primary" ? theme.colors.primaryText : theme.colors.primary}
      />
    );
  }

  return (
    <Text
      style={{
        color: tone === "primary" ? theme.colors.primaryText : theme.colors.primary,
        fontSize: theme.typography.fontSize.sm,
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
  const theme = useMobileTheme();
  return (
    <Pressable
      disabled={disabled || loading}
      onPress={onPress}
      style={{
        minHeight: 48,
        borderRadius: theme.radii.sm,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.colors.primary,
        opacity: disabled || loading ? 0.48 : 1,
        paddingHorizontal: theme.spacing[4],
      }}
    >
      <ButtonContent loading={loading} tone="primary" theme={theme}>
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
  const theme = useMobileTheme();
  return (
    <Pressable
      disabled={disabled || loading}
      onPress={onPress}
      style={{
        minHeight: 44,
        borderRadius: theme.radii.sm,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.border,
        opacity: disabled || loading ? 0.48 : 1,
        paddingHorizontal: theme.spacing[4],
      }}
    >
      <ButtonContent loading={loading} tone="secondary" theme={theme}>
        {children}
      </ButtonContent>
    </Pressable>
  );
}
