// Defaults for agent metadata when upstream does not supply them.
// automation-runtime is Gemini-only, so fall back to Google's catalog.
export const DEFAULT_PROVIDER = "google";
export const DEFAULT_MODEL = "gemini-3.1-pro-preview";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
