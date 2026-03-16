import type { RuntimeConfig } from "../config/config.js";
import { compileSafeRegex } from "../security/safe-regex.js";

type BrowserRedactSensitiveMode = "off" | "tools";

const DEFAULT_REDACT_MODE: BrowserRedactSensitiveMode = "tools";
const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const DEFAULT_REDACT_KEEP_END = 4;

const DEFAULT_REDACT_PATTERNS: string[] = [
  String.raw`\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1`,
  String.raw`"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken)"\s*:\s*"([^"]+)"`,
  String.raw`--(?:api[-_]?key|token|secret|password|passwd)\s+(["']?)([^\s"']+)\1`,
  String.raw`Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)`,
  String.raw`\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b`,
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`,
];

type BrowserRedactOptions = {
  mode?: BrowserRedactSensitiveMode;
  patterns?: string[];
};

function normalizeMode(value?: string): BrowserRedactSensitiveMode {
  return value === "off" ? "off" : DEFAULT_REDACT_MODE;
}

function parsePattern(raw: string): RegExp | null {
  if (!raw.trim()) {
    return null;
  }
  const match = raw.match(/^\/(.+)\/([gimsuy]*)$/);
  if (match) {
    const flags = match[2].includes("g") ? match[2] : `${match[2]}g`;
    return compileSafeRegex(match[1], flags);
  }
  return compileSafeRegex(raw, "gi");
}

function resolvePatterns(value?: string[]): RegExp[] {
  const source = value?.length ? value : DEFAULT_REDACT_PATTERNS;
  return source.map(parsePattern).filter((re): re is RegExp => Boolean(re));
}

function maskToken(token: string): string {
  if (token.length < DEFAULT_REDACT_MIN_LENGTH) {
    return "***";
  }
  const start = token.slice(0, DEFAULT_REDACT_KEEP_START);
  const end = token.slice(-DEFAULT_REDACT_KEEP_END);
  return `${start}…${end}`;
}

function redactPemBlock(block: string): string {
  const lines = block.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return "***";
  }
  return `${lines[0]}\n…redacted…\n${lines[lines.length - 1]}`;
}

function redactMatch(match: string, groups: string[]): string {
  if (match.includes("PRIVATE KEY-----")) {
    return redactPemBlock(match);
  }
  const token =
    groups.filter((value) => typeof value === "string" && value.length > 0).at(-1) ?? match;
  const masked = maskToken(token);
  return token === match ? masked : match.replace(token, masked);
}

function redactText(text: string, patterns: RegExp[]): string {
  let next = text;
  for (const pattern of patterns) {
    next = next.replace(pattern, (...args) =>
      redactMatch(args[0], args.slice(1, args.length - 2) as string[]),
    );
  }
  return next;
}

function resolveConfigRedaction(config?: RuntimeConfig): BrowserRedactOptions {
  return {
    mode: normalizeMode(config?.logging?.redactSensitive),
    patterns: config?.logging?.redactPatterns,
  };
}

export function redactBrowserSensitiveText(
  text: string,
  options?: BrowserRedactOptions,
  config?: RuntimeConfig,
): string {
  if (!text) {
    return text;
  }
  const resolved = options ?? resolveConfigRedaction(config);
  if (normalizeMode(resolved.mode) === "off") {
    return text;
  }
  const patterns = resolvePatterns(resolved.patterns);
  return patterns.length > 0 ? redactText(text, patterns) : text;
}
