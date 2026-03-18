import { useEffect, useRef, useState } from "react";
import { authFetch } from "@/api/authFetch";
import { getCurrentAccessToken } from "@/features/auth/session";
import { toApiUrl } from "@/lib/api";

type LiveConnectionState = "idle" | "connecting" | "ready" | "error";
type LivePermissionState = "unknown" | "granted" | "prompt" | "denied" | "unsupported";
const MEDIA_REQUEST_TIMEOUT_MS = 8_000;
const MIN_TURN_CAPTURE_MS = 7_800;
const SILENCE_COMMIT_MS = 10_200;
const NO_SPEECH_TIMEOUT_MS = 30_000;
const SPEECH_RMS_THRESHOLD = 0.015;
const LIVE_TTS_TIMEOUT_MS = 450;

export interface LiveTranscriptLine {
  id: string;
  role: "assistant" | "system";
  text: string;
  timestamp: string;
}

function shouldJoinTranscriptLines(
  previous: LiveTranscriptLine | undefined,
  role: LiveTranscriptLine["role"],
  timestamp: string,
) {
  if (!previous || previous.role !== role) return false;
  const previousTime = Date.parse(previous.timestamp);
  const nextTime = Date.parse(timestamp);
  if (Number.isNaN(previousTime) || Number.isNaN(nextTime)) return false;
  return nextTime - previousTime < 8_000;
}

function isNearDuplicateTranscriptLine(
  previous: LiveTranscriptLine | undefined,
  role: LiveTranscriptLine["role"],
  text: string,
  timestamp: string,
) {
  if (!previous || previous.role !== role) return false;
  if (previous.text.trim() !== text.trim()) return false;
  const previousTime = Date.parse(previous.timestamp);
  const nextTime = Date.parse(timestamp);
  if (Number.isNaN(previousTime) || Number.isNaN(nextTime)) return false;
  return nextTime - previousTime < 2_500;
}

function joinTranscriptText(previous: string, next: string) {
  const left = previous.trimEnd();
  const right = next.trim();
  if (!left) return right;
  if (!right) return left;
  const separator = /[\\s([{]$/.test(left) || /^[,.;!?)]/.test(right) ? "" : " ";
  return `${left}${separator}${right}`;
}

export interface LiveMultimodalState {
  connectionState: LiveConnectionState;
  permissionState: LivePermissionState;
  isSessionActive: boolean;
  isRecording: boolean;
  isAssistantResponding: boolean;
  isVisionStreaming: boolean;
  liveSessionId: string | null;
  transcript: LiveTranscriptLine[];
  error: string;
  statusMessage: string;
  startSession: () => Promise<void>;
  stopSession: () => Promise<void>;
  startRecording: (options?: { mediaStream?: MediaStream | null }) => Promise<void>;
  stopRecording: () => Promise<void>;
  sendLiveText: (text: string) => Promise<void>;
  sendLiveImage: (payload: { dataUrl: string; mimeType?: string }) => Promise<void>;
  startVisionStream: () => void;
  stopVisionStream: () => void;
  clearError: () => void;
}

interface UseLiveMultimodalOptions {
  onVoiceTurn?: (text: string) => Promise<{ assistantText?: string } | void>;
  conversationId?: string | null;
  sessionId?: string | null;
  automationEngine?: "agent_browser" | "computer_use";
  browserTarget?: "auto" | "my_browser" | "managed_browser";
}

function makeId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function resolveWebSocketUrl() {
  const apiUrl = toApiUrl("/ws");
  const resolved = new URL(apiUrl, window.location.origin);
  resolved.protocol = resolved.protocol === "https:" ? "wss:" : "ws:";
  return resolved.toString();
}

function loadWebDeviceId() {
  const key = "oi:web:live-device-id:v1";
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const next = `web:${globalThis.crypto?.randomUUID?.() || Date.now()}`;
  window.localStorage.setItem(key, next);
  return next;
}

function floatTo16BitPcm(input: Float32Array) {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index] || 0));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return window.btoa(binary);
}

function base64ToBytes(base64: string) {
  const binary = window.atob(base64);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}

