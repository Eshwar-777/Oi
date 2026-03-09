import { AppShell } from "@oi/design-system-web";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

const navItems = [
  { href: "/chat", label: "Chat", description: "Launch runs, draft flows, and shape automations", icon: "chat" as const },
  { href: "/schedules", label: "Schedules", description: "Review upcoming runs, repeats, and queued work", icon: "schedule" as const },
  { href: "/settings", label: "Settings", description: "Manage devices, mesh links, and account setup", icon: "settings" as const },
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
