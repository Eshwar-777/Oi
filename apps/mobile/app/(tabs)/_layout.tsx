import { Tabs } from "expo-router";
import { mobileTheme } from "@/theme";

const MAROON = mobileTheme.colors.primary;

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: MAROON,
        tabBarInactiveTintColor: mobileTheme.colors.textMuted,
        tabBarStyle: {
          borderTopColor: mobileTheme.colors.border,
          backgroundColor: mobileTheme.colors.surface,
        },
        headerStyle: {
          backgroundColor: mobileTheme.colors.surface,
        },
        headerTintColor: mobileTheme.colors.text,
        headerTitleStyle: {
          fontWeight: "600",
        },
      }}
    >
      <Tabs.Screen
        name="chat"
        options={{
          title: "Chat",
          headerTitle: "Chat with OI",
        }}
      />
      <Tabs.Screen
        name="navigator"
        options={{
          title: "Navigator",
          headerTitle: "Navigator",
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          headerTitle: "Settings",
        }}
      />
    </Tabs>
  );
}
