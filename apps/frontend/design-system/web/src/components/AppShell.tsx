import type { ReactNode } from "react";
import {
  Box,
  ButtonBase,
  Divider,
  IconButton,
  Stack,
  Tooltip,
  Typography,
  useMediaQuery,
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
  const isCompactLayout = useMediaQuery("(max-width: 780px)");
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
        display: isCompactLayout ? "flex" : "grid",
        flexDirection: isCompactLayout ? "column" : undefined,
        gridTemplateColumns: isCompactLayout ? undefined : collapsed ? "84px minmax(0, 1fr)" : "236px minmax(0, 1fr)",
      }}
    >
      <Box
        component="aside"
        sx={{
          display: "flex",
          flexDirection: "column",
          position: "sticky",
          top: 0,
          zIndex: 10,
          alignSelf: "start",
          width: "100%",
          minHeight: isCompactLayout ? undefined : "100vh",
          height: isCompactLayout ? undefined : "100vh",
          overflow: "hidden",
          borderRight: isCompactLayout ? "none" : "1px solid var(--border-subtle)",
          borderBottom: isCompactLayout ? "1px solid var(--border-subtle)" : "none",
          backgroundColor: "var(--surface-sidebar)",
          px: isCompactLayout ? { xs: 1.5, sm: 2 } : 2,
          py: isCompactLayout ? { xs: 1.25, sm: 1.5 } : 2.5,
          boxShadow: isCompactLayout ? "0 10px 28px rgba(50, 43, 32, 0.08)" : "none",
        }}
      >
        <Stack spacing={isCompactLayout ? { xs: 1.25, sm: 1.5 } : 2.5} sx={{ flex: 1, minHeight: 0, height: "100%" }}>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            gap={1}
            sx={{ minWidth: 0 }}
          >
            <BrandMark compact={collapsed} />
            <Tooltip title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
              <IconButton
                onClick={toggleSidebar}
                sx={{
                  display: isCompactLayout ? "none" : "inline-flex",
                  width: 36,
                  height: 36,
                  borderRadius: "12px",
                  border: "1px solid var(--border-default)",
                  backgroundColor: "var(--surface-card)",
                  color: "var(--text-secondary)",
                  flexShrink: 0,
                  transition: "transform 180ms ease, background-color 180ms ease, border-color 180ms ease",
                  "&:hover": {
                    transform: "translateY(-1px)",
                  },
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
            direction={isCompactLayout ? "row" : "column"}
            spacing={1}
            useFlexGap
            flexWrap="nowrap"
            sx={{
              alignSelf: isCompactLayout ? "flex-start" : "stretch",
              overflowX: isCompactLayout ? "auto" : "visible",
              p: isCompactLayout ? 0.5 : 0,
              borderRadius: isCompactLayout ? "18px" : 0,
              border: isCompactLayout ? "1px solid var(--border-subtle)" : "none",
              backgroundColor: isCompactLayout ? "rgba(255,255,255,0.46)" : "transparent",
              pb: isCompactLayout ? 0.25 : 0,
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
                    width: isCompactLayout ? "auto" : "100%",
                    minWidth: isCompactLayout ? "max-content" : "unset",
                    justifyContent: collapsed ? "center" : "flex-start",
                    textAlign: "left",
                    borderRadius: "14px",
                    px: isCompactLayout ? 1.2 : collapsed ? 1 : 1.5,
                    py: isCompactLayout ? 0.9 : 1.1,
                    border: active ? "1px solid var(--border-default)" : "1px solid transparent",
                    backgroundColor: active ? "var(--surface-card)" : "transparent",
                    transition: "transform 180ms ease, background-color 180ms ease, border-color 180ms ease, box-shadow 180ms ease",
                    boxShadow: active ? "0 10px 18px rgba(50, 43, 32, 0.08)" : "none",
                    "&:hover": {
                      backgroundColor: active ? "var(--surface-card)" : "rgba(255,255,255,0.28)",
                      transform: "translateY(-1px)",
                    },
                  }}
                >
                  <Stack direction="row" spacing={1.1} alignItems="center" sx={{ minWidth: 0 }}>
                    <MaterialSymbol name={item.icon} sx={{ fontSize: 20, color: active ? "var(--text-primary)" : "var(--text-secondary)" }} />
                    <Stack
                      spacing={0.2}
                      sx={{
                        display: isCompactLayout ? "none" : collapsed ? "none" : "flex",
                        minWidth: 0,
                      }}
                    >
                      <Tooltip title={item.description} placement="right">
                        <Typography fontWeight={700} fontSize={isCompactLayout ? 15 : 12.5}>
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
          <Divider sx={{ display: isCompactLayout ? "none" : "block" }} />
          {resolvedSidebarSupplement ? (
            <Box
              sx={{
                display: "block",
                flex: 1,
                minHeight: 0,
                overflow: "hidden",
                pt: isCompactLayout ? 0.5 : 0,
              }}
            >
              {resolvedSidebarSupplement}
            </Box>
          ) : null}
        </Stack>
        <Box
          sx={{
            display: "flex",
            justifyContent:"space-between",
            width: "100%",
            pt: isCompactLayout ? 1 : 0,
            mt: isCompactLayout ? 0.25 : 0,
          }}
        >
              <ButtonBase
                onClick={toggleMode}
                sx={{
                  width: 38,
                  height: 38,
                  borderRadius: "12px",
                  border: "1px solid var(--border-default)",
                  backgroundColor: isCompactLayout ? "rgba(255,255,255,0.5)" : "transparent",
                  color: "var(--text-secondary)",
                  flexShrink: 0,
                  transition: "transform 180ms ease, background-color 180ms ease",
                  "&:hover": {
                    backgroundColor: "var(--surface-card-muted)",
                    transform: "translateY(-1px)",
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
                  backgroundColor: isCompactLayout ? "rgba(255,255,255,0.5)" : "transparent",
                  color: "var(--text-secondary)",
                  flexShrink: 0,
                  transition: "transform 180ms ease, background-color 180ms ease",
                  "&:hover": {
                    backgroundColor: "var(--surface-card-muted)",
                    transform: "translateY(-1px)",
                  },
                }}
              >
                <MaterialSymbol name="settings" sx={{ fontSize: 18, color: "var(--text-secondary)" }} />
              </ButtonBase>
            
          </Box>
      </Box>

      <Box component="main" sx={{ p: isCompactLayout ? { xs: 1.25, sm: 2 } : 4, minWidth: 0 }}>
        <Stack spacing={isCompactLayout ? 2 : 2.5}>
          

          {children}
        </Stack>
      </Box>
    </Box>
  );
}
