import { authFetch } from "./authFetch";
import type {
  ChatSessionStateResponse,
  ChatTurnRequest,
  ChatTurnResponse,
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
  const response = await authFetch("/api/chat/turn", {
    method: "POST",
    body: JSON.stringify(request),
  });

  return parseJson<ChatTurnResponse>(response);
}

export async function getChatSessionState(sessionId: string): Promise<ChatSessionStateResponse> {
  const response = await authFetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET",
  });

  return parseJson<ChatSessionStateResponse>(response);
}
