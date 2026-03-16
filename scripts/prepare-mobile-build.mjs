#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const mobileRoot = resolve(repoRoot, "apps/frontend/mobile");
const targetPath = resolve(mobileRoot, "google-services.json");
const { expo: mobileExpoConfig } = require("../apps/frontend/mobile/app.base.js");

function log(message) {
  console.log(`[mobile-build] ${message}`);
}

function fail(message) {
  console.error(`[mobile-build] ${message}`);
  process.exit(1);
}

function loadAppConfig() {
  return { expo: mobileExpoConfig };
}

function ensureTargetDir() {
  mkdirSync(dirname(targetPath), { recursive: true });
}

function writeTarget(contents) {
  ensureTargetDir();
  writeFileSync(targetPath, contents, "utf8");
  chmodSync(targetPath, 0o600);
  log(`Prepared ${targetPath}`);
}

function envFlag(name) {
  return String(process.env[name] ?? "").trim().toLowerCase() === "true";
}

function getProjectId() {
  return (
    process.env.FIREBASE_PROJECT_ID
    || process.env.GOOGLE_CLOUD_PROJECT
    || process.env.GCP_PROJECT_ID
    || ""
  ).trim();
}

function getAccessToken() {
  try {
    return execFileSync("gcloud", ["auth", "print-access-token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
  } catch {
    fail(
      "Could not read a Google access token. Run `gcloud auth login` first, or provide GOOGLE_SERVICES_JSON_BASE64 / GOOGLE_SERVICES_JSON_PATH.",
    );
  }
}

async function apiRequest({ projectId, path, method = "GET", body }) {
  const accessToken = getAccessToken();
  const response = await fetch(`https://firebase.googleapis.com/v1beta1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "x-goog-user-project": projectId,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const details = typeof data?.error?.message === "string" ? data.error.message : response.statusText;
    throw new Error(`${method} ${path} failed (${response.status}): ${details}`);
  }

  return data;
}

async function waitForOperation({ projectId, operationName }) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await apiRequest({
      projectId,
      path: operationName,
    });
    if (result.done) {
      if (result.error?.message) {
        throw new Error(`Firebase operation failed: ${result.error.message}`);
      }
      return result.response ?? {};
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));
  }
  throw new Error(`Timed out waiting for Firebase operation ${operationName}`);
}

async function downloadFromFirebase() {
  const projectId = getProjectId();
  if (!projectId) {
    fail(
      "Set FIREBASE_PROJECT_ID or GOOGLE_CLOUD_PROJECT, or provide GOOGLE_SERVICES_JSON_BASE64 / GOOGLE_SERVICES_JSON_PATH.",
    );
  }

  const appConfig = loadAppConfig();
  const packageName = String(appConfig?.expo?.android?.package ?? "").trim();
  const displayName = String(appConfig?.expo?.name ?? "OI").trim() || "OI";
  if (!packageName) {
    fail("apps/frontend/mobile/app.base.js is missing expo.android.package.");
  }

  log(`Fetching Android Firebase config for ${packageName} in project ${projectId}`);
  const appsResponse = await apiRequest({
    projectId,
    path: `projects/${projectId}/androidApps`,
  });
  const apps = Array.isArray(appsResponse?.apps) ? appsResponse.apps : [];
  let app = apps.find((row) => String(row?.packageName ?? "") === packageName);

  if (!app) {
    if (!envFlag("MOBILE_BUILD_CREATE_FIREBASE_APP")) {
      fail(
        `No Firebase Android app found for package ${packageName} in project ${projectId}. Set MOBILE_BUILD_CREATE_FIREBASE_APP=true to create it automatically.`,
      );
    }

    log(`Creating Firebase Android app for ${packageName}`);
    const operation = await apiRequest({
      projectId,
      path: `projects/${projectId}/androidApps`,
      method: "POST",
      body: {
        displayName: `${displayName} Android`,
        packageName,
      },
    });
    app = await waitForOperation({
      projectId,
      operationName: String(operation?.name ?? ""),
    });
  }

  const appName = String(app?.name ?? "").trim();
  if (!appName) {
    fail(`Firebase Android app lookup returned no app name for ${packageName}.`);
  }

  const configResponse = await apiRequest({
    projectId,
    path: `${appName}/config`,
  });
  const configBase64 = String(configResponse?.configFileContents ?? "").trim();
  if (!configBase64) {
    fail(`Firebase config for ${packageName} did not include file contents.`);
  }

  writeTarget(Buffer.from(configBase64, "base64").toString("utf8"));
}

async function main() {
  if (existsSync(targetPath)) {
    log(`Using existing ${targetPath}`);
    return;
  }

  const sourcePath = String(process.env.GOOGLE_SERVICES_JSON_PATH ?? "").trim();
  if (sourcePath) {
    log(`Copying google-services.json from ${sourcePath}`);
    ensureTargetDir();
    copyFileSync(resolve(sourcePath), targetPath);
    chmodSync(targetPath, 0o600);
    return;
  }

  const sourceBase64 = String(process.env.GOOGLE_SERVICES_JSON_BASE64 ?? "").trim();
  if (sourceBase64) {
    log("Decoding google-services.json from GOOGLE_SERVICES_JSON_BASE64");
    writeTarget(Buffer.from(sourceBase64, "base64").toString("utf8"));
    return;
  }

  await downloadFromFirebase();
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
