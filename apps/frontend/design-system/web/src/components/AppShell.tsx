import type { ReactNode } from "react";
import {
  Box,
  ButtonBase,
  Divider,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { BrandMark } from "./BrandMark";
import { MaterialSymbol } from "./MaterialSymbol";
import { useOITheme } from "../theme/OIThemeProvider";
import { useState } from "react";

export interface AppShellNavItem {
  href: string;
  label: string;
  description: string;
  icon: "chat" | "schedule" | "settings" | "devices" | "hub";
}

interface AppShellProps {
  children: ReactNode;
  currentPath: string;
  navItems: AppShellNavItem[];
  onNavigate: (href: string) => void;
  sidebarSupplement?: ReactNode | ((args: { collapsed: boolean }) => ReactNode);
  version?: string;
}

export function AppShell({
  children,
  currentPath,
  navItems,
  onNavigate,
  sidebarSupplement,
}: AppShellProps) {
  const { mode, toggleMode } = useOITheme();
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("oi:sidebar-collapsed") === "true";
  });

  function toggleSidebar() {
    setCollapsed((current) => {
      const next = !current;
      if (typeof window !== "undefined") {
        window.localStorage.setItem("oi:sidebar-collapsed", String(next));
      }
      return next;
    });
  }

  const resolvedSidebarSupplement =
    typeof sidebarSupplement === "function" ? sidebarSupplement({ collapsed }) : sidebarSupplement;

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: { xs: "flex", md: "grid" },
        flexDirection: "column",
        gridTemplateColumns: { md: collapsed ? "84px minmax(0, 1fr)" : "236px minmax(0, 1fr)" },
      }}
    >
      <Box
        component="aside"
        sx={{
          display: "flex",
          flexDirection: "column",
          position: { xs: "sticky", md: "sticky" },
          top: 0,
          zIndex: 10,
          alignSelf: "start",
          minHeight: { md: "100vh" },
          borderRight: { md: "1px solid var(--border-subtle)" },
          borderBottom: { xs: "1px solid var(--border-subtle)", md: "none" },
          backgroundColor: "var(--surface-sidebar)",
          px: { xs: 1.5, sm: 2, md: 2 },
          py: { xs: 1.25, sm: 1.5, md: 2.5 },
        }}
      >
        <Stack spacing={{ xs: 1.25, sm: 1.5, md: 2.5 }} sx={{ flex: 1, minHeight: 0 }}>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            gap={1}
          >
            <BrandMark compact={collapsed} />
            <Tooltip title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
              <IconButton
                onClick={toggleSidebar}
                sx={{
                  display: { xs: "none", md: "inline-flex" },
                  width: 36,
                  height: 36,
                  borderRadius: "12px",
                  border: "1px solid var(--border-default)",
                  backgroundColor: "var(--surface-card)",
                  color: "var(--text-secondary)",
                  flexShrink: 0,
                }}
              >
                <MaterialSymbol
                  name={collapsed ? "chevron_right" : "chevron_left"}
                  sx={{ fontSize: 20 }}
                />
              </IconButton>
            </Tooltip>
          </Stack>
          <Stack
            direction={{ xs: "row", md: "column" }}
            spacing={1}
            useFlexGap
            flexWrap="nowrap"
            sx={{
              overflowX: { xs: "auto", md: "visible" },
              pb: { xs: 0.25, md: 0 },
              scrollbarWidth: "none",
              "&::-webkit-scrollbar": {
                display: "none",
              },
            }}
          >
            {navItems.map((item) => {
              const active = currentPath === item.href || currentPath.startsWith(`${item.href}/`);
              const content = (
                <ButtonBase
                  key={item.href}
                  onClick={() => onNavigate(item.href)}
                  sx={{
                    width: { xs: "auto", md: "100%" },
                    minWidth: { xs: "max-content", md: "unset" },
                    justifyContent: collapsed ? "center" : "flex-start",
                    textAlign: "left",
                    borderRadius: "14px",
                    px: { xs: 1.35, md: collapsed ? 1 : 1.5 },
                    py: { xs: 1, md: 1.1 },
                    border: active ? "1px solid var(--border-default)" : "1px solid transparent",
                    backgroundColor: active ? "var(--surface-card)" : "transparent",
                    "&:hover": {
                      backgroundColor: active ? "var(--surface-card)" : "rgba(255,255,255,0.28)",
                    },
                  }}
                >
                  <Stack direction="row" spacing={1.1} alignItems="center" sx={{ minWidth: 0 }}>
                    <MaterialSymbol name={item.icon} sx={{ fontSize: 20, color: active ? "var(--text-primary)" : "var(--text-secondary)" }} />
                    <Stack
                      spacing={0.2}
                      sx={{
                        display: { xs: "none", sm: collapsed ? "none" : "flex", md: collapsed ? "none" : "flex" },
                        minWidth: 0,
                      }}
                    >
                      <Tooltip title={item.description} placement="right">
                        <Typography fontWeight={700} fontSize={{ xs: 15, md: 12.5 }}>
                          {item.label}
                        </Typography>
                      </Tooltip>
                    </Stack>
                  </Stack>
                </ButtonBase>
              );

              return collapsed ? (
                <Tooltip key={item.href} title={item.label} placement="right">
                  {content}
                </Tooltip>
              ) : (
                content
              );
            })}
          </Stack>
          <Divider sx={{ display: { xs: "none", md: "block" } }} />
          {resolvedSidebarSupplement ? (
            <Box
              sx={{
                display: { xs: "none", md: "block" },
                flex: 1,
                minHeight: 0,
                overflow: "hidden",
              }}
            >
              {resolvedSidebarSupplement}
            </Box>
          ) : null}
        </Stack>
        <Box sx={{ display: "flex", justifyContent:"space-between", width: "100%" }}>
            
              <ButtonBase
                onClick={toggleMode}
                sx={{
                  width: 38,
                  height: 38,
                  borderRadius: "12px",
                  border: "1px solid var(--border-default)",
                  //backgroundColor: "var(--surface-card-muted)",
                  color: "var(--text-secondary)",
                  flexShrink: 0,
                  "&:hover": {
                    backgroundColor: "var(--surface-card-muted)",
                  },
                }}
                aria-label={mode === "light" ? "Switch to dark theme" : "Switch to light theme"}
                title={mode === "light" ? "Dark mode" : "Light mode"}
              >
                <MaterialSymbol
                  name={mode === "light" ? "dark_mode" : "light_mode"}
                  sx={{ fontSize: 18 }}
                />
              </ButtonBase>

              <ButtonBase
                onClick={() => onNavigate("/settings")}
                sx={{
                  width: 38,
                  height: 38,
                  borderRadius: "12px",
                  border: "1px solid var(--border-default)",
                  //backgroundColor: "var(--surface-card-muted)",
                  color: "var(--text-secondary)",
                  flexShrink: 0,
                  "&:hover": {
                    backgroundColor: "var(--surface-card-muted)",
                  },
                }}
              >
                <MaterialSymbol name="settings" sx={{ fontSize: 18, color: "var(--text-secondary)" }} />
              </ButtonBase>
            
          </Box>
      </Box>

      <Box component="main" sx={{ p: { xs: 1.5, sm: 2, md: 4 } }}>
        <Stack spacing={{ xs: 2, md: 2.5 }}>
          

          {children}
        </Stack>
      </Box>
    </Box>
  );
}
