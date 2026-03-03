import { Tabs } from "expo-router";

const MAROON = "#751636";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: MAROON,
        tabBarInactiveTintColor: "#9A8288",
        tabBarStyle: {
          borderTopColor: "#E0D0D4",
        },
        headerStyle: {
          backgroundColor: "#FFFFFF",
        },
        headerTintColor: "#1A0A10",
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
        name="tasks"
        options={{
          title: "Tasks",
          headerTitle: "Your Tasks",
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
