const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function compactConfig(config) {
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => typeof value === "string" && value.trim()),
  );
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function resolveGoogleServicesPath({ mobileRoot, env, expo }) {
  const configuredPath = firstNonEmpty(env.GOOGLE_SERVICES_JSON, expo.android?.googleServicesFile);
  if (!configuredPath) {
    return "";
  }
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(mobileRoot, configuredPath);
}

function loadGoogleServices({ mobileRoot, env, expo }) {
  const googleServicesPath = resolveGoogleServicesPath({ mobileRoot, env, expo });
  if (!googleServicesPath || !existsSync(googleServicesPath)) {
    return { googleServicesPath, googleServices: null };
  }
  return {
    googleServicesPath,
    googleServices: readJsonFile(googleServicesPath),
  };
}

function resolveMobileFirebaseConfig({ mobileRoot, env, expo }) {
  const { googleServices, googleServicesPath } = loadGoogleServices({ mobileRoot, env, expo });
  const projectInfo = googleServices?.project_info ?? {};
  const primaryClient = Array.isArray(googleServices?.client) ? (googleServices.client[0] ?? {}) : {};
  const clientInfo = primaryClient?.client_info ?? {};
  const apiKeyEntry = Array.isArray(primaryClient?.api_key) ? primaryClient.api_key[0] : null;

  const projectId = firstNonEmpty(
    env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
    env.VITE_FIREBASE_PROJECT_ID,
    env.FIREBASE_PROJECT_ID,
    env.GOOGLE_CLOUD_PROJECT,
    env.GCP_PROJECT_ID,
    projectInfo.project_id,
  );

  const config = compactConfig({
    apiKey: firstNonEmpty(
      env.EXPO_PUBLIC_FIREBASE_API_KEY,
      env.VITE_FIREBASE_API_KEY,
      apiKeyEntry?.current_key,
    ),
    authDomain: firstNonEmpty(
      env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
      env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId ? `${projectId}.firebaseapp.com` : "",
    ),
    projectId,
    storageBucket: firstNonEmpty(
      env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
      env.VITE_FIREBASE_STORAGE_BUCKET,
      projectInfo.storage_bucket,
    ),
    appId: firstNonEmpty(
      env.EXPO_PUBLIC_FIREBASE_APP_ID,
      env.VITE_FIREBASE_APP_ID,
      clientInfo.mobilesdk_app_id,
    ),
    messagingSenderId: firstNonEmpty(
      env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
      env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      projectInfo.project_number,
    ),
    measurementId: firstNonEmpty(
      env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID,
      env.VITE_FIREBASE_MEASUREMENT_ID,
    ),
  });

  return {
    config,
    googleServicesPath,
    googleServicesPresent: Boolean(googleServices),
  };
}

function hasCompleteMobileFirebaseConfig(config) {
  const value = "config" in config ? config.config : config;
  return Boolean(
    value
    && value.apiKey
    && value.authDomain
    && value.projectId
    && value.appId,
  );
}

module.exports = {
  hasCompleteMobileFirebaseConfig,
  resolveMobileFirebaseConfig,
};
