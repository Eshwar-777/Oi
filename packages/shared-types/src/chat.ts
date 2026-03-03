export interface IChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  attachments?: IChatAttachment[];
}

export interface IChatAttachment {
  type: "image" | "document" | "audio";
  url: string;
  mime_type: string;
  filename?: string;
}

export interface IConversation {
  session_id: string;
  user_id: string;
  messages: IChatMessage[];
  created_at: string;
  updated_at: string;
}

export interface IChatRequest {
  user_id: string;
  session_id: string;
  message: string;
  device_id?: string;
}

export interface IChatResponse {
  response: string;
  session_id: string;
  task_created?: string;
}
