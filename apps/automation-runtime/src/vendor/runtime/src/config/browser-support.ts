import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

let lastAppliedShellEnvKeys: string[] = [];

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isTruthyEnvValue(value?: string): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function resolveRequiredHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const explicitHome = normalize(env.RUNTIME_HOME);
  if (explicitHome) {
    return path.resolve(expandHomePrefix(explicitHome, { env, homedir }));
  }
  const envHome = normalize(env.HOME) ?? normalize(env.USERPROFILE);
  if (envHome) {
    return path.resolve(envHome);
  }
  try {
    return path.resolve(homedir());
  } catch {
    return path.resolve(process.cwd());
  }
}

export function expandHomePrefix(
  input: string,
  opts?: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  if (!input.startsWith("~")) {
    return input;
  }
  const home =
    opts?.home?.trim() ||
    resolveRequiredHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir);
  return input.replace(/^~(?=$|[\\/])/, home);
}

export function loadDotEnv(opts?: { quiet?: boolean }): void {
  const result = dotenv.config();
  if (result.error && !opts?.quiet) {
    console.warn(`[runtime] dotenv load failed: ${result.error.message}`);
  }
}

export function shouldEnableShellEnvFallback(env: NodeJS.ProcessEnv): boolean {
  return isTruthyEnvValue(env.RUNTIME_LOAD_SHELL_ENV);
}

export function shouldDeferShellEnvFallback(env: NodeJS.ProcessEnv): boolean {
  return isTruthyEnvValue(env.RUNTIME_DEFER_SHELL_ENV_FALLBACK);
}

export function resolveShellEnvFallbackTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.RUNTIME_SHELL_ENV_TIMEOUT_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 15_000;
}

export function loadShellEnvFallback(opts: {
  enabled: boolean;
  env: NodeJS.ProcessEnv;
  expectedKeys: string[];
  logger?: Pick<typeof console, "warn">;
  timeoutMs?: number;
}): { ok: true; applied: string[] } | { ok: false; applied: []; error: string } {
  if (!opts.enabled) {
    lastAppliedShellEnvKeys = [];
    return { ok: true, applied: [] };
  }
  const hasAnyKey = opts.expectedKeys.some((key) => Boolean(opts.env[key]?.trim()));
  if (hasAnyKey) {
    lastAppliedShellEnvKeys = [];
    return { ok: true, applied: [] };
  }
  if (process.platform === "win32") {
    lastAppliedShellEnvKeys = [];
    return { ok: true, applied: [] };
  }
  const shell = opts.env.SHELL?.trim() || "/bin/sh";
  try {
    const stdout = execFileSync(shell, ["-l", "-c", "env -0"], {
      encoding: "buffer",
      timeout: opts.timeoutMs ?? 15_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...opts.env, HOME: os.homedir(), ZDOTDIR: undefined },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const applied: string[] = [];
    for (const part of stdout.toString("utf8").split("\0")) {
      const eq = part.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const key = part.slice(0, eq);
      if (!opts.expectedKeys.includes(key) || opts.env[key]?.trim()) {
        continue;
      }
      const value = part.slice(eq + 1);
      if (!value.trim()) {
        continue;
      }
      opts.env[key] = value;
      applied.push(key);
    }
    lastAppliedShellEnvKeys = [...applied];
    return { ok: true, applied };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    opts.logger?.warn?.(`[runtime] shell env fallback failed: ${message}`);
    lastAppliedShellEnvKeys = [];
    return { ok: false, applied: [], error: message };
  }
}

export function getShellEnvAppliedKeys(): string[] {
  return [...lastAppliedShellEnvKeys];
}

export function loadJsonFile(pathname: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(pathname, "utf8"));
  } catch {
    return undefined;
  }
}

export function saveJsonFile(pathname: string, value: unknown): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
