import path from "path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendPort = env.OI_BACKEND_PORT || env.BACKEND_PORT || "8080";

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      host: "127.0.0.1",
      proxy: {
        "/api": `http://127.0.0.1:${backendPort}`,
      },
    },
    preview: {
      host: "127.0.0.1",
    },
  };
});
