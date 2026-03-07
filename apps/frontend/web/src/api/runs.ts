import { toApiUrl } from "@/lib/api";
import type { RunControlResponse, RunDetailResponse } from "@/domain/automation";

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

export async function getRun(runId: string): Promise<RunDetailResponse> {
  const response = await fetch(toApiUrl(`/api/runs/${encodeURIComponent(runId)}`), {
    headers: { "Content-Type": "application/json" },
  });

  return parseJson<RunDetailResponse>(response);
}

async function controlRun(runId: string, action: "pause" | "resume" | "stop" | "retry") {
  const response = await fetch(toApiUrl(`/api/runs/${encodeURIComponent(runId)}/${action}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  return parseJson<RunControlResponse>(response);
}

export const pauseRun = (runId: string) => controlRun(runId, "pause");
export const resumeRun = (runId: string) => controlRun(runId, "resume");
export const stopRun = (runId: string) => controlRun(runId, "stop");
export const retryRun = (runId: string) => controlRun(runId, "retry");
