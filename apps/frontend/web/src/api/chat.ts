import { toApiUrl } from "@/lib/api";
import type {
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

export async function chatTurn(request: ChatTurnRequest): Promise<ChatTurnResponse> {
  const response = await fetch(toApiUrl("/api/chat/turn"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  return parseJson<ChatTurnResponse>(response);
}

export async function resolveExecution(
  request: ResolveExecutionRequest,
): Promise<ResolveExecutionResponse> {
  const response = await fetch(toApiUrl("/api/chat/resolve-execution"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  return parseJson<ResolveExecutionResponse>(response);
}

export async function confirmIntent(request: ConfirmRequest): Promise<ConfirmResponse> {
  const response = await fetch(toApiUrl("/api/chat/confirm"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  return parseJson<ConfirmResponse>(response);
}
