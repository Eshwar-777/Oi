"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/chat", label: "Chat", icon: "💬" },
  { href: "/tasks", label: "Tasks", icon: "📋" },
  { href: "/settings", label: "Settings", icon: "⚙️" },
] as const;

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex h-screen bg-neutral-50">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-neutral-200 flex flex-col">
        <div className="p-6">
          <Link href="/" className="text-2xl font-bold text-maroon-500">
            OI
          </Link>
        </div>
        <nav className="flex-1 px-3">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium mb-1 transition-colors ${
                  isActive
                    ? "bg-maroon-50 text-maroon-600"
                    : "text-neutral-600 hover:bg-neutral-100"
                }`}
              >
                <span>{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-4 border-t border-neutral-200 text-xs text-neutral-400">
          OI v0.1.0
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
