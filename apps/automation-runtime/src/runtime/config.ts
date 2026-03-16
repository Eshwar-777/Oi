import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeConfig = {
  host: string;
  port: number;
  sharedSecret: string;
  plannerModel: string;
  googleApiKey: string;
  gcpProject: string;
  gcpLocation: string;
  googleGenAiUseVertexAi: boolean;
  googleApplicationCredentials: string;
  googleAdcPath: string;
  cloudRunService: string;
  env: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(SERVICE_ROOT, "../..");

function environmentName(): string {
  return String(process.env.ENV || process.env.APP_ENV || "dev").trim().toLowerCase();
}

function shouldLoadDotenv(): boolean {
  return !["prod", "production"].includes(environmentName());
}

function applyDotEnvFile(filePath: string): void {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (!key || process.env[key] != null) continue;
    let value = match[2] || "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

let envLoaded = false;

function ensureEnvLoaded(): void {
  if (envLoaded) return;
  envLoaded = true;
  if (!shouldLoadDotenv()) return;
  for (const filePath of [
    path.join(REPO_ROOT, ".env"),
    path.join(REPO_ROOT, ".env.local"),
    path.join(SERVICE_ROOT, ".env"),
    path.join(SERVICE_ROOT, ".env.local"),
  ]) {
    applyDotEnvFile(filePath);
  }
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function resolveGoogleAdcPath(): string {
  const home = process.env.HOME?.trim();
  if (!home) return "";
  const adcPath = path.join(home, ".config/gcloud/application_default_credentials.json");
  try {
    return fs.existsSync(adcPath) ? adcPath : "";
  } catch {
    return "";
  }
}

function fingerprint(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "missing";
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}

export function loadRuntimeConfig(): RuntimeConfig {
  ensureEnvLoaded();
  return {
    env: environmentName(),
    host: process.env.AUTOMATION_RUNTIME_HOST?.trim() || "127.0.0.1",
    port: Number.parseInt(process.env.AUTOMATION_RUNTIME_PORT || "8787", 10) || 8787,
    sharedSecret: process.env.AUTOMATION_RUNTIME_SHARED_SECRET?.trim() || "",
    plannerModel: process.env.AUTOMATION_RUNTIME_PLANNER_MODEL?.trim() || process.env.GEMINI_MODEL?.trim() || "",
    googleApiKey: process.env.AUTOMATION_RUNTIME_GOOGLE_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || "",
    gcpProject: process.env.AUTOMATION_RUNTIME_GCP_PROJECT?.trim() || process.env.GOOGLE_CLOUD_PROJECT?.trim() || "",
    gcpLocation: process.env.AUTOMATION_RUNTIME_GCP_LOCATION?.trim() || process.env.GOOGLE_CLOUD_LOCATION?.trim() || "us-central1",
    googleGenAiUseVertexAi: parseBoolean(process.env.AUTOMATION_RUNTIME_GOOGLE_GENAI_USE_VERTEXAI || process.env.GOOGLE_GENAI_USE_VERTEXAI),
    googleApplicationCredentials:
      process.env.AUTOMATION_RUNTIME_GOOGLE_APPLICATION_CREDENTIALS?.trim() ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ||
      "",
    googleAdcPath: resolveGoogleAdcPath(),
    cloudRunService: process.env.K_SERVICE?.trim() || "",
  };
}

export function validateRuntimeConfig(config: RuntimeConfig): string[] {
  const missing: string[] = [];
  if (!String(config.sharedSecret || "").trim()) missing.push("AUTOMATION_RUNTIME_SHARED_SECRET");
  if (
    config.googleGenAiUseVertexAi &&
    !(String(config.gcpProject || "").trim() && String(config.gcpLocation || "").trim())
  ) {
    missing.push("Vertex AI project/location");
  }
  if (!config.googleGenAiUseVertexAi && !String(config.googleApiKey || "").trim()) {
    missing.push("GOOGLE_API_KEY");
  }
  if (
    config.googleGenAiUseVertexAi &&
    !(
      String(config.googleApplicationCredentials || "").trim() ||
      String(config.googleAdcPath || "").trim() ||
      String(config.cloudRunService || "").trim()
    )
  ) {
    missing.push("GOOGLE_APPLICATION_CREDENTIALS or ADC");
  }
  return missing;
}

export function runtimeConfigSummary(config: RuntimeConfig): Record<string, unknown> {
  return {
    env: config.env,
    host: config.host,
    port: config.port,
    plannerModel: config.plannerModel,
    plannerAuthMode: config.googleGenAiUseVertexAi ? "vertex" : "api_key",
    runtimeSecret: fingerprint(config.sharedSecret),
    googleProject: config.gcpProject || "missing",
    googleCredentials: config.googleApplicationCredentials
      ? "service_account"
      : config.googleAdcPath
        ? "adc"
        : config.cloudRunService
          ? "cloud_run_adc"
          : "missing",
  };
}
