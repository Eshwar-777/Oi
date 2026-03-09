import type { RunControlResponse, RunDetailResponse } from "@/domain/automation";
import { authFetch } from "./authFetch";

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
  const response = await authFetch(`/api/runs/${encodeURIComponent(runId)}`);

  return parseJson<RunDetailResponse>(response);
}

async function controlRun(runId: string, action: "pause" | "resume" | "stop" | "retry" | "approve") {
  const path =
    action === "approve"
      ? `/api/runs/${encodeURIComponent(runId)}/approve-sensitive-action`
      : `/api/runs/${encodeURIComponent(runId)}/${action}`;
  const response = await authFetch(path, {
    method: "POST",
  });

  return parseJson<RunControlResponse>(response);
}

export const pauseRun = (runId: string) => controlRun(runId, "pause");
export const resumeRun = (runId: string) => controlRun(runId, "resume");
export const stopRun = (runId: string) => controlRun(runId, "stop");
export const retryRun = (runId: string) => controlRun(runId, "retry");
export const approveSensitiveActionRun = (runId: string) => controlRun(runId, "approve");
