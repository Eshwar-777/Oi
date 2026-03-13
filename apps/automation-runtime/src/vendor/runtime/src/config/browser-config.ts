import fs from "node:fs";
import os from "node:os";
import JSON5 from "json5";
import {
  loadShellEnvFallback,
  resolveShellEnvFallbackTimeoutMs,
  shouldDeferShellEnvFallback,
  shouldEnableShellEnvFallback,
  loadDotEnv,
  resolveRequiredHomeDir,
} from "./browser-support.js";
import { VERSION } from "../version.js";
import {
  applyAgentDefaults,
  applyCompactionDefaults,
  applyContextPruningDefaults,
  applyLoggingDefaults,
  applyMessageDefaults,
  applyModelDefaults,
  applySessionDefaults,
  applyTalkApiKey,
  applyTalkConfigNormalization,
} from "./defaults.js";
import { type EnvSubstitutionWarning, resolveConfigEnvVars } from "./env-substitution.js";
import { applyConfigEnvVars } from "./env-vars.js";
import { readConfigIncludeFileWithGuards, resolveConfigIncludes } from "./includes.js";
import { normalizeExecSafeBinProfilesInConfig } from "./normalize-exec-safe-bin.js";
import { normalizeConfigPaths } from "./normalize-paths.js";
import { resolveConfigPath, resolveDefaultConfigCandidates, resolveStateDir } from "./paths.js";
import { applyConfigOverrides } from "./runtime-overrides.js";
import type { RuntimeConfig } from "./types.js";
import { compareRuntimeVersions } from "./version.js";

const SHELL_ENV_EXPECTED_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "GEMINI_API_KEY",
  "ZAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "MINIMAX_API_KEY",
  "SYNTHETIC_API_KEY",
  "KILOCODE_API_KEY",
  "ELEVENLABS_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "RUNTIME_GATEWAY_TOKEN",
  "RUNTIME_GATEWAY_PASSWORD",
] as const;

function coerceConfig(value: unknown): RuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as RuntimeConfig;
}

function maybeLoadDotEnvForConfig(env: NodeJS.ProcessEnv): void {
  if (env !== process.env) {
    return;
  }
  loadDotEnv({ quiet: true });
}

function warnOnConfigMiskeys(raw: unknown): void {
  if (!raw || typeof raw !== "object") {
    return;
  }
  const gateway = (raw as Record<string, unknown>).gateway;
  if (!gateway || typeof gateway !== "object") {
    return;
  }
  if ("token" in (gateway as Record<string, unknown>)) {
    console.warn(
      'Config uses "gateway.token". This key is ignored; use "gateway.auth.token" instead.',
    );
  }
}

function warnIfConfigFromFuture(cfg: RuntimeConfig): void {
  const touched = cfg.meta?.lastTouchedVersion;
  if (!touched) {
    return;
  }
  const cmp = compareRuntimeVersions(VERSION, touched);
  if (cmp !== null && cmp < 0) {
    console.warn(
      `Config was last written by a newer Runtime (${touched}); current version is ${VERSION}.`,
    );
  }
}

function resolveConfigForRead(
  resolvedIncludes: unknown,
  env: NodeJS.ProcessEnv,
): { resolvedConfigRaw: unknown; envWarnings: EnvSubstitutionWarning[] } {
  if (resolvedIncludes && typeof resolvedIncludes === "object" && "env" in resolvedIncludes) {
    applyConfigEnvVars(resolvedIncludes as RuntimeConfig, env);
  }
  const envWarnings: EnvSubstitutionWarning[] = [];
  return {
    resolvedConfigRaw: resolveConfigEnvVars(resolvedIncludes, env, {
      onMissing: (warning) => envWarnings.push(warning),
    }),
    envWarnings,
  };
}

function applyBrowserConfigDefaults(config: RuntimeConfig): RuntimeConfig {
  const cfg = applyTalkApiKey(
    applyTalkConfigNormalization(
      applyModelDefaults(
        applyCompactionDefaults(
          applyContextPruningDefaults(
            applyAgentDefaults(applySessionDefaults(applyLoggingDefaults(applyMessageDefaults(config)))),
          ),
        ),
      ),
    ),
  );
  normalizeConfigPaths(cfg);
  normalizeExecSafeBinProfilesInConfig(cfg);
  return cfg;
}

export function loadBrowserConfig(): RuntimeConfig {
  const env = process.env;
  const homedir = () => resolveRequiredHomeDir(env, os.homedir);
  const requestedConfigPath = resolveConfigPath(env, resolveStateDir(env, homedir));
  const candidatePaths = resolveDefaultConfigCandidates(env, homedir);
  const configPath =
    candidatePaths.find((candidate) => fs.existsSync(candidate)) ?? requestedConfigPath;

  maybeLoadDotEnvForConfig(env);

  if (!fs.existsSync(configPath)) {
    if (shouldEnableShellEnvFallback(env) && !shouldDeferShellEnvFallback(env)) {
      loadShellEnvFallback({
        enabled: true,
        env,
        expectedKeys: [...SHELL_ENV_EXPECTED_KEYS],
        logger: console,
        timeoutMs: resolveShellEnvFallbackTimeoutMs(env),
      });
    }
    return applyConfigOverrides(applyBrowserConfigDefaults({}));
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON5.parse(raw);
  const resolvedIncludes = resolveConfigIncludes(parsed, configPath, {
    readFile: (candidate) => fs.readFileSync(candidate, "utf-8"),
    readFileWithGuards: ({ includePath, resolvedPath, rootRealDir }) =>
      readConfigIncludeFileWithGuards({
        includePath,
        resolvedPath,
        rootRealDir,
        ioFs: fs,
      }),
    parseJson: (value) => JSON5.parse(value),
  });
  const readResolution = resolveConfigForRead(resolvedIncludes, env);
  const resolvedConfig = coerceConfig(readResolution.resolvedConfigRaw);

  for (const warning of readResolution.envWarnings) {
    console.warn(
      `Config (${configPath}): missing env var "${warning.varName}" at ${warning.configPath} — feature using this value will be unavailable`,
    );
  }
  warnOnConfigMiskeys(resolvedConfig);
  warnIfConfigFromFuture(resolvedConfig);

  const cfg = applyBrowserConfigDefaults(resolvedConfig);
  applyConfigEnvVars(cfg, env);

  const shellEnvEnabled = shouldEnableShellEnvFallback(env) || cfg.env?.shellEnv?.enabled === true;
  if (shellEnvEnabled && !shouldDeferShellEnvFallback(env)) {
    loadShellEnvFallback({
      enabled: true,
      env,
      expectedKeys: [...SHELL_ENV_EXPECTED_KEYS],
      logger: console,
      timeoutMs: cfg.env?.shellEnv?.timeoutMs ?? resolveShellEnvFallbackTimeoutMs(env),
    });
  }

  return applyConfigOverrides(cfg);
}
