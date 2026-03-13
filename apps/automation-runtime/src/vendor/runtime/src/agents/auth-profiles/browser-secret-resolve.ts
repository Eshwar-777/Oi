import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "../../config/config.js";
import type {
  ExecSecretProviderConfig,
  FileSecretProviderConfig,
  SecretRef,
} from "../../config/types.secrets.js";

export type BrowserSecretRefResolveCache = {
  resolvedByRefKey?: Map<string, Promise<string>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveBrowserUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    if (home) {
      return path.resolve(path.join(home, trimmed.slice(1)));
    }
  }
  return path.resolve(trimmed);
}

function secretRefKey(ref: SecretRef): string {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

function readJsonPointer(payload: unknown, pointer: string): unknown {
  if (pointer === "value") {
    return payload;
  }
  let current: unknown = payload;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} did not resolve to a non-empty string.`);
  }
  return value.trim();
}

async function resolveEnvRef(ref: SecretRef, config: RuntimeConfig, env: NodeJS.ProcessEnv) {
  const provider = config.secrets?.providers?.[ref.provider];
  if (provider?.source !== "env" && ref.provider !== (config.secrets?.defaults?.env ?? "default")) {
    throw new Error(`Secret provider "${ref.provider}" is not configured for env refs.`);
  }
  const allowlist = provider?.source === "env" ? provider.allowlist : undefined;
  if (Array.isArray(allowlist) && allowlist.length > 0 && !allowlist.includes(ref.id)) {
    throw new Error(`Env secret "${ref.id}" is not allowlisted for provider "${ref.provider}".`);
  }
  return requireString(env[ref.id], `Env secret "${ref.id}"`);
}

async function resolveFileRef(ref: SecretRef, config: RuntimeConfig) {
  const provider = config.secrets?.providers?.[ref.provider];
  if (!provider || provider.source !== "file") {
    throw new Error(`Secret provider "${ref.provider}" is not configured for file refs.`);
  }
  const fileProvider = provider as FileSecretProviderConfig;
  const raw = await fs.readFile(resolveBrowserUserPath(fileProvider.path), "utf8");
  const payload = fileProvider.mode === "singleValue" ? raw.trim() : JSON.parse(raw);
  return requireString(readJsonPointer(payload, ref.id), `File secret ref "${ref.id}"`);
}

async function runExecResolver(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: path.dirname(params.command),
      env: params.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Secret exec resolver timed out after ${params.timeoutMs}ms.`));
    }, params.timeoutMs);
    const append = (chunk: Buffer | string, stream: "stdout" | "stderr") => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      outputBytes += Buffer.byteLength(text, "utf8");
      if (outputBytes > params.maxOutputBytes) {
        child.kill("SIGKILL");
        reject(new Error("Secret exec resolver exceeded max output."));
        return;
      }
      if (stream === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
    };
    child.stdout.on("data", (chunk) => append(chunk, "stdout"));
    child.stderr.on("data", (chunk) => append(chunk, "stderr"));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Secret exec resolver exited with code ${String(code)}.`));
        return;
      }
      resolve(stdout);
    });
    child.stdin.end(params.input);
  });
}

async function resolveExecRef(ref: SecretRef, config: RuntimeConfig, env: NodeJS.ProcessEnv) {
  const provider = config.secrets?.providers?.[ref.provider];
  if (!provider || provider.source !== "exec") {
    throw new Error(`Secret provider "${ref.provider}" is not configured for exec refs.`);
  }
  const execProvider = provider as ExecSecretProviderConfig;
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of execProvider.passEnv ?? []) {
    if (env[key] !== undefined) {
      childEnv[key] = env[key];
    }
  }
  for (const [key, value] of Object.entries(execProvider.env ?? {})) {
    childEnv[key] = value;
  }
  const stdout = await runExecResolver({
    command: resolveBrowserUserPath(execProvider.command),
    args: execProvider.args ?? [],
    env: childEnv,
    input: JSON.stringify({ protocolVersion: 1, provider: ref.provider, ids: [ref.id] }),
    timeoutMs: Math.max(1, Math.floor(execProvider.timeoutMs ?? 5_000)),
    maxOutputBytes: Math.max(1, Math.floor(execProvider.maxOutputBytes ?? 1024 * 1024)),
  });
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`Exec provider "${ref.provider}" returned empty stdout.`);
  }
  if (execProvider.jsonOnly === false) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      return trimmed;
    }
  }
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  if (parsed.protocolVersion !== 1 || !isRecord(parsed.values)) {
    throw new Error(`Exec provider "${ref.provider}" returned an invalid response.`);
  }
  return requireString(parsed.values[ref.id], `Exec secret ref "${ref.id}"`);
}

async function resolveRefValue(ref: SecretRef, config: RuntimeConfig, env: NodeJS.ProcessEnv) {
  if (ref.source === "env") {
    return await resolveEnvRef(ref, config, env);
  }
  if (ref.source === "file") {
    return await resolveFileRef(ref, config);
  }
  return await resolveExecRef(ref, config, env);
}

export async function resolveBrowserSecretRefString(
  ref: SecretRef,
  params: {
    config: RuntimeConfig;
    env?: NodeJS.ProcessEnv;
    cache?: BrowserSecretRefResolveCache;
  },
): Promise<string> {
  const env = params.env ?? process.env;
  const cache = params.cache;
  const key = secretRefKey(ref);
  const resolvedByRefKey = cache?.resolvedByRefKey ?? new Map<string, Promise<string>>();
  if (cache && !cache.resolvedByRefKey) {
    cache.resolvedByRefKey = resolvedByRefKey;
  }
  const cached = resolvedByRefKey.get(key);
  if (cached) {
    return await cached;
  }
  const pending = resolveRefValue(ref, params.config, env);
  resolvedByRefKey.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    resolvedByRefKey.delete(key);
    throw error;
  }
}
