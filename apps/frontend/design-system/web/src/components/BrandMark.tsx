import { Box } from "@mui/material";
import { useOITheme } from "../theme/OIThemeProvider";
import oyeIconDark from "../assets/oye-icon-dark.svg";
import oyeIconLight from "../assets/oye-icon-light.svg";
import oyeLockupDark from "../assets/oye-lockup-dark.svg";
import oyeLockupLight from "../assets/oye-lockup-light.svg";

interface BrandMarkProps {
  compact?: boolean;
}

export function BrandMark({ compact = false }: BrandMarkProps) {
  const { mode } = useOITheme();
  const width = compact ? 34 : 196;
  const height = compact ? 34 : 58;
  const src =
    mode === "dark"
      ? compact
        ? oyeIconDark
        : oyeLockupDark
      : compact
        ? oyeIconLight
        : oyeLockupLight;
  const alt = compact ? "Oye icon" : "Oye Operational navigator";

  return (
    <Box
      sx={{
        display: "inline-flex",
        alignItems: "center",
        lineHeight: 0,
      }}
    >
      <Box
        component="img"
        src={src}
        alt={alt}
        sx={{
          display: "block",
          width,
          height,
          objectFit: "contain",
        }}
      />
    </Box>
  );
}
