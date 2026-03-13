import type { ThinkLevel } from "../pi-embedded-runner/browser-thinking-types.js";

function normalizeThinkLevel(raw?: string | null): ThinkLevel | undefined {
  if (!raw) {
    return undefined;
  }
  const key = raw.trim().toLowerCase();
  const collapsed = key.replace(/[\s_-]+/g, "");
  if (collapsed === "adaptive" || collapsed === "auto") {
    return "adaptive";
  }
  if (collapsed === "xhigh" || collapsed === "extrahigh") {
    return "xhigh";
  }
  if (key === "off") {
    return "off";
  }
  if (key === "on" || key === "enable" || key === "enabled") {
    return "low";
  }
  if (key === "min" || key === "minimal") {
    return "minimal";
  }
  if (key === "low" || key === "thinkhard" || key === "think-hard" || key === "think_hard") {
    return "low";
  }
  if (
    key === "mid" ||
    key === "med" ||
    key === "medium" ||
    key === "thinkharder" ||
    key === "think-harder" ||
    key === "harder"
  ) {
    return "medium";
  }
  if (
    key === "high" ||
    key === "ultra" ||
    key === "ultrathink" ||
    key === "think-hard" ||
    key === "thinkhardest" ||
    key === "highest" ||
    key === "max"
  ) {
    return "high";
  }
  if (key === "think") {
    return "minimal";
  }
  return undefined;
}

function extractSupportedValues(raw: string): string[] {
  const match =
    raw.match(/supported values are:\s*([^\n.]+)/i) ?? raw.match(/supported values:\s*([^\n.]+)/i);
  if (!match?.[1]) {
    return [];
  }
  const fragment = match[1];
  const quoted = Array.from(fragment.matchAll(/['"]([^'"]+)['"]/g)).map((entry) =>
    entry[1]?.trim(),
  );
  if (quoted.length > 0) {
    return quoted.filter((entry): entry is string => Boolean(entry));
  }
  return fragment
    .split(/,|\band\b/gi)
    .map((entry) => entry.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, "").trim())
    .filter(Boolean);
}

export function pickFallbackThinkingLevel(params: {
  message?: string;
  attempted: Set<ThinkLevel>;
}): ThinkLevel | undefined {
  const raw = params.message?.trim();
  if (!raw) {
    return undefined;
  }
  const supported = extractSupportedValues(raw);
  if (supported.length === 0) {
    // When the error clearly indicates the thinking level is unsupported but doesn't
    // list supported values (e.g. OpenAI's "think value \"low\" is not supported for
    // this model"), fall back to "off" to allow the request to succeed.
    // This commonly happens during model fallback when switching from Anthropic
    // (which supports thinking levels) to providers that don't.
    if (/not supported/i.test(raw) && !params.attempted.has("off")) {
      return "off";
    }
    return undefined;
  }
  for (const entry of supported) {
    const normalized = normalizeThinkLevel(entry);
    if (!normalized) {
      continue;
    }
    if (params.attempted.has(normalized)) {
      continue;
    }
    return normalized;
  }
  return undefined;
}
