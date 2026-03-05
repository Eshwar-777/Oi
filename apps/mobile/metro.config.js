const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the monorepo root so shared packages (e.g. @oi/*) resolve correctly
config.watchFolders = [monorepoRoot];

// Ensure Metro resolves from the mobile app's own node_modules first,
// then falls back to the workspace root (for hoisted packages)
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(monorepoRoot, "node_modules"),
];

module.exports = config;
