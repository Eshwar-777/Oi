import fs from "node:fs/promises";
import path from "node:path";
import { ensureRuntimeModelsJson } from "../src/vendor/runtime/src/agents/models-config.js";
import { applyAgentDefaultPrimaryModel } from "../src/vendor/runtime/src/commands/model-default.js";
import { applyAuthProfileConfig } from "../src/vendor/runtime/src/commands/onboard-auth.config-core.js";
import { setGeminiApiKey } from "../src/vendor/runtime/src/commands/onboard-auth.credentials.js";
import type { RuntimeConfig } from "../src/vendor/runtime/src/config/types.js";

type SeedInput = {
  stateDir: string;
  configPath: string;
  modelRef?: string;
  plannerModel?: string;
  googleApiKey?: string;
  googleGenAiUseVertexAi?: boolean;
};

async function readInput(): Promise<SeedInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as SeedInput;
}

async function main(): Promise<void> {
  const input = await readInput();
  let nextConfig: Record<string, unknown> = {};
  try {
    nextConfig = JSON.parse(await fs.readFile(input.configPath, "utf8")) as Record<string, unknown>;
  } catch {
    nextConfig = {};
  }

  const resolvedModelRef = (() => {
    const explicit = String(input.modelRef || "").trim();
    if (explicit) {
      return explicit;
    }
    const modelName = String(input.plannerModel || "").trim();
    if (!modelName) {
      return "";
    }
    const provider = input.googleApiKey
      ? "google"
      : input.googleGenAiUseVertexAi
        ? "google-vertex"
        : "google";
    return `${provider}/${modelName}`;
  })();

  const slashIndex = resolvedModelRef.indexOf("/");
  const provider =
    slashIndex > 0 ? resolvedModelRef.slice(0, slashIndex).trim() : input.googleGenAiUseVertexAi ? "google-vertex" : "google";
  const modelName = slashIndex > 0 ? resolvedModelRef.slice(slashIndex + 1).trim() : resolvedModelRef;

  if (provider === "google" && String(input.googleApiKey || "").trim()) {
    await setGeminiApiKey(
      String(input.googleApiKey).trim(),
      path.join(input.stateDir, "agents", "main", "agent"),
    );
    nextConfig = applyAuthProfileConfig(nextConfig as never, {
      profileId: "google:default",
      provider: "google",
      mode: "api_key",
    }) as Record<string, unknown>;
  }
  if (provider === "google-vertex") {
    nextConfig = applyAuthProfileConfig(nextConfig as never, {
      profileId: "google-vertex:default",
      provider: "google-vertex",
      mode: "api_key",
    }) as Record<string, unknown>;
  }

  if (modelName) {
    nextConfig = applyAgentDefaultPrimaryModel({
      cfg: nextConfig as never,
      model: `${provider}/${modelName}`,
    }).next as Record<string, unknown>;
  }

  await fs.writeFile(input.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  await ensureRuntimeModelsJson(
    nextConfig as RuntimeConfig,
    path.join(input.stateDir, "agents", "main", "agent"),
  );
  process.stdout.write(
    `Seeded Runtime auth/config for ${modelName ? `${provider}/${modelName}` : provider}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
