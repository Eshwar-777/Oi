const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../../..");
const workspaceNodeModules = path.resolve(monorepoRoot, "node_modules");

const config = getDefaultConfig(projectRoot);

// Watch the monorepo root so shared packages (e.g. @oi/*) resolve correctly
config.watchFolders = Array.from(new Set([...(config.watchFolders || []), monorepoRoot]));

// Ensure Metro resolves from the mobile app's own node_modules first,
// then falls back to the workspace root (for hoisted packages)
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  workspaceNodeModules,
];

config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  "@oi/api-client": path.resolve(monorepoRoot, "packages/api-client"),
  "@oi/shared-types": path.resolve(monorepoRoot, "packages/shared-types"),
  "@oi/design-system-mobile": path.resolve(monorepoRoot, "apps/frontend/design-system/mobile"),
  "@oi/design-tokens": path.resolve(monorepoRoot, "apps/frontend/design-system/tokens"),
  "@react-native-async-storage/async-storage": path.resolve(
    workspaceNodeModules,
    "@react-native-async-storage/async-storage",
  ),
  expo: path.resolve(workspaceNodeModules, "expo"),
  "expo-image-picker": path.resolve(workspaceNodeModules, "expo-image-picker"),
  "expo-router": path.resolve(workspaceNodeModules, "expo-router"),
  firebase: path.resolve(workspaceNodeModules, "firebase"),
  react: path.resolve(workspaceNodeModules, "react"),
  "react-native": path.resolve(workspaceNodeModules, "react-native"),
  "react/jsx-runtime": path.resolve(workspaceNodeModules, "react/jsx-runtime"),
  "react/jsx-dev-runtime": path.resolve(workspaceNodeModules, "react/jsx-dev-runtime"),
};

module.exports = config;
