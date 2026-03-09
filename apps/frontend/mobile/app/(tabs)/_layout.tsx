import { Redirect, Tabs } from "expo-router";
import { mobileTheme } from "@/theme";
import { useMobileAuth } from "@/features/auth/AuthContext";

const ACTIVE = mobileTheme.colors.primaryStrong;

export default function TabsLayout() {
  const { status } = useMobileAuth();

  if (status === "loading") {
    return null;
  }
  if (status !== "authenticated") {
    return <Redirect href="/(auth)/login" />;
  }

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
