import type { PropsWithChildren } from "react";
import type { ScrollViewProps, StyleProp, ViewStyle } from "react-native";
import { Platform, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMobileTheme } from "../MobileThemeContext";

interface MobileScreenProps extends PropsWithChildren {
  scrollable?: boolean;
  style?: StyleProp<ViewStyle>;
  contentContainerStyle?: ScrollViewProps["contentContainerStyle"];
}

export function MobileScreen({
  children,
  scrollable = false,
  style,
  contentContainerStyle,
}: MobileScreenProps) {
  const theme = useMobileTheme();
  if (scrollable) {
    return (
      <SafeAreaView style={[{ flex: 1, backgroundColor: theme.colors.bg }, style]}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
          contentContainerStyle={[
            { paddingHorizontal: theme.spacing[4], paddingVertical: theme.spacing[4] },
            contentContainerStyle,
          ]}
        >
          {children}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[{ flex: 1, backgroundColor: theme.colors.bg }, style]}>
      <View style={{ flex: 1, paddingHorizontal: theme.spacing[4] }}>{children}</View>
    </SafeAreaView>
  );
}
