import { Box, Typography } from "@mui/material";
import { useOITheme } from "../theme/OIThemeProvider";
import oyeIconDark from "../assets/oye-icon-dark.svg";
import oyeIconLight from "../assets/oye-icon-light.svg";

interface BrandMarkProps {
  compact?: boolean;
}

export function BrandMark({ compact = false }: BrandMarkProps) {
  const { mode } = useOITheme();
  const src = mode === "dark" ? oyeIconDark : oyeIconLight;
  const alt = compact ? "Oye icon" : "Oye Operational navigator";

  if (compact) {
    return (
      <Box
        sx={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 0,
        }}
      >
        <Box
          component="img"
          src={src}
          alt={alt}
          sx={{
            display: "block",
            width: 34,
            height: 34,
            objectFit: "contain",
          }}
        />
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 1.4,
        lineHeight: 1,
      }}
    >
      <Box
        component="img"
        src={src}
        alt={alt}
        sx={{
          display: "block",
          width: 46,
          height: 46,
          objectFit: "contain",
        }}
      />
      <Typography
        component="span"
        sx={{
          fontSize: 36,
          lineHeight: 1,
          fontWeight: 800,
          letterSpacing: "-0.04em",
          color: "var(--text-primary)",
        }}
      >
        Oye
      </Typography>
    </Box>
  );
}
