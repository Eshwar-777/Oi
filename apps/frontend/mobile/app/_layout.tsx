import { useEffect } from "react";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MobileAuthProvider } from "@/features/auth/AuthContext";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000 },
  },
});

export default function RootLayout() {
  const router = useRouter();

  useEffect(() => {
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      const route = typeof response?.notification.request.content.data?.route === "string"
        ? response.notification.request.content.data.route
        : null;
      if (route) {
        router.push(route as Parameters<typeof router.push>[0]);
      }
    });

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const route = typeof response.notification.request.content.data?.route === "string"
        ? response.notification.request.content.data.route
        : null;
      if (route) {
        router.push(route as Parameters<typeof router.push>[0]);
      }
    });

    return () => {
      subscription.remove();
    };
  }, [router]);

  return (
    <QueryClientProvider client={queryClient}>
      <MobileAuthProvider>
        <StatusBar style="dark" />
        <Stack initialRouteName="index" screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)/login" />
          <Stack.Screen name="(tabs)" />
        </Stack>
      </MobileAuthProvider>
    </QueryClientProvider>
  );
}
