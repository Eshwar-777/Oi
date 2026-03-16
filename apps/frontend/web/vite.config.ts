import path from "path";
import { fileURLToPath } from "url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const rootEnvDir = path.resolve(__dirname, "../../..");
  const env = loadEnv(mode, rootEnvDir, "");
  const backendPort = env.OI_BACKEND_PORT || env.BACKEND_PORT || "8080";

  return {
    plugins: [react()],
    envDir: rootEnvDir,
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      host: "127.0.0.1",
      proxy: {
        "/api": `http://127.0.0.1:${backendPort}`,
        "/browser": `http://127.0.0.1:${backendPort}`,
        "/ws": {
          target: `ws://127.0.0.1:${backendPort}`,
          ws: true,
        },
      },
    },
    preview: {
      host: "127.0.0.1",
    },
  };
});
