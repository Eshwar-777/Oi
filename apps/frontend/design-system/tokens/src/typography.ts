export const typography = {
  fontFamily: {
    display: '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif',
    sans: '"Avenir Next", "Segoe UI Variable", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
    mono: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
  },
  fontSize: {
    xs: 12,
    sm: 14,
    base: 16,
    lg: 18,
    xl: 20,
    "2xl": 24,
    "3xl": 32,
    "4xl": 44,
    "5xl": 56,
  },
  fontWeight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  lineHeight: {
    compact: 1.2,
    normal: 1.45,
    relaxed: 1.7,
  },
} as const;
