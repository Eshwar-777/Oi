export function isBrowserReasoningTagProvider(provider: string | undefined | null): boolean {
  if (!provider) {
    return false;
  }
  const normalized = provider.trim().toLowerCase();
  if (
    normalized === "google" ||
    normalized === "google-gemini-cli" ||
    normalized === "google-generative-ai"
  ) {
    return true;
  }
  return normalized.includes("minimax");
}