function concatBytes(chunks: Uint8Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  chunks.forEach((chunk) => {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return output;
}

function pcm16ToWav(pcmBytes: Uint8Array, sampleRate: number) {
  const wav = new Uint8Array(44 + pcmBytes.byteLength);
  const view = new DataView(wav.buffer);
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcmBytes.byteLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, pcmBytes.byteLength, true);
  wav.set(pcmBytes, 44);
  return wav;
}

const PREFERRED_BROWSER_VOICE_TOKENS = [
  "female",
  "woman",
  "aoede",
  "samantha",
  "victoria",
  "allison",
  "ava",
  "serena",
  "karen",
  "moira",
  "zira",
  "aria",
  "jenny",
  "sonia",
];

function scoreBrowserVoice(voice: SpeechSynthesisVoice) {
  const haystack = `${voice.name} ${voice.voiceURI}`.toLowerCase();
  let score = 0;
  if (voice.lang.toLowerCase().startsWith("en")) score += 4;
  if (voice.lang.toLowerCase().startsWith("en-us")) score += 2;
  if (voice.default) score += 1;
  PREFERRED_BROWSER_VOICE_TOKENS.forEach((token, index) => {
    if (haystack.includes(token)) {
      score += 20 - Math.min(index, 10);
    }
  });
  return score;
}

async function loadBrowserVoices() {
  if (!("speechSynthesis" in window)) return [] as SpeechSynthesisVoice[];
  const available = window.speechSynthesis.getVoices();
  if (available.length > 0) return available;
  return await new Promise<SpeechSynthesisVoice[]>((resolve) => {
    const timeoutId = window.setTimeout(() => {
      window.speechSynthesis.onvoiceschanged = null;
      resolve(window.speechSynthesis.getVoices());
    }, 400);
    window.speechSynthesis.onvoiceschanged = () => {
      window.clearTimeout(timeoutId);
      window.speechSynthesis.onvoiceschanged = null;
      resolve(window.speechSynthesis.getVoices());
    };
  });
}

async function pickPreferredBrowserVoice() {
  const voices = await loadBrowserVoices();
  if (voices.length === 0) return null;
  return [...voices].sort((left, right) => scoreBrowserVoice(right) - scoreBrowserVoice(left))[0] ?? null;
}

async function getUserMediaWithTimeout(
  constraints: MediaStreamConstraints,
  timeoutMs = MEDIA_REQUEST_TIMEOUT_MS,
) {
  return await Promise.race([
    navigator.mediaDevices.getUserMedia(constraints),
    new Promise<MediaStream>((_, reject) => {
      window.setTimeout(() => {
        reject(new Error("Timed out waiting for media device access."));
      }, timeoutMs);
    }),
  ]);
}

export function useLiveMultimodal(options?: UseLiveMultimodalOptions): LiveMultimodalState {
  const [connectionState, setConnectionState] = useState<LiveConnectionState>("idle");
  const [permissionState, setPermissionState] = useState<LivePermissionState>("unknown");
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isAssistantResponding, setIsAssistantResponding] = useState(false);
  const [isVisionStreaming, setIsVisionStreaming] = useState(false);
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<LiveTranscriptLine[]>([]);
  const [error, setError] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const authPromiseRef = useRef<Promise<void> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const captureSinkRef = useRef<GainNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const playbackCursorRef = useRef(0);
  const playbackGenerationRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const sessionStartPromiseRef = useRef<Promise<string> | null>(null);
  const sessionStartResolveRef = useRef<((sessionId: string) => void) | null>(null);
  const sessionStartRejectRef = useRef<((error: Error) => void) | null>(null);
  const imageAckPromiseRef = useRef<Promise<void> | null>(null);
  const imageAckResolveRef = useRef<(() => void) | null>(null);
  const imageAckRejectRef = useRef<((error: Error) => void) | null>(null);
  const isRecordingRef = useRef(false);
  const speechDetectedRef = useRef(false);
  const lastSpeechAtRef = useRef(0);
  const recordingStartedAtRef = useRef(0);
  const stoppingRecordingRef = useRef(false);
  const ownsRecordingStreamRef = useRef(true);
  const responseDrainTimerRef = useRef<number | null>(null);
  const inputTranscriptRef = useRef("");
  const recordedPcmChunksRef = useRef<Uint8Array[]>([]);
  const pendingVoiceTurnRef = useRef(false);
  const skipNextVoiceTurnRef = useRef(false);
  const useBackendLiveReplyRef = useRef(false);

  const appendTranscript = (
    role: LiveTranscriptLine["role"],
    text: string,
    options?: { merge?: boolean },
  ) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const timestamp = new Date().toISOString();
    setTranscript((current) => {
      const previous = current[current.length - 1];
      if (isNearDuplicateTranscriptLine(previous, role, trimmed, timestamp)) {
        return current;
      }
      return [
        ...(options?.merge && shouldJoinTranscriptLines(previous, role, timestamp)
          ? [
              ...current.slice(0, -1).slice(-10),
              {
                ...previous,
                text: joinTranscriptText(previous?.text || "", trimmed),
                timestamp,
              },
            ]
          : [
              ...current.slice(-11),
              {
                id: makeId(role),
                role,
                text: trimmed,
                timestamp,
              },
            ]),
      ];
    });
  };

  const sendFrame = (payload: Record<string, unknown>) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      throw new Error("Live connection is not ready.");
    }
    wsRef.current.send(
      JSON.stringify({
        type: "voice_stream",
        payload,
        timestamp: new Date().toISOString(),
      }),
    );
  };

  const reportError = (value: unknown) => {
    const message = value instanceof Error ? value.message : "Live session error.";
    setError(message);
    setConnectionState("error");
    rejectPendingImageAck(message);
    if (sessionStartRejectRef.current) {
      sessionStartRejectRef.current(new Error(message));
      sessionStartRejectRef.current = null;
      sessionStartResolveRef.current = null;
      sessionStartPromiseRef.current = null;
    }
  };

  const rejectPendingImageAck = (message: string) => {
    if (!imageAckRejectRef.current) return;
    imageAckRejectRef.current(new Error(message));
    imageAckPromiseRef.current = null;
    imageAckResolveRef.current = null;
    imageAckRejectRef.current = null;
  };

  const stopPlayback = () => {
    playbackGenerationRef.current += 1;
    playbackCursorRef.current = 0;
    if (responseDrainTimerRef.current) {
      window.clearTimeout(responseDrainTimerRef.current);
      responseDrainTimerRef.current = null;
    }
    const currentContext = outputAudioContextRef.current;
    outputAudioContextRef.current = null;
    if (!currentContext) return;
    void currentContext.close().catch(() => undefined);
  };

  const markAssistantTurnComplete = () => {
    if (responseDrainTimerRef.current) {
      window.clearTimeout(responseDrainTimerRef.current);
      responseDrainTimerRef.current = null;
    }
    const context = outputAudioContextRef.current;
    const pendingMs = context ? Math.max(0, (playbackCursorRef.current - context.currentTime) * 1000) : 0;
    responseDrainTimerRef.current = window.setTimeout(() => {
      setIsAssistantResponding(false);
      responseDrainTimerRef.current = null;
    }, Math.max(220, pendingMs + 120));
  };

  const ensurePlaybackContext = async () => {
    const existing = outputAudioContextRef.current;
    if (existing && existing.state !== "closed") {
      if (existing.state === "suspended") {
        await existing.resume().catch(() => undefined);
      }
      return existing;
    }
    const next = new AudioContext({ sampleRate: 24_000 });
    outputAudioContextRef.current = next;
    playbackCursorRef.current = next.currentTime;
    await next.resume().catch(() => undefined);
    return next;
  };

  const playPcmChunk = async (pcmBytes: Uint8Array, sampleRate: number) => {
    if (pcmBytes.byteLength < 2) return;
    const context = await ensurePlaybackContext();
    const generation = playbackGenerationRef.current;
    const samples = new Int16Array(
      pcmBytes.buffer.slice(pcmBytes.byteOffset, pcmBytes.byteOffset + pcmBytes.byteLength),
    );
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) {
      channel[index] = samples[index] / 0x8000;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.03, playbackCursorRef.current);
    playbackCursorRef.current = startAt + buffer.duration;
    if (generation !== playbackGenerationRef.current) return;
    source.start(startAt);
  };

  const speakWithBrowserVoice = async (text: string) => {
    if (!("speechSynthesis" in window)) {
      throw new Error("Voice playback failed.");
    }
    window.speechSynthesis.cancel();
    const preferredVoice = await pickPreferredBrowserVoice();
    await new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      if (preferredVoice) {
        utterance.voice = preferredVoice;
        utterance.lang = preferredVoice.lang;
      }
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      window.speechSynthesis.speak(utterance);
    });
  };

  const speakAssistantText = async (text: string) => {
    try {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort("live-tts-timeout"), LIVE_TTS_TIMEOUT_MS);
      const response = await authFetch("/api/live/speak", {
        method: "POST",
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      window.clearTimeout(timeoutId);
      if (!response.ok) {
        let detail = "Voice playback failed.";
        try {
          const payload = await response.json() as { detail?: string };
          if (payload.detail) detail = payload.detail;
        } catch {
          // Ignore malformed error bodies.
        }
        throw new Error(detail);
      }
      const payload = await response.json() as { audio_base64?: string; sample_rate?: number };
      const bytes = base64ToBytes(String(payload.audio_base64 || ""));
      await playPcmChunk(bytes, Number(payload.sample_rate || 24_000));
      return;
    } catch {
      await speakWithBrowserVoice(text);
    }
  };

  const transcribeRecordedTurn = async () => {
    const pcmBytes = concatBytes(recordedPcmChunksRef.current);
    if (!pcmBytes.byteLength) return "";
    const wavBytes = pcm16ToWav(pcmBytes, 16_000);
    const response = await authFetch("/api/live/transcribe", {
      method: "POST",
      body: JSON.stringify({
        audio_base64: bytesToBase64(wavBytes),
        mime_type: "audio/wav",
      }),
    });
    if (!response.ok) {
      let detail = "Voice transcription failed.";
      try {
        const payload = await response.json() as { detail?: string };
        if (payload.detail) detail = payload.detail;
      } catch {
        // Ignore malformed error bodies.
      }
      throw new Error(detail);
    }
    const payload = await response.json() as { text?: string };
    return String(payload.text || "").trim();
  };

  const refreshPermissionState = async () => {
    if (!("mediaDevices" in navigator) || typeof navigator.mediaDevices?.getUserMedia !== "function") {
      setPermissionState("unsupported");
      return;
    }
    if (!("permissions" in navigator) || typeof navigator.permissions?.query !== "function") {
      setPermissionState("unknown");
      return;
    }
    try {
      const result = await navigator.permissions.query({ name: "microphone" as PermissionName });
      const applyState = () => {
        const nextState = result.state === "granted" || result.state === "prompt" || result.state === "denied"
          ? result.state
          : "unknown";
        setPermissionState(nextState);
      };
      applyState();
      result.onchange = applyState;
    } catch {
      setPermissionState("unknown");
    }
  };

  const awaitSessionStart = () => {
    if (liveSessionId) return Promise.resolve(liveSessionId);
    if (sessionStartPromiseRef.current) return sessionStartPromiseRef.current;
    sessionStartPromiseRef.current = new Promise<string>((resolve, reject) => {
      sessionStartResolveRef.current = resolve;
      sessionStartRejectRef.current = reject;
      window.setTimeout(() => {
        if (sessionStartPromiseRef.current) {
          reject(new Error("Live session did not become ready."));
          sessionStartPromiseRef.current = null;
          sessionStartResolveRef.current = null;
          sessionStartRejectRef.current = null;
        }
      }, 8000);
    });
    return sessionStartPromiseRef.current;
  };

  const ensureLiveSession = async () => {
    await ensureSocket();
    if (liveSessionId) return liveSessionId;
    sendFrame({
      event: "start",
      live_session_id: undefined,
      conversation_id: options?.conversationId || undefined,
      session_id: options?.sessionId || undefined,
      automation_engine: options?.automationEngine || "agent_browser",
      browser_target: options?.browserTarget || "auto",
    });
    return await awaitSessionStart();
  };

  const ensureSocket = async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    if (authPromiseRef.current) {
      await authPromiseRef.current;
      return;
    }

    authPromiseRef.current = (async () => {
      setConnectionState("connecting");
      setError("");
      const token = await getCurrentAccessToken();
      const websocket = new WebSocket(resolveWebSocketUrl());
      wsRef.current = websocket;
      intentionalCloseRef.current = false;

      await new Promise<void>((resolve, reject) => {
        websocket.onopen = () => {
          websocket.send(
            JSON.stringify({
              type: "auth",
              payload: {
                token: token || undefined,
                device_id: loadWebDeviceId(),
              },
              timestamp: new Date().toISOString(),
            }),
          );
        };
        websocket.onmessage = (event) => {
          try {
            const frame = JSON.parse(String(event.data || "{}")) as {
              type?: string;
              detail?: string;
              payload?: Record<string, unknown>;
            };
            if (frame.type === "auth_ok") {
              setConnectionState("ready");
              resolve();
              return;
            }
            if (frame.type === "error") {
              const detail = String(frame.detail || "Live connection failed.");
              setConnectionState("error");
              setError(detail);
              rejectPendingImageAck(detail);
              reject(new Error(detail));
              return;
            }
            if (frame.type !== "voice_stream") return;
            const payload = frame.payload || {};
            const voiceEvent = String(payload.event || "");
            if (voiceEvent === "session_started") {
              const nextSessionId = String(payload.live_session_id || "");
              setIsSessionActive(true);
              setLiveSessionId(nextSessionId);
              if (sessionStartResolveRef.current) {
                sessionStartResolveRef.current(nextSessionId);
                sessionStartResolveRef.current = null;
                sessionStartRejectRef.current = null;
                sessionStartPromiseRef.current = null;
              }
              appendTranscript("system", "Voice session connected.");
            } else if (voiceEvent === "session_stopped") {
              setIsSessionActive(false);
              setIsRecording(false);
              setIsAssistantResponding(false);
              setIsVisionStreaming(false);
              setLiveSessionId(null);
              stopPlayback();
              rejectPendingImageAck("Live session closed.");
              skipNextVoiceTurnRef.current = false;
              useBackendLiveReplyRef.current = false;
              appendTranscript("system", "Voice session closed.");
            } else if (voiceEvent === "turn_complete") {
              markAssistantTurnComplete();
              useBackendLiveReplyRef.current = false;
            } else if (voiceEvent === "input_transcript") {
              const text = String(payload.text || "").trim();
              if (!text) return;
              if (!options?.onVoiceTurn) {
                inputTranscriptRef.current = joinTranscriptText(inputTranscriptRef.current, text);
              }
            } else if (voiceEvent === "tool_delegate_completed") {
              skipNextVoiceTurnRef.current = true;
              useBackendLiveReplyRef.current = true;
              setIsAssistantResponding(true);
            } else if (voiceEvent === "text_output") {
              if (options?.onVoiceTurn && !useBackendLiveReplyRef.current) return;
              setIsAssistantResponding(true);
              appendTranscript("assistant", String(payload.text || ""), { merge: !Boolean(payload.is_final) });
            } else if (voiceEvent === "audio_output") {
              if (options?.onVoiceTurn && !useBackendLiveReplyRef.current) return;
              setIsAssistantResponding(true);
              const bytes = base64ToBytes(String(payload.audio_data || ""));
              void playPcmChunk(bytes, 24_000).catch((value) => reportError(value));
            } else if (voiceEvent === "tool_delegate_failed") {
              skipNextVoiceTurnRef.current = false;
              useBackendLiveReplyRef.current = false;
              reportError(String(payload.message || "Live tool delegation failed."));
            } else if (voiceEvent === "image_input_ack") {
              imageAckResolveRef.current?.();
              imageAckPromiseRef.current = null;
              imageAckResolveRef.current = null;
              imageAckRejectRef.current = null;
            } else if (voiceEvent === "error") {
              reportError(String(payload.message || "Live session error."));
            }
          } catch (messageError) {
            reject(messageError instanceof Error ? messageError : new Error("Malformed live frame."));
          }
        };
        websocket.onerror = () => {
          setConnectionState("error");
          reject(new Error("Could not connect live session."));
        };
        websocket.onclose = () => {
          setConnectionState((current) => (current === "error" ? current : "idle"));
          setIsRecording(false);
          setIsAssistantResponding(false);
          setIsSessionActive(false);
          setIsVisionStreaming(false);
          setLiveSessionId(null);
          stopPlayback();
          rejectPendingImageAck("Live connection closed.");
          if (!intentionalCloseRef.current) {
            setError((current) => current || "Live connection dropped. Reopen voice to continue.");
          }
          if (sessionStartRejectRef.current) {
            sessionStartRejectRef.current(new Error("Live connection closed."));
            sessionStartRejectRef.current = null;
            sessionStartResolveRef.current = null;
            sessionStartPromiseRef.current = null;
          }
          wsRef.current = null;
          authPromiseRef.current = null;
        };
      });
    })();

    try {
      await authPromiseRef.current;
    } finally {
      authPromiseRef.current = null;
    }
  };

  const stopCapture = async () => {
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    captureSinkRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current = null;
    captureSinkRef.current = null;
    if (ownsRecordingStreamRef.current) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    }
    streamRef.current = null;
    if (audioContextRef.current) {
      await audioContextRef.current.close().catch(() => undefined);
      audioContextRef.current = null;
    }
    setIsRecording(false);
    isRecordingRef.current = false;
    ownsRecordingStreamRef.current = true;
    speechDetectedRef.current = false;
    lastSpeechAtRef.current = 0;
    recordingStartedAtRef.current = 0;
  };

  const endRecordingTurn = async (params?: { appendMessage?: string }) => {
    if (stoppingRecordingRef.current) return;
    stoppingRecordingRef.current = true;
    const hadSpeech = speechDetectedRef.current;
    try {
      await stopCapture();
      if (wsRef.current?.readyState === WebSocket.OPEN && liveSessionId) {
        sendFrame({ event: "end_turn", live_session_id: liveSessionId || undefined });
      }
      if (params?.appendMessage) {
        appendTranscript("system", params.appendMessage);
      }
      if (skipNextVoiceTurnRef.current) {
        skipNextVoiceTurnRef.current = false;
        return;
      }
      if (options?.onVoiceTurn && hadSpeech) {
        if (pendingVoiceTurnRef.current) {
          return;
        }
        pendingVoiceTurnRef.current = true;
        setIsAssistantResponding(true);
        stopPlayback();
        const finalText = await transcribeRecordedTurn();
        if (!finalText) {
          setIsAssistantResponding(false);
          appendTranscript("system", "I couldn’t catch that. Try again.");
          return;
        }
        const result = await options.onVoiceTurn(finalText);
        const assistantText = String(result?.assistantText || "").trim();
        if (!assistantText) {
          setIsAssistantResponding(false);
          return;
        }
        appendTranscript("assistant", assistantText);
        await speakAssistantText(assistantText);
        markAssistantTurnComplete();
      }
    } catch (value) {
      reportError(value);
    } finally {
      pendingVoiceTurnRef.current = false;
      recordedPcmChunksRef.current = [];
      stoppingRecordingRef.current = false;
    }
  };

  useEffect(() => {
    void refreshPermissionState();
  }, []);

  useEffect(() => {
    return () => {
      if (responseDrainTimerRef.current) {
        window.clearTimeout(responseDrainTimerRef.current);
      }
      void stopCapture();
      stopPlayback();
      intentionalCloseRef.current = true;
      wsRef.current?.close();
    };
  }, []);

  const statusMessage = isRecording
    ? "Listening for your turn."
    : isVisionStreaming
      ? "Streaming camera frames into the live session."
    : isSessionActive
      ? "Voice session is live."
      : connectionState === "connecting"
        ? "Connecting live voice."
        : permissionState === "denied"
          ? "Microphone access is blocked in this browser."
          : error
            ? error
            : "Open voice to start a live session.";

  return {
    connectionState,
    permissionState,
    isSessionActive,
    isRecording,
    isAssistantResponding,
    isVisionStreaming,
    liveSessionId,
    transcript,
    error,
    statusMessage,
    clearError: () => setError(""),
    startSession: async () => {
      try {
        await ensureLiveSession();
        await ensurePlaybackContext();
      } catch (value) {
        reportError(value);
      }
    },
    stopSession: async () => {
      try {
        intentionalCloseRef.current = true;
        setIsSessionActive(false);
        setIsRecording(false);
        setIsAssistantResponding(false);
        setIsVisionStreaming(false);
        setLiveSessionId(null);
        skipNextVoiceTurnRef.current = false;
        useBackendLiveReplyRef.current = false;
        await stopCapture();
        stopPlayback();
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          sendFrame({ event: "stop", live_session_id: liveSessionId || undefined });
        }
        wsRef.current?.close();
      } catch (value) {
        reportError(value);
      }
    },
    startRecording: async (options?: { mediaStream?: MediaStream | null }) => {
      if (isRecording) return;
      try {
        if (permissionState === "denied") {
          throw new Error("Microphone access is denied. Allow microphone access in the browser and try again.");
        }
        await ensureLiveSession();
        stopPlayback();
        const stream = options?.mediaStream && options.mediaStream.getAudioTracks().length > 0
          ? options.mediaStream
          : await getUserMediaWithTimeout({ audio: true });
        ownsRecordingStreamRef.current = !(options?.mediaStream && options.mediaStream === stream);
        setPermissionState("granted");
        const audioContext = new AudioContext({ sampleRate: 16_000 });
        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor(2048, 1, 1);
        const silentSink = audioContext.createGain();
        silentSink.gain.value = 0;
        recordedPcmChunksRef.current = [];
        processor.onaudioprocess = (event) => {
          try {
            const input = event.inputBuffer.getChannelData(0);
            let sumSquares = 0;
            for (let index = 0; index < input.length; index += 1) {
              const sample = input[index] || 0;
              sumSquares += sample * sample;
            }
            const rms = Math.sqrt(sumSquares / Math.max(1, input.length));
            const now = window.performance.now();
            if (rms >= SPEECH_RMS_THRESHOLD) {
              speechDetectedRef.current = true;
              lastSpeechAtRef.current = now;
            } else if (
              isRecordingRef.current
              && !stoppingRecordingRef.current
              && (
                (
                  speechDetectedRef.current
                  && now - recordingStartedAtRef.current >= MIN_TURN_CAPTURE_MS
                  && now - lastSpeechAtRef.current >= SILENCE_COMMIT_MS
                )
                || (!speechDetectedRef.current && now - recordingStartedAtRef.current >= NO_SPEECH_TIMEOUT_MS)
              )
            ) {
              void endRecordingTurn({
                appendMessage: speechDetectedRef.current ? "Turn sent." : "No speech detected. Try again.",
              });
              return;
            }
            const pcm = floatTo16BitPcm(input);
            recordedPcmChunksRef.current.push(new Uint8Array(pcm.buffer.slice(0)));
            sendFrame({
              event: "audio_input",
              audio_data: bytesToBase64(new Uint8Array(pcm.buffer)),
              sample_rate: audioContext.sampleRate,
              is_final: false,
            });
          } catch (value) {
            reportError(value);
          }
        };
        source.connect(processor);
        processor.connect(silentSink);
        silentSink.connect(audioContext.destination);
        streamRef.current = stream;
        audioContextRef.current = audioContext;
        sourceRef.current = source;
        processorRef.current = processor;
        captureSinkRef.current = silentSink;
        setIsRecording(true);
        setIsAssistantResponding(false);
        isRecordingRef.current = true;
        speechDetectedRef.current = false;
        lastSpeechAtRef.current = 0;
        recordingStartedAtRef.current = window.performance.now();
        appendTranscript("system", "Listening.");
      } catch (value) {
        if (value instanceof DOMException && value.name === "NotAllowedError") {
          setPermissionState("denied");
          reportError("Microphone access is denied. Allow microphone access in the browser and try again.");
          return;
        }
        if (value instanceof DOMException && value.name === "NotFoundError") {
          reportError("No microphone was found for this device.");
          return;
        }
        reportError(value);
      }
    },
    stopRecording: async () => {
      await endRecordingTurn({ appendMessage: "Turn sent." });
    },
    sendLiveText: async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      try {
        const sessionId = await ensureLiveSession();
        sendFrame({ event: "text_input", text: trimmed, live_session_id: sessionId });
      } catch (value) {
        reportError(value);
      }
    },
    sendLiveImage: async (payload: { dataUrl: string; mimeType?: string }) => {
      const raw = payload.dataUrl.trim();
      if (!raw.startsWith("data:") || !raw.includes(",")) {
        throw new Error("Live image must be a data URL.");
      }
      const [header, encoded] = raw.split(",", 2);
      const mimeType = payload.mimeType || header.slice(5).split(";")[0] || "image/jpeg";
      try {
        const sessionId = await ensureLiveSession();
        if (!imageAckPromiseRef.current) {
          imageAckPromiseRef.current = new Promise<void>((resolve, reject) => {
            imageAckResolveRef.current = resolve;
            imageAckRejectRef.current = reject;
            window.setTimeout(() => {
              if (imageAckPromiseRef.current) {
                reject(new Error("Live image send timed out."));
                imageAckPromiseRef.current = null;
                imageAckResolveRef.current = null;
                imageAckRejectRef.current = null;
              }
            }, 5_000);
          });
        }
        sendFrame({
          event: "image_input",
          image_data: encoded,
          mime_type: mimeType,
          live_session_id: sessionId,
        });
        await imageAckPromiseRef.current;
      } catch (value) {
        reportError(value);
      }
    },
    startVisionStream: () => {
      setIsVisionStreaming(true);
      appendTranscript("system", "Camera live sharing enabled.");
    },
    stopVisionStream: () => {
      setIsVisionStreaming(false);
      appendTranscript("system", "Camera live sharing paused.");
    },
  };
}
