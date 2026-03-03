export type WebSocketFrameType =
  | "auth"
  | "auth_ok"
  | "task_update"
  | "voice_stream"
  | "extension_command"
  | "extension_result"
  | "error"
  | "ping"
  | "pong";

export interface IWebSocketFrame {
  type: WebSocketFrameType;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface ITaskUpdateFrame extends IWebSocketFrame {
  type: "task_update";
  payload: {
    task_id: string;
    status: string;
    current_step_index: number;
    message: string;
  };
}

export interface IVoiceStreamFrame extends IWebSocketFrame {
  type: "voice_stream";
  payload: {
    audio_data: string;
    sample_rate: number;
    is_final: boolean;
  };
}

export interface IAuthFrame extends IWebSocketFrame {
  type: "auth";
  payload: {
    token?: string;
    device_id: string;
  };
}

export interface IExtensionCommandFrame extends IWebSocketFrame {
  type: "extension_command";
  payload: {
    task_id: string;
    action: "navigate" | "click" | "type" | "screenshot" | "read_dom";
    target: string;
    value?: string;
  };
}
