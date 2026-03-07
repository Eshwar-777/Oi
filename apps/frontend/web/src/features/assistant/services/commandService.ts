import {
  chatPrime as apiChatPrime,
  chatTurn as apiChatTurn,
  confirmIntent as apiConfirmIntent,
  resolveExecution as apiResolveExecution,
} from "@/api/chat";
import { listGeminiModels } from "@/api/models";
import { getRun as apiGetRun, pauseRun as apiPauseRun, resumeRun as apiResumeRun, retryRun as apiRetryRun, stopRun as apiStopRun } from "@/api/runs";
import type {
  ChatPrimeRequest,
  ChatPrimeResponse,
  ChatTurnRequest,
  ChatTurnResponse,
  ConfirmRequest,
  ConfirmResponse,
  GeminiModelListResponse,
  ResolveExecutionRequest,
  ResolveExecutionResponse,
  RunControlResponse,
  RunDetailResponse,
} from "@/domain/automation";
import {
  mockChatPrime,
  mockChatTurn,
  mockConfirm,
  mockGetRun,
  mockResolveExecution,
  mockRunControl,
} from "@/mocks/automationMock";

export interface TransportResult<T> {
  payload: T;
  source: "api" | "mock";
}

async function withMockFallback<T>(primary: () => Promise<T>, fallback: () => Promise<T>) {
  try {
    return { payload: await primary(), source: "api" as const };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    return { payload: await fallback(), source: "mock" as const };
  }
}

export const commandService = {
  prepareTurn(
    request: ChatPrimeRequest,
    options?: { signal?: AbortSignal },
  ): Promise<TransportResult<ChatPrimeResponse>> {
    return withMockFallback(() => apiChatPrime(request, options), () => mockChatPrime(request));
  },
  sendTurn(request: ChatTurnRequest): Promise<TransportResult<ChatTurnResponse>> {
    return withMockFallback(() => apiChatTurn(request), () => mockChatTurn(request));
  },
  resolveExecution(
    request: ResolveExecutionRequest,
  ): Promise<TransportResult<ResolveExecutionResponse>> {
    return withMockFallback(() => apiResolveExecution(request), () => mockResolveExecution(request));
  },
  confirmIntent(request: ConfirmRequest): Promise<TransportResult<ConfirmResponse>> {
    return withMockFallback(() => apiConfirmIntent(request), () => mockConfirm(request));
  },
  getRun(runId: string): Promise<TransportResult<RunDetailResponse>> {
    return withMockFallback(() => apiGetRun(runId), () => mockGetRun(runId));
  },
  controlRun(
    runId: string,
    action: "pause" | "resume" | "stop" | "retry",
  ): Promise<TransportResult<RunControlResponse>> {
    return withMockFallback(
      () =>
        action === "pause"
          ? apiPauseRun(runId)
          : action === "resume"
            ? apiResumeRun(runId)
            : action === "stop"
              ? apiStopRun(runId)
              : apiRetryRun(runId),
      () => mockRunControl(runId, action),
    );
  },
  listModels(): Promise<GeminiModelListResponse> {
    return listGeminiModels();
  },
};
