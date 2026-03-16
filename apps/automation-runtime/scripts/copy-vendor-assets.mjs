import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

async function copyDir(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, destinationPath);
      continue;
    }
    await fs.copyFile(sourcePath, destinationPath);
  }
}

async function copyIfPresent(sourceRelative, destinationRelative = sourceRelative) {
  const sourcePath = path.join(packageRoot, sourceRelative);
  const destinationPath = path.join(packageRoot, "dist", destinationRelative);
  try {
    const stat = await fs.stat(sourcePath);
    if (stat.isDirectory()) {
      await copyDir(sourcePath, destinationPath);
      return;
    }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
  } catch {
    // Ignore missing optional assets.
  }
}

await copyIfPresent("src/vendor/runtime/skills", "vendor/runtime/skills");
