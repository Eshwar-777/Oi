import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../config/browser-support.js";

export const KILOCODE_BASE_URL = "https://api.kilo.ai/api/gateway/";
export const KILOCODE_DEFAULT_MODEL_ID = "kilo/auto";
export const KILOCODE_DEFAULT_MODEL_NAME = "Kilo Auto";
export const KILOCODE_MODEL_CATALOG = [
  {
    id: KILOCODE_DEFAULT_MODEL_ID,
    name: KILOCODE_DEFAULT_MODEL_NAME,
    reasoning: true,
    input: ["text", "image"] as Array<"text" | "image">,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
];
export const KILOCODE_DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const KILOCODE_DEFAULT_MAX_TOKENS = 128_000;
export const KILOCODE_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
export const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";

type CachedCopilotToken = {
  token: string;
  expiresAt: number;
  updatedAt: number;
};

function resolveCopilotTokenCachePath(env: NodeJS.ProcessEnv = process.env) {
  return path.join(resolveStateDir(env), "credentials", "github-copilot.token.json");
}

function isTokenUsable(cache: CachedCopilotToken, now = Date.now()): boolean {
  return cache.expiresAt - now > 5 * 60 * 1000;
}

function parseCopilotTokenResponse(value: unknown): { token: string; expiresAt: number } {
  if (!value || typeof value !== "object") {
    throw new Error("Unexpected response from GitHub Copilot token endpoint");
  }
  const asRecord = value as Record<string, unknown>;
  const token = asRecord.token;
  const expiresAt = asRecord.expires_at;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("Copilot token response missing token");
  }
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    return {
      token,
      expiresAt: expiresAt > 10_000_000_000 ? expiresAt : expiresAt * 1000,
    };
  }
  if (typeof expiresAt === "string" && expiresAt.trim()) {
    const parsed = Number.parseInt(expiresAt, 10);
    if (Number.isFinite(parsed)) {
      return {
        token,
        expiresAt: parsed > 10_000_000_000 ? parsed : parsed * 1000,
      };
    }
  }
  throw new Error("Copilot token response missing expires_at");
}

function deriveCopilotApiBaseUrlFromToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  const proxyEp = match?.[1]?.trim();
  if (!proxyEp) {
    return null;
  }
  const host = proxyEp.replace(/^https?:\/\//, "").replace(/^proxy\./i, "api.");
  return host ? `https://${host}` : null;
}

export async function resolveBrowserCopilotApiToken(params: {
  githubToken: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<{ token: string; expiresAt: number; baseUrl: string }> {
  const env = params.env ?? process.env;
  const cachePath = resolveCopilotTokenCachePath(env);
  const cached = loadJsonFile(cachePath) as CachedCopilotToken | undefined;
  if (cached && typeof cached.token === "string" && typeof cached.expiresAt === "number") {
    if (isTokenUsable(cached)) {
      return {
        token: cached.token,
        expiresAt: cached.expiresAt,
        baseUrl: deriveCopilotApiBaseUrlFromToken(cached.token) ?? DEFAULT_COPILOT_API_BASE_URL,
      };
    }
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const res = await fetchImpl(COPILOT_TOKEN_URL, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${params.githubToken}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Copilot token exchange failed: HTTP ${res.status}`);
  }

  const json = parseCopilotTokenResponse(await res.json());
  const payload: CachedCopilotToken = {
    token: json.token,
    expiresAt: json.expiresAt,
    updatedAt: Date.now(),
  };
  saveJsonFile(cachePath, payload);

  return {
    token: payload.token,
    expiresAt: payload.expiresAt,
    baseUrl: deriveCopilotApiBaseUrlFromToken(payload.token) ?? DEFAULT_COPILOT_API_BASE_URL,
  };
}

export function normalizeBrowserOptionalSecretInput(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const collapsed = value.replace(/[\r\n\u2028\u2029]+/g, "");
  let latin1Only = "";
  for (const char of collapsed) {
    const codePoint = char.codePointAt(0);
    if (typeof codePoint === "number" && codePoint <= 0xff) {
      latin1Only += char;
    }
  }
  const normalized = latin1Only.trim();
  return normalized || undefined;
}
