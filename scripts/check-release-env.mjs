#!/usr/bin/env node

const target = process.argv[2];

const requiredByTarget = {
  web: [
    "VITE_OI_API_URL",
    "VITE_FIREBASE_API_KEY",
    "VITE_FIREBASE_AUTH_DOMAIN",
    "VITE_FIREBASE_PROJECT_ID",
    "VITE_FIREBASE_STORAGE_BUCKET",
    "VITE_FIREBASE_APP_ID",
    "VITE_FIREBASE_MESSAGING_SENDER_ID",
  ],
  mobile: [
    "EXPO_PUBLIC_API_URL",
  ],
};

if (!target || !(target in requiredByTarget)) {
  console.error("Usage: node scripts/check-release-env.mjs <web|mobile>");
  process.exit(1);
}

const missing = requiredByTarget[target].filter((key) => {
  const value = process.env[key];
  return !value || !String(value).trim();
});

if (missing.length > 0) {
  console.error(`Missing required ${target} release environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`${target} release environment variables present`);
