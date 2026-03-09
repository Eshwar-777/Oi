import type { GeminiModelListResponse } from "@/domain/automation";
import { authFetch } from "./authFetch";

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
  const cloudLocation = import.meta.env.VITE_GOOGLE_CLOUD_LOCATION;
  const projectId = import.meta.env.VITE_GOOGLE_CLOUD_PROJECT;
  const url = `https://${cloudLocation}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${cloudLocation}/publishers/google/models`;

  if (!geminiModelsRequest) {
    geminiModelsRequest = authFetch("/api/models/gemini")
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
