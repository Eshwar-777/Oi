import { authFetch } from "./authFetch";
import type {
  ChatSessionStateResponse,
  ChatTurnRequest,
  ChatTurnResponse,
  ConversationListResponse,
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

export async function chatConversationTurn(
  conversationId: string,
  request: ChatTurnRequest,
): Promise<ChatTurnResponse> {
  const response = await authFetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}/turn`, {
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

export async function listChatConversations(): Promise<ConversationListResponse> {
  const response = await authFetch("/api/chat/conversations");
  return parseJson<ConversationListResponse>(response);
}

export async function createChatConversation(payload?: { title?: string; model_id?: string }): Promise<ChatSessionStateResponse> {
  const response = await authFetch("/api/chat/conversations", {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
  return parseJson<ChatSessionStateResponse>(response);
}

export async function getConversationState(conversationId: string): Promise<ChatSessionStateResponse> {
  const response = await authFetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}`);
  return parseJson<ChatSessionStateResponse>(response);
}
