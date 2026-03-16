import test from "node:test";
import assert from "node:assert/strict";
import { runtimeConfigSummary, validateRuntimeConfig } from "./config.js";

test("runtime config summary fingerprints secrets", () => {
  const summary = runtimeConfigSummary({
    env: "dev",
    host: "127.0.0.1",
    port: 8787,
    sharedSecret: "top-secret",
    plannerModel: "gemini-2.5-flash",
    googleApiKey: "",
    gcpProject: "project",
    gcpLocation: "us-central1",
    googleGenAiUseVertexAi: true,
    googleApplicationCredentials: "/tmp/key.json",
    googleAdcPath: "",
  });

  assert.equal(summary.runtimeSecret, "190aec73");
});

test("runtime config validation requires secret and auth material", () => {
  const missing = validateRuntimeConfig({
    env: "dev",
    host: "127.0.0.1",
    port: 8787,
    sharedSecret: "",
    plannerModel: "",
    googleApiKey: "",
    gcpProject: "",
    gcpLocation: "",
    googleGenAiUseVertexAi: true,
    googleApplicationCredentials: "",
    googleAdcPath: "",
  });

  assert.ok(missing.includes("AUTOMATION_RUNTIME_SHARED_SECRET"));
  assert.ok(missing.includes("Vertex AI project/location"));
});
