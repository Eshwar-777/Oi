#!/usr/bin/env node

const mode = process.argv[2] || "all";

const groups = {
  backend: [
    "ARTIFACT_REGISTRY",
    "GCP_WORKLOAD_IDENTITY_PROVIDER",
    "GCP_SERVICE_ACCOUNT",
    "GCP_PROJECT_ID",
  ],
  web: [
    "VITE_OI_API_URL",
    "VITE_FIREBASE_API_KEY",
    "VITE_FIREBASE_AUTH_DOMAIN",
    "VITE_FIREBASE_PROJECT_ID",
    "VITE_FIREBASE_STORAGE_BUCKET",
    "VITE_FIREBASE_APP_ID",
    "VITE_FIREBASE_MESSAGING_SENDER_ID",
    "FIREBASE_PROJECT_ID",
    "FIREBASE_SERVICE_ACCOUNT",
  ],
  mobile: [
    "EXPO_PUBLIC_API_URL",
    "EXPO_PUBLIC_API_PORT",
    "EXPO_TOKEN",
  ],
};

const selected =
  mode === "all"
    ? Object.keys(groups)
    : mode.split(",").map((item) => item.trim()).filter(Boolean);

const unknown = selected.filter((name) => !(name in groups));
if (unknown.length > 0) {
  console.error(`Unknown group(s): ${unknown.join(", ")}`);
  process.exit(1);
}

let hasFailure = false;

for (const name of selected) {
  const missing = groups[name].filter((key) => {
    const value = process.env[key];
    return !value || !String(value).trim();
  });

  if (missing.length > 0) {
    hasFailure = true;
    console.error(`[${name}] missing: ${missing.join(", ")}`);
  } else {
    console.log(`[${name}] ok`);
  }
}

if (hasFailure) {
  process.exit(1);
}
