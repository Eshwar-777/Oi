/**
 * Post-build script: writes dist/manifest.json with built paths and copies popup.html + icons.
 * If source icons are missing, writes minimal placeholder PNGs so the extension loads.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist");

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf-8"));

// Point to built JS and popup
manifest.background.service_worker = "background.js";
manifest.content_scripts[0].js = ["content-script.js"];
manifest.action.default_popup = "popup.html";
manifest.options_page = "options.html";

writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));

// Copy popup.html and fix script src
let popupHtml = readFileSync(join(root, "src/popup/popup.html"), "utf-8");
popupHtml = popupHtml.replace(/popup\.ts/g, "popup.js");
writeFileSync(join(dist, "popup.html"), popupHtml);

// Copy options.html and fix script src
let optionsHtml = readFileSync(join(root, "src/options/options.html"), "utf-8");
optionsHtml = optionsHtml.replace(/options\.ts/g, "options.js");
writeFileSync(join(dist, "options.html"), optionsHtml);

// Icons: copy from source or write minimal placeholders so Chrome can load the extension
const iconsDir = join(root, "icons");
const distIcons = join(dist, "icons");
mkdirSync(distIcons, { recursive: true });

const iconNames = ["icon-16.png", "icon-48.png", "icon-128.png"];
const hasSourceIcons = iconNames.every((name) => existsSync(join(iconsDir, name)));

if (hasSourceIcons) {
  for (const name of iconNames) {
    copyFileSync(join(iconsDir, name), join(distIcons, name));
  }
} else {
  // Minimal valid 1x1 PNG (transparent) so manifest loads; Chrome will scale
  const minimalPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKMIQQAAAABJRU5ErkJggg==",
    "base64"
  );
  for (const name of iconNames) {
    writeFileSync(join(distIcons, name), minimalPng);
  }
  console.log("Extension dist: placeholder icons written (replace with real icons in apps/extension/icons/ for a proper look).");
}

console.log("Extension dist manifest and assets updated.");
