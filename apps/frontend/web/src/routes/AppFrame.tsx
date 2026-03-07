import { AppShell } from "@oi/design-system-web";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

const navItems = [
  { href: "/chat", label: "Chat", description: "Conversation and task intake", icon: "chat" as const },
  { href: "/schedules", label: "Schedules", description: "Upcoming events created from chat", icon: "schedule" as const },
  { href: "/settings", label: "Settings", description: "Devices, mesh, and account controls", icon: "settings" as const },
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
    >
      <RoutedOutlet />
    </AppShell>
  );
}
