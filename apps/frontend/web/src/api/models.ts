import { toApiUrl } from "@/lib/api";
import type { GeminiModelListResponse } from "@/domain/automation";

let cachedGeminiModels: GeminiModelListResponse | null = null;
let geminiModelsRequest: Promise<GeminiModelListResponse> | null = null;

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message =
      typeof (body as { detail?: unknown }).detail === "string"
        ? (body as { detail: string }).detail
        : `Request failed with status ${response.status}`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function listGeminiModels(): Promise<GeminiModelListResponse> {
  if (cachedGeminiModels) {
    return cachedGeminiModels;
  }

  if (!geminiModelsRequest) {
    geminiModelsRequest = fetch(toApiUrl("/api/models/gemini"))
      .then((response) => parseJson<GeminiModelListResponse>(response))
      .then((payload) => {
        cachedGeminiModels = payload;
        return payload;
      })
      .finally(() => {
        geminiModelsRequest = null;
      });
  }

  return geminiModelsRequest;
}
