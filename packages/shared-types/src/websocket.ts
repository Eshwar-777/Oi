export type WebSocketFrameType =
  | "auth"
  | "runner_auth"
  | "auth_ok"
  | "voice_stream"
  | "extension_command"
  | "extension_result"
  | "browser_frame"
  | "session_frame"
  | "session_event"
  | "session_stream_subscribe"
  | "session_stream_unsubscribe"
  | "session_control"
  | "browser_stream_subscribe"
  | "browser_stream_unsubscribe"
  | "start_screenshot_stream"
  | "stop_screenshot_stream"
  | "error"
  | "ping"
  | "pong";

export interface IWebSocketFrame {
  type: WebSocketFrameType;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface IVoiceStreamFrame extends IWebSocketFrame {
  type: "voice_stream";
  payload: {
    event:
      | "start"
      | "stop"
      | "audio_input"
      | "image_input"
      | "text_input"
      | "end_turn"
      | "session_started"
      | "session_stopped"
      | "audio_input_ack"
      | "image_input_ack"
      | "text_input_ack"
      | "turn_committed"
      | "turn_complete"
      | "audio_output"
      | "text_output"
      | "error";
    live_session_id?: string;
    audio_data?: string;
    image_data?: string;
    sample_rate?: number;
    is_final?: boolean;
    mime_type?: string;
    text?: string;
    message?: string;
    bytes?: number;
    conversation_id?: string;
    session_id?: string;
    automation_engine?: "agent_browser" | "computer_use";
  };
}

export interface IAuthFrame extends IWebSocketFrame {
  type: "auth";
  payload: {
    token?: string;
    device_id: string;
  };
}

export interface IRunnerAuthFrame extends IWebSocketFrame {
  type: "runner_auth";
  payload: {
    secret: string;
    runner_id: string;
    user_id: string;
    session_id?: string;
  };
}

export type ExtensionAction =
  | "navigate"
  | "click"
  | "type"
  | "scroll"
  | "hover"
  | "wait"
  | "select"
  | "keyboard"
  | "screenshot"
  | "read_dom"
  | "extract_structured"
  | "highlight"
  | "snapshot"
  | "act";

export interface IExtensionCommandFrame extends IWebSocketFrame {
  type: "extension_command";
  payload: {
    run_id: string;
    action: ExtensionAction;
    target: string | Record<string, unknown>;
    value?: string;
  };
}

export interface IBrowserFrame extends IWebSocketFrame {
  type: "browser_frame";
  payload: {
    screenshot: string;
    current_url: string;
    page_title: string;
    run_id: string;
    step_index?: number;
    step_label?: string;
    total_steps?: number;
    timestamp: string;
  };
}

export interface ISessionFrame extends IWebSocketFrame {
  type: "session_frame";
  payload: {
    session_id: string;
    screenshot?: string;
    current_url?: string;
    page_title?: string;
    page_id?: string;
    timestamp: string;
  };
}
