import { useEffect } from "react";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMobileAuth } from "@/features/auth/AuthContext";
import { MobileAuthProvider } from "@/features/auth/AuthContext";
import { MobileAssistantProvider, useMobileAssistant, type NotificationContext } from "@/features/assistant/MobileAssistantContext";
import { ensureMobilePushDeviceRegistration } from "@/lib/mobilePushRegistration";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 5_000 },
  },
});

function normalizeNotificationRoute(data: Record<string, unknown>): string | null {
  const rawRoute = typeof data.route === "string" ? data.route : "";
  const runId = typeof data.run_id === "string" ? data.run_id : "";
  const browserSessionId = typeof data.browser_session_id === "string" ? data.browser_session_id : "";
  const conversationId = typeof data.conversation_id === "string" ? data.conversation_id : "";

  if (rawRoute) {
    const normalized = new URL(rawRoute, "https://oi.local");
    if (normalized.pathname === "/sessions") {
      const search = new URLSearchParams(normalized.search);
      return `/(tabs)/navigator?${new URLSearchParams({
        ...(search.get("session_id") ? { session_id: search.get("session_id") as string } : {}),
        ...(search.get("run_id") ? { run_id: search.get("run_id") as string } : {}),
      }).toString()}`;
    }
    if (normalized.pathname === "/chat") {
      const search = new URLSearchParams(normalized.search);
      return `/(tabs)/chat?${new URLSearchParams({
        ...(search.get("conversation_id") ? { conversation_id: search.get("conversation_id") as string } : {}),
        ...(search.get("run_id") ? { run_id: search.get("run_id") as string } : {}),
        ...(search.get("session_id") ? { session_id: search.get("session_id") as string } : {}),
      }).toString()}`;
    }
    if (normalized.pathname === "/schedules") {
      return "/(tabs)/schedules";
    }
    return rawRoute;
  }

  if (browserSessionId) {
    return `/(tabs)/navigator?${new URLSearchParams({
      ...(browserSessionId ? { session_id: browserSessionId } : {}),
      ...(runId ? { run_id: runId } : {}),
    }).toString()}`;
  }

  if (runId) {
    return `/(tabs)/chat?${new URLSearchParams({
      ...(conversationId ? { conversation_id: conversationId } : {}),
      run_id: runId,
    }).toString()}`;
  }

  return null;
}

function buildNotificationContext(data: Record<string, unknown>, route: string | null): NotificationContext | null {
  const runId = typeof data.run_id === "string" ? data.run_id : "";
  const browserSessionId = typeof data.browser_session_id === "string" ? data.browser_session_id : "";
  const eventType = typeof data.event_type === "string" ? data.event_type : "";
  const reasonCode = typeof data.reason_code === "string" ? data.reason_code : "";
  const incidentCode = typeof data.incident_code === "string" ? data.incident_code : "";

  if (!route && !runId && !browserSessionId && !eventType && !reasonCode && !incidentCode) {
    return null;
  }

  return {
    route,
    runId: runId || null,
    browserSessionId: browserSessionId || null,
    eventType: eventType || null,
    reasonCode: reasonCode || null,
    incidentCode: incidentCode || null,
    receivedAt: new Date().toISOString(),
  };
}

function NotificationRouter() {
  const router = useRouter();
  const { setNotificationContext } = useMobileAssistant();

  useEffect(() => {
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      const payload =
        response?.notification.request.content.data &&
        typeof response.notification.request.content.data === "object"
          ? response.notification.request.content.data as Record<string, unknown>
          : {};
      const route = normalizeNotificationRoute(payload);
      const context = buildNotificationContext(payload, route);
      if (context) {
        setNotificationContext(context);
      }
      if (route) {
        router.push(route as Parameters<typeof router.push>[0]);
      }
    });

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const payload =
        response.notification.request.content.data &&
        typeof response.notification.request.content.data === "object"
          ? response.notification.request.content.data as Record<string, unknown>
          : {};
      const route = normalizeNotificationRoute(payload);
      const context = buildNotificationContext(payload, route);
      if (context) {
        setNotificationContext(context);
      }
      if (route) {
        router.push(route as Parameters<typeof router.push>[0]);
      }
    });

    return () => {
      subscription.remove();
    };
  }, [router, setNotificationContext]);

  return null;
}

function MobilePushBootstrap() {
  const { status, user } = useMobileAuth();

  useEffect(() => {
    if (status !== "authenticated") return;
    void ensureMobilePushDeviceRegistration({
      deviceName: user?.email ? `${user.email.split("@")[0]}'s phone` : undefined,
    }).catch(() => undefined);
  }, [status, user?.email]);

  return null;
}

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <MobileAuthProvider>
        <MobileAssistantProvider>
          <MobilePushBootstrap />
          <NotificationRouter />
          <StatusBar style="dark" />
          <Stack initialRouteName="index" screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="(auth)/login" />
            <Stack.Screen name="(tabs)" />
          </Stack>
        </MobileAssistantProvider>
      </MobileAuthProvider>
    </QueryClientProvider>
  );
}
