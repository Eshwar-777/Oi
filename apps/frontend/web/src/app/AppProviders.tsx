import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OIThemeProvider } from "@oi/design-system-web";
import { AssistantProvider } from "@/features/assistant/AssistantContext";

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
  return (
    <QueryClientProvider client={queryClient}>
      <OIThemeProvider>
        <AssistantProvider>{children}</AssistantProvider>
      </OIThemeProvider>
    </QueryClientProvider>
  );
}
