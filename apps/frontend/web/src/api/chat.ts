import { authFetch } from "./authFetch";
import type {
  ChatPrimeRequest,
  ChatPrimeResponse,
  ChatTurnRequest,
  ChatTurnResponse,
  ConfirmRequest,
  ConfirmResponse,
  ResolveExecutionRequest,
  ResolveExecutionResponse,
} from "@/domain/automation";

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

export async function chatPrime(
  request: ChatPrimeRequest,
  options?: { signal?: AbortSignal },
): Promise<ChatPrimeResponse> {
  const response = await fetch(toApiUrl("/api/chat/prime"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: options?.signal,
  });

  return parseJson<ChatPrimeResponse>(response);
}

export async function chatTurn(request: ChatTurnRequest): Promise<ChatTurnResponse> {
  const response = await authFetch("/api/chat/turn", {
    method: "POST",
    body: JSON.stringify(request),
  });

  return parseJson<ChatTurnResponse>(response);
}

export async function resolveExecution(
  request: ResolveExecutionRequest,
): Promise<ResolveExecutionResponse> {
  const response = await authFetch("/api/chat/resolve-execution", {
    method: "POST",
    body: JSON.stringify(request),
  });

  return parseJson<ResolveExecutionResponse>(response);
}

export async function confirmIntent(request: ConfirmRequest): Promise<ConfirmResponse> {
  const response = await authFetch("/api/chat/confirm", {
    method: "POST",
    body: JSON.stringify(request),
  });

  return parseJson<ConfirmResponse>(response);
}
