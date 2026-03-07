import type { PropsWithChildren } from "react";
import type { ScrollViewProps, StyleProp, ViewStyle } from "react-native";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { mobileTheme } from "../theme";

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
  if (scrollable) {
    return (
      <SafeAreaView style={[{ flex: 1, backgroundColor: mobileTheme.colors.bg }, style]}>
        <ScrollView
          contentContainerStyle={[
            { paddingHorizontal: mobileTheme.spacing[4], paddingVertical: mobileTheme.spacing[4] },
            contentContainerStyle,
          ]}
        >
          {children}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[{ flex: 1, backgroundColor: mobileTheme.colors.bg }, style]}>
      <View style={{ flex: 1, paddingHorizontal: mobileTheme.spacing[4] }}>{children}</View>
    </SafeAreaView>
  );
}
