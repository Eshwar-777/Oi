import { AppShell } from "@oi/design-system-web";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { ChatSidebarRecents } from "@/features/chat/ChatSidebarRecents";

const navItems = [
  { href: "/chat", label: "Chat", description: "Conversations, runs, and operator controls", icon: "chat" as const },
  { href: "/sessions", label: "Sessions", description: "Runner, browser, and takeover state", icon: "devices" as const },
  { href: "/schedules", label: "Schedules", description: "Future runs and recurring automation", icon: "schedule" as const },
];

const RoutedOutlet = Outlet as unknown as () => JSX.Element | null;

export function AppFrame() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <AppShell
      currentPath={location.pathname}
      navItems={navItems}
      onNavigate={(href) => navigate(href)}
      sidebarSupplement={
        location.pathname.startsWith("/chat")
          ? ({ collapsed }) => <ChatSidebarRecents collapsed={collapsed} />
          : undefined
      }
    >
      <RoutedOutlet />
    </AppShell>
  );
}
