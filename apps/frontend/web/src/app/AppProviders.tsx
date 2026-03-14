import { useEffect, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OIThemeProvider } from "@oi/design-system-web";
import { AuthProvider } from "@/features/auth/AuthContext";
import { emitApiError, getErrorMessage } from "@/lib/apiErrors";
import { ensureDesktopDeviceRegistered, setupDesktopPresenceLifecycle } from "@/lib/desktopRegistration";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  },
});

interface AppProvidersProps {
  children: ReactNode;
}

export function AppProviders({ children }: AppProvidersProps) {
  useEffect(() => {
    let cleanup = () => {};
    void ensureDesktopDeviceRegistered()
      .then((registration) => {
        cleanup = setupDesktopPresenceLifecycle(registration);
      })
      .catch((error) => {
        emitApiError(getErrorMessage(error, "Desktop device registration failed."));
      });
    return () => {
      cleanup();
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <OIThemeProvider>{children}</OIThemeProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
