import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { CssBaseline } from "@mui/material";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import {
  colorTokens,
  radii,
  semanticColorTokens,
  typography,
} from "@oi/design-tokens";

const cssVar = (name: string) => `var(${name})`;
type OIThemeMode = "light" | "dark";

interface OIThemeContextValue {
  mode: OIThemeMode;
  toggleMode: () => void;
  setMode: (mode: OIThemeMode) => void;
}

const STORAGE_KEY = "oye-theme-mode";

const OIThemeContext = createContext<OIThemeContextValue | null>(null);

function buildTheme(mode: OIThemeMode) {
  const colors = semanticColorTokens[mode];

  return createTheme({
    palette: {
      mode,
      primary: {
        main: colors.actionPrimaryBg,
        contrastText: colors.actionPrimaryFg,
      },
      secondary: {
        main: colors.accentMain,
        contrastText: mode === "dark" ? colorTokens.neutral[900] : colorTokens.neutral[0],
      },
      success: { main: colorTokens.status.success },
      warning: { main: colorTokens.status.warning },
      error: { main: colorTokens.status.danger },
      info: { main: colorTokens.status.info },
      text: {
        primary: colors.textPrimary,
        secondary: colors.textSecondary,
        disabled: colors.textDisabled,
      },
      background: {
        default: colors.surfaceCanvas,
        paper: colors.surfaceCard,
      },
      divider: colors.borderDefault,
    },
    spacing: 4,
    shape: {
      borderRadius: radii.md,
    },
    typography: {
      fontFamily: typography.fontFamily.sans,
      h1: {
        fontFamily: typography.fontFamily.display,
        fontSize: "clamp(3rem, 7vw, 4.5rem)",
        lineHeight: typography.lineHeight.compact,
        fontWeight: typography.fontWeight.bold,
        letterSpacing: "-0.04em",
      },
      h2: {
        fontFamily: typography.fontFamily.display,
        fontSize: "clamp(1.9rem, 3.1vw, 2.7rem)",
        lineHeight: typography.lineHeight.compact,
        fontWeight: typography.fontWeight.bold,
        letterSpacing: "-0.03em",
      },
      h3: {
        fontSize: "1.375rem",
        lineHeight: typography.lineHeight.compact,
        fontWeight: typography.fontWeight.semibold,
        letterSpacing: "-0.02em",
      },
      body1: {
        fontSize: "1rem",
        lineHeight: typography.lineHeight.relaxed,
      },
      body2: {
        fontSize: "0.925rem",
        lineHeight: typography.lineHeight.normal,
      },
      button: {
        fontSize: "0.95rem",
        fontWeight: typography.fontWeight.semibold,
        textTransform: "none",
        letterSpacing: "-0.01em",
      },
      overline: {
        fontSize: "0.75rem",
        fontWeight: typography.fontWeight.semibold,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
      },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ":root": {
            colorScheme: mode,
          },
          body: {
            backgroundColor: cssVar("--surface-canvas"),
            backgroundImage: cssVar("--hero-wash"),
            backgroundAttachment: "fixed",
            color: cssVar("--text-primary"),
          },
          a: {
            color: "inherit",
            textDecoration: "none",
          },
          "::selection": {
            backgroundColor: cssVar("--c-brand-200"),
            color: cssVar("--text-primary"),
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: "none",
            border: `1px solid ${cssVar("--border-subtle")}`,
            boxShadow: cssVar("--shadow-sm"),
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius: radii.sm,
            paddingInline: 18,
            paddingBlock: 9,
            boxShadow: "none",
          },
          containedPrimary: {
            backgroundColor: cssVar("--btn-primary-bg"),
            color: cssVar("--btn-primary-fg"),
            "&:hover": {
              backgroundColor: cssVar("--btn-primary-bg-hover"),
            },
          },
          outlinedPrimary: {
            borderColor: cssVar("--border-strong"),
            color: cssVar("--text-primary"),
            backgroundColor: cssVar("--btn-secondary-bg"),
            "&:hover": {
              borderColor: cssVar("--border-strong"),
              backgroundColor: cssVar("--btn-secondary-bg-hover"),
            },
          },
        },
      },
      MuiButtonBase: {
        styleOverrides: {
          root: {
            transition: "background-color 140ms ease, border-color 140ms ease, color 140ms ease",
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: radii.sm,
            backgroundColor: cssVar("--input-bg"),
            "& .MuiOutlinedInput-notchedOutline": {
              borderColor: cssVar("--input-border"),
            },
            "&:hover .MuiOutlinedInput-notchedOutline": {
              borderColor: cssVar("--input-border-hover"),
            },
            "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
              borderColor: cssVar("--c-brand-500"),
              boxShadow: `0 0 0 4px ${cssVar("--focus-ring")}`,
            },
          },
          input: {
            color: cssVar("--input-fg"),
            "&::placeholder": {
              color: cssVar("--input-placeholder"),
              opacity: 1,
            },
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: {
            borderRadius: radii.full,
            fontWeight: typography.fontWeight.semibold,
          },
        },
      },
      MuiAccordion: {
        styleOverrides: {
          root: {
            boxShadow: "none",
            border: `1px solid ${cssVar("--border-subtle")}`,
            backgroundColor: cssVar("--surface-card-muted"),
          },
        },
      },
    },
  });
}

interface OIThemeProviderProps {
  children: ReactNode;
}

export function OIThemeProvider({ children }: OIThemeProviderProps) {
  const [mode, setMode] = useState<OIThemeMode>(() => {
    if (typeof window === "undefined") return "light";
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "light";
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.theme = mode;
    window.localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  const theme = useMemo(() => buildTheme(mode), [mode]);
  const value = useMemo<OIThemeContextValue>(
    () => ({
      mode,
      toggleMode: () => setMode((current) => (current === "light" ? "dark" : "light")),
      setMode,
    }),
    [mode],
  );

  return (
    <OIThemeContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </OIThemeContext.Provider>
  );
}

export function useOITheme() {
  const context = useContext(OIThemeContext);
  if (!context) {
    throw new Error("useOITheme must be used within OIThemeProvider");
  }
  return context;
}
