import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        maroon: {
          50: "#FAE8ED",
          100: "#F2C5D0",
          200: "#E08DA5",
          300: "#C4567A",
          400: "#9C2E50",
          500: "#751636",
          600: "#63122E",
          700: "#4F0E24",
          800: "#3D0A1B",
          900: "#33101C",
          950: "#1A080E",
        },
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "Helvetica Neue", "Arial", "sans-serif"],
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
};

export default config;
