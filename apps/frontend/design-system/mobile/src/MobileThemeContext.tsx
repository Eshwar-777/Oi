import {
  createContext,
  useMemo,
  useContext,
  type ReactNode,
} from "react";
import { getMobileTheme, mobileTheme, type MobileThemeMode } from "./theme";

type MobileTheme = ReturnType<typeof getMobileTheme>;

const MobileThemeContext = createContext<MobileTheme | null>(null);

interface MobileThemeProviderProps {
  mode: MobileThemeMode;
  children: ReactNode;
}

export function MobileThemeProvider({ mode, children }: MobileThemeProviderProps) {
  const theme = useMemo(() => getMobileTheme(mode), [mode]);
  return (
    <MobileThemeContext.Provider value={theme}>
      {children}
    </MobileThemeContext.Provider>
  );
}

export function useMobileTheme(): MobileTheme {
  const theme = useContext(MobileThemeContext);
  return theme ?? mobileTheme;
}
