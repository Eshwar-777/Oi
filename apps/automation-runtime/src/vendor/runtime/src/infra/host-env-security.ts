const PORTABLE_ENV_VAR_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BLOCKED_ENV_KEYS = new Set(["NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD"]);
const BLOCKED_OVERRIDE_ENV_KEYS = new Set(["PATH"]);

export function normalizeEnvVarKey(rawKey: string, options?: { portable?: boolean }): string | null {
  const key = rawKey.trim();
  if (!key) {
    return null;
  }
  if (options?.portable && !PORTABLE_ENV_VAR_KEY.test(key)) {
    return null;
  }
  return key;
}

export function isDangerousHostEnvVarName(rawKey: string): boolean {
  const key = normalizeEnvVarKey(rawKey);
  return Boolean(key && BLOCKED_ENV_KEYS.has(key.toUpperCase()));
}

export function isDangerousHostEnvOverrideVarName(rawKey: string): boolean {
  const key = normalizeEnvVarKey(rawKey);
  return Boolean(key && BLOCKED_OVERRIDE_ENV_KEYS.has(key.toUpperCase()));
}

export function sanitizeHostExecEnv(params?: {
  baseEnv?: Record<string, string | undefined>;
  overrides?: Record<string, string> | null;
  blockPathOverrides?: boolean;
}): Record<string, string> {
  const baseEnv = params?.baseEnv ?? process.env;
  const merged: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(baseEnv)) {
    if (typeof value !== "string") {
      continue;
    }
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key || isDangerousHostEnvVarName(key)) {
      continue;
    }
    merged[key] = value;
  }
  for (const [rawKey, value] of Object.entries(params?.overrides ?? {})) {
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key || typeof value !== "string") {
      continue;
    }
    if (params?.blockPathOverrides !== false && key.toUpperCase() === "PATH") {
      continue;
    }
    if (isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key)) {
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

export function sanitizeSystemRunEnvOverrides(params?: {
  overrides?: Record<string, string> | null;
}): Record<string, string> | undefined {
  return params?.overrides ?? undefined;
}
