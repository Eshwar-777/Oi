import { useCallback, useMemo, useRef, useState } from "react";
import { getApiBaseUrl } from "@/lib/api";
import { getAccessToken } from "@/lib/authHeaders";
import { isMobileAuthBypassEnabled } from "@/lib/devFlags";

type LiveVisionState = "idle" | "connecting" | "ready" | "error";

function websocketUrl() {
  const api = new URL(getApiBaseUrl());
  api.protocol = api.protocol === "https:" ? "wss:" : "ws:";
  api.pathname = "/ws";
  api.search = "";
  return api.toString();
}

function getLiveAuthErrorMessage(detail?: string) {
  if (String(detail || "").trim().toLowerCase() === "unauthorized") {
    return "Live mode needs a signed-in mobile build. Sign in on the phone, or enable EXPO_PUBLIC_BYPASS_MOBILE_AUTH=true for local dev.";
  }
  return detail || "Live vision failed.";
}

export function useLiveVision(options?: { onAssistantText?: (text: string) => void }) {
  const [state, setState] = useState<LiveVisionState>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const deviceIdRef = useRef(`mobile:${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`);
  const imageAckPromiseRef = useRef<Promise<void> | null>(null);
  const imageAckResolveRef = useRef<(() => void) | null>(null);
  const imageAckRejectRef = useRef<((error: Error) => void) | null>(null);

  const clearPendingImageAck = useCallback((message?: string) => {
    if (message && imageAckRejectRef.current) {
      imageAckRejectRef.current(new Error(message));
    }
    imageAckPromiseRef.current = null;
    imageAckResolveRef.current = null;
    imageAckRejectRef.current = null;
  }, []);

  const sendFrame = useCallback((payload: Record<string, unknown>) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      throw new Error("Live vision connection is not ready.");
    }
    socketRef.current.send(JSON.stringify({
      type: "voice_stream",
      payload,
      timestamp: new Date().toISOString(),
    }));
  }, []);

  const ensureSession = useCallback(async () => {
    if (sessionId && socketRef.current?.readyState === WebSocket.OPEN) {
      return sessionId;
    }
    const token = await getAccessToken(true);
    if (!token && !isMobileAuthBypassEnabled()) {
      throw new Error(getLiveAuthErrorMessage("Unauthorized"));
    }
    const socket = new WebSocket(websocketUrl());
    socketRef.current = socket;
    setState("connecting");
    setError("");

    const nextSessionId = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Live vision session did not start.")), 10_000);
      socket.onopen = () => {
        socket.send(JSON.stringify({
          type: "auth",
          payload: {
            token: token || undefined,
            device_id: deviceIdRef.current,
          },
          timestamp: new Date().toISOString(),
        }));
      };
      socket.onmessage = (event) => {
        const frame = JSON.parse(String(event.data || "{}")) as { type?: string; detail?: string; payload?: Record<string, unknown> };
        if (frame.type === "auth_ok") {
          sendFrame({ event: "start" });
          return;
        }
        if (frame.type === "error") {
          clearTimeout(timeout);
          reject(new Error(getLiveAuthErrorMessage(String(frame.detail || ""))));
          return;
        }
        if (frame.type !== "voice_stream") return;
        const payload = frame.payload || {};
        const eventType = String(payload.event || "");
        if (eventType === "session_started") {
          clearTimeout(timeout);
          resolve(String(payload.live_session_id || ""));
          return;
        }
        if (eventType === "image_input_ack") {
          imageAckResolveRef.current?.();
          clearPendingImageAck();
          return;
        }
        if (eventType === "text_output" && typeof payload.text === "string") {
          options?.onAssistantText?.(payload.text);
          return;
        }
        if (eventType === "error") {
          setError(String(payload.message || "Live vision failed."));
          setState("error");
        }
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Could not connect live vision."));
      };
      socket.onclose = () => {
        setState((current) => (current === "error" ? current : "idle"));
        setIsStreaming(false);
        setSessionId(null);
        clearPendingImageAck("Live vision connection closed.");
      };
    });

    setSessionId(nextSessionId);
    setState("ready");
    return nextSessionId;
  }, [clearPendingImageAck, options, sendFrame, sessionId]);

  const sendImage = useCallback(async (payload: { dataUrl: string; mimeType: string }) => {
    const currentSessionId = await ensureSession();
    const [, encoded = ""] = payload.dataUrl.split(",", 2);
    if (!imageAckPromiseRef.current) {
      imageAckPromiseRef.current = new Promise<void>((resolve, reject) => {
        imageAckResolveRef.current = resolve;
        imageAckRejectRef.current = reject;
        setTimeout(() => {
          if (imageAckPromiseRef.current) {
            clearPendingImageAck("Live vision frame send timed out.");
          }
        }, 5_000);
      });
    }
    sendFrame({
      event: "image_input",
      image_data: encoded,
      mime_type: payload.mimeType,
      live_session_id: currentSessionId,
    });
    await imageAckPromiseRef.current;
  }, [clearPendingImageAck, ensureSession, sendFrame]);

  const stop = useCallback(() => {
    setIsStreaming(false);
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: "voice_stream",
        payload: { event: "stop", live_session_id: sessionId || undefined },
        timestamp: new Date().toISOString(),
      }));
    }
    socketRef.current?.close();
    socketRef.current = null;
    setSessionId(null);
    clearPendingImageAck("Live vision session stopped.");
  }, [clearPendingImageAck, sessionId]);

  const api = useMemo(() => ({
    state,
    sessionId,
    isStreaming,
    error,
    startStreaming: async () => {
      await ensureSession();
      setIsStreaming(true);
    },
    stopStreaming: () => stop(),
    sendImage,
  }), [ensureSession, error, isStreaming, sendImage, sessionId, state, stop]);

  return api;
}
