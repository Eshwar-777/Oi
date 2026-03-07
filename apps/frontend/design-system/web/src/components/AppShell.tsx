import type { ReactNode } from "react";
import {
  Box,
  ButtonBase,
  Divider,
  Stack,
  Typography,
} from "@mui/material";
import { BrandMark } from "./BrandMark";
import { useOITheme } from "../theme/OIThemeProvider";

export interface AppShellNavItem {
  href: string;
  label: string;
  description: string;
}

interface AppShellProps {
  children: ReactNode;
  currentPath: string;
  navItems: AppShellNavItem[];
  onNavigate: (href: string) => void;
  version?: string;
}

export function AppShell({
  children,
  currentPath,
  navItems,
  onNavigate,
  version = "Frontend rebuild",
}: AppShellProps) {
  const { mode, toggleMode } = useOITheme();

  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: { xs: "flex", md: "grid" },
        flexDirection: "column",
        gridTemplateColumns: { md: "236px minmax(0, 1fr)" },
      }}
    >
      <Box
        component="aside"
        sx={{
          position: { xs: "sticky", md: "sticky" },
          top: 0,
          zIndex: 10,
          alignSelf: "start",
          minHeight: { md: "100vh" },
          borderRight: { md: "1px solid var(--border-subtle)" },
          borderBottom: { xs: "1px solid var(--border-subtle)", md: "none" },
          backgroundColor: "var(--surface-sidebar)",
          px: { xs: 2.25, md: 2 },
          py: { xs: 2, md: 2.5 },
        }}
      >
        <Stack spacing={2.5}>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            gap={1}
          >
            <BrandMark />
            <ButtonBase
              onClick={toggleMode}
              sx={{
                width: 36,
                height: 36,
                borderRadius: "12px",
                border: "1px solid var(--border-default)",
                backgroundColor: "var(--surface-card)",
                color: "var(--text-secondary)",
                flexShrink: 0,
              }}
              aria-label={mode === "light" ? "Switch to dark theme" : "Switch to light theme"}
              title={mode === "light" ? "Dark mode" : "Light mode"}
            >
              <Typography fontSize={16} lineHeight={1}>
                {mode === "light" ? "◐" : "◑"}
              </Typography>
            </ButtonBase>
          </Stack>
          <Stack
            direction={{ xs: "row", md: "column" }}
            spacing={1}
            useFlexGap
            flexWrap={{ xs: "wrap", md: "nowrap" }}
          >
            {navItems.map((item) => {
              const active = currentPath === item.href || currentPath.startsWith(`${item.href}/`);
              return (
                <ButtonBase
                  key={item.href}
                  onClick={() => onNavigate(item.href)}
                  sx={{
                    width: { xs: "auto", md: "100%" },
                    justifyContent: "flex-start",
                    textAlign: "left",
                    borderRadius: "14px",
                    px: 1.5,
                    py: 1.1,
                    border: active ? "1px solid var(--border-default)" : "1px solid transparent",
                    backgroundColor: active ? "var(--surface-card)" : "transparent",
                    "&:hover": {
                      backgroundColor: active ? "var(--surface-card)" : "rgba(255,255,255,0.28)",
                    },
                  }}
                >
                  <Stack spacing={0.25}>
                    <Typography fontWeight={700} fontSize={12.5}>
                      {item.label}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      display={{ xs: "none", md: "block" }}
                    >
                      {item.description}
                    </Typography>
                  </Stack>
                </ButtonBase>
              );
            })}
          </Stack>
          <Divider />
          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.secondary">
              Design system
            </Typography>
            <Typography fontSize={11.5} color="text.secondary">
              Shared tokens and components now live under `apps/frontend/design-system`.
            </Typography>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {version}
          </Typography>
        </Stack>
      </Box>

      <Box component="main" sx={{ p: { xs: 2.5, md: 4 } }}>
        {children}
      </Box>
    </Box>
  );
}
