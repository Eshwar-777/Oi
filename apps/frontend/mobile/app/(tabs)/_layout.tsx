import { Tabs } from "expo-router";
import { mobileTheme } from "@/theme";

const ACTIVE = mobileTheme.colors.primaryStrong;

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: ACTIVE,
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
