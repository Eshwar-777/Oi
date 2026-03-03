import type { IWebSocketFrame } from "@oi/shared-types";

type MessageHandler = (frame: IWebSocketFrame) => void;

export class OiWebSocketClient {
  private url: string;
  private socket: WebSocket | null = null;
  private handlers: Map<string, Set<MessageHandler>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private token: string | null = null;
  private deviceId: string | null = null;

  constructor(url: string) {
    this.url = url;
  }

  connect(token: string, deviceId: string): void {
    this.token = token;
    this.deviceId = deviceId;
    this.socket = new WebSocket(this.url);

    this.socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.send({
        type: "auth",
        payload: {
          token,
          device_id: deviceId,
        },
        timestamp: new Date().toISOString(),
      });
    };

    this.socket.onmessage = (event) => {
      try {
        const frame: IWebSocketFrame = JSON.parse(event.data);
        const typeHandlers = this.handlers.get(frame.type);
        if (typeHandlers) {
          typeHandlers.forEach((handler) => handler(frame));
        }
        const allHandlers = this.handlers.get("*");
        if (allHandlers) {
          allHandlers.forEach((handler) => handler(frame));
        }
      } catch {
        // skip malformed frames
      }
    };

    this.socket.onclose = () => {
      if (this.reconnectAttempts < this.maxReconnectAttempts && this.token && this.deviceId) {
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        const reconnectToken = this.token;
        const reconnectDeviceId = this.deviceId;
        setTimeout(() => this.connect(reconnectToken, reconnectDeviceId), delay);
      }
    };
  }

  on(type: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  send(frame: IWebSocketFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  disconnect(): void {
    this.maxReconnectAttempts = 0;
    this.token = null;
    this.deviceId = null;
    this.socket?.close();
    this.socket = null;
  }
}
