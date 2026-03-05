import { defineConfig } from "vite";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { copyFileSync, mkdirSync, existsSync, readdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function copyStaticAssets() {
  return {
    name: "copy-extension-assets",
    closeBundle() {
      const dist = resolve(__dirname, "dist");

      const manifestSrc = resolve(__dirname, "manifest.dist.json");
      if (existsSync(manifestSrc)) {
        copyFileSync(manifestSrc, resolve(dist, "manifest.json"));
      }

      const htmlFiles: [string, string][] = [
        ["src/popup/popup.dist.html", "popup.html"],
        ["src/options/options.dist.html", "options.html"],
      ];
      for (const [srcPath, destName] of htmlFiles) {
        const src = resolve(__dirname, srcPath);
        if (existsSync(src)) {
          copyFileSync(src, resolve(dist, destName));
        }
      }

      const iconsDir = resolve(__dirname, "icons");
      if (existsSync(iconsDir)) {
        const destIcons = resolve(dist, "icons");
        if (!existsSync(destIcons)) mkdirSync(destIcons, { recursive: true });
        for (const file of readdirSync(iconsDir)) {
          copyFileSync(resolve(iconsDir, file), resolve(destIcons, file));
        }
      }
    },
  };
}

export default defineConfig({
  root: __dirname,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/service-worker.ts"),
        "content-script": resolve(__dirname, "src/content/content-script.ts"),
        popup: resolve(__dirname, "src/popup/popup.ts"),
        options: resolve(__dirname, "src/options/options.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name].[ext]",
      },
    },
    sourcemap: true,
    minify: false,
    target: "esnext",
  },
  plugins: [copyStaticAssets()],
});
