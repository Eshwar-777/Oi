export type ReasoningTagMode = "strict" | "preserve";
export type ReasoningTagTrim = "none" | "start" | "both";

export function stripReasoningTagsFromText(
  text: string,
  options?: { mode?: ReasoningTagMode; trim?: ReasoningTagTrim },
): string {
  if (!text || !/<\s*\/?\s*(?:think(?:ing)?|thought|antthinking|final)\b/i.test(text)) {
    return text;
  }
  const mode = options?.mode ?? "strict";
  const trim = options?.trim ?? "both";
  let cleaned = text.replace(/<\s*\/?\s*final\b[^<>]*>/gi, "");
  cleaned = cleaned.replace(/<\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>[\s\S]*?<\s*\/\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi, "");
  if (mode === "preserve") {
    cleaned = cleaned.replace(/<\s*\/?\s*(?:think(?:ing)?|thought|antthinking)\b[^<>]*>/gi, "");
  }
  if (trim === "start") {
    return cleaned.trimStart();
  }
  if (trim === "both") {
    return cleaned.trim();
  }
  return cleaned;
}
