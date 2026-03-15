import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Buffer } from "buffer";
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import { fetchWithTimeout, getApiBaseUrl } from "@/lib/api";
import { getAccessToken, getAuthHeaders } from "@/lib/authHeaders";

type LiveConnectionState = "idle" | "connecting" | "ready" | "error";
type LivePermissionState = "unknown" | "granted" | "prompt" | "denied";

const SILENCE_COMMIT_MS = 1_200;
const NO_SPEECH_TIMEOUT_MS = 6_000;
const SPEECH_METER_THRESHOLD = -42;

export interface MobileLiveTranscriptLine {
  id: string;
  role: "assistant" | "system";
  text: string;
  timestamp: string;
}

export interface MobileLiveMultimodalState {
  connectionState: LiveConnectionState;
  permissionState: LivePermissionState;
  isSessionActive: boolean;
  isRecording: boolean;
  isAssistantResponding: boolean;
  isVisionStreaming: boolean;
  transcript: MobileLiveTranscriptLine[];
  error: string;
  startSession: () => Promise<void>;
  stopSession: () => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  sendLiveImage: (payload: { dataUrl: string; mimeType: string }) => Promise<void>;
  startVisionStream: () => Promise<void>;
  stopVisionStream: () => void;
  clearError: () => void;
}

function websocketUrl() {
  const api = new URL(getApiBaseUrl());
  api.protocol = api.protocol === "https:" ? "wss:" : "ws:";
  api.pathname = "/ws";
  api.search = "";
  return api.toString();
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function shouldJoinTranscriptLines(
  previous: MobileLiveTranscriptLine | undefined,
  role: MobileLiveTranscriptLine["role"],
  timestamp: string,
) {
  if (!previous || previous.role !== role) return false;
  const previousTime = Date.parse(previous.timestamp);
  const nextTime = Date.parse(timestamp);
  if (Number.isNaN(previousTime) || Number.isNaN(nextTime)) return false;
  return nextTime - previousTime < 8_000;
}

function isNearDuplicateTranscriptLine(
  previous: MobileLiveTranscriptLine | undefined,
  role: MobileLiveTranscriptLine["role"],
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
  const separator = /[\s([{]$/.test(left) || /^[,.;!?)]/.test(right) ? "" : " ";
  return `${left}${separator}${right}`;
}

function pcmToWavBase64(pcmBytes: Uint8Array, sampleRate: number) {
  const dataLength = pcmBytes.byteLength;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataLength, true);
  const wav = new Uint8Array(44 + dataLength);
  wav.set(new Uint8Array(header), 0);
  wav.set(pcmBytes, 44);
  return Buffer.from(wav).toString("base64");
}

export function useLiveMultimodal(options?: { onVoiceTurn?: (text: string) => Promise<{ assistantText?: string } | void>; onAssistantText?: (text: string) => void }) {
  const [connectionState, setConnectionState] = useState<LiveConnectionState>("idle");
  const [permissionState, setPermissionState] = useState<LivePermissionState>("unknown");
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isAssistantResponding, setIsAssistantResponding] = useState(false);
  const [isVisionStreaming, setIsVisionStreaming] = useState(false);
  const [transcript, setTranscript] = useState<MobileLiveTranscriptLine[]>([]);
  const [error, setError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const liveSessionIdRef = useRef<string | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const imageAckPromiseRef = useRef<Promise<void> | null>(null);
  const imageAckResolveRef = useRef<(() => void) | null>(null);
  const imageAckRejectRef = useRef<((error: Error) => void) | null>(null);
  const playbackQueueRef = useRef<string[]>([]);
  const isPlayingRef = useRef(false);
  const soundRef = useRef<Audio.Sound | null>(null);
  const speechDetectedRef = useRef(false);
  const lastSpeechAtRef = useRef(0);
  const recordingStartedAtRef = useRef(0);
  const responseDrainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assistantDraftRef = useRef("");
  const sessionPromiseRef = useRef<Promise<string> | null>(null);
  const shouldAutoResumeRef = useRef(true);
  const deviceIdRef = useRef(`mobile:${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`);
  const pendingVoiceTurnRef = useRef(false);

  const appendTranscript = useCallback((role: MobileLiveTranscriptLine["role"], text: string, merge = false) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const timestamp = new Date().toISOString();
    setTranscript((current) => {
      const previous = current[current.length - 1];
      if (isNearDuplicateTranscriptLine(previous, role, trimmed, timestamp)) {
        return current;
      }
      if (merge && shouldJoinTranscriptLines(previous, role, timestamp)) {
        return [
          ...current.slice(0, -1).slice(-10),
          {
            ...previous,
            text: joinTranscriptText(previous?.text || "", trimmed),
            timestamp,
          },
        ];
      }
      return [
        ...current.slice(-11),
        {
          id: makeId(role),
          role,
          text: trimmed,
          timestamp,
        },
      ];
    });
  }, []);

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
      throw new Error("Live connection is not ready.");
    }
    socketRef.current.send(JSON.stringify({
      type: "voice_stream",
      payload,
      timestamp: new Date().toISOString(),
    }));
  }, []);

  const stopPlayback = useCallback(async () => {
    playbackQueueRef.current = [];
    isPlayingRef.current = false;
    if (responseDrainTimerRef.current) {
      clearTimeout(responseDrainTimerRef.current);
      responseDrainTimerRef.current = null;
    }
    const sound = soundRef.current;
    soundRef.current = null;
    if (sound) {
      try {
        await sound.stopAsync();
      } catch {}
      try {
        await sound.unloadAsync();
      } catch {}
    }
  }, []);

  const playNext = useCallback(async () => {
    if (isPlayingRef.current) return;
    const nextUri = playbackQueueRef.current.shift();
    if (!nextUri) return;
    isPlayingRef.current = true;
    try {
      const { sound } = await Audio.Sound.createAsync(
        { uri: nextUri },
        { shouldPlay: true, progressUpdateIntervalMillis: 250 },
      );
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((status) => {
        if (!status.isLoaded) return;
        if (status.didJustFinish) {
          void sound.unloadAsync().catch(() => undefined);
          soundRef.current = null;
          isPlayingRef.current = false;
          void FileSystem.deleteAsync(nextUri, { idempotent: true }).catch(() => undefined);
          if (playbackQueueRef.current.length > 0) {
            void playNext();
            return;
          }
          if (responseDrainTimerRef.current) {
            clearTimeout(responseDrainTimerRef.current);
          }
          responseDrainTimerRef.current = setTimeout(() => {
            setIsAssistantResponding(false);
            responseDrainTimerRef.current = null;
          }, 420);
        }
      });
    } catch (playbackError) {
      isPlayingRef.current = false;
      setError(playbackError instanceof Error ? playbackError.message : "Audio playback failed.");
    }
  }, []);

  const enqueueAudio = useCallback(async (audioBase64: string, sampleRate = 24_000) => {
    const wavBase64 = pcmToWavBase64(Buffer.from(audioBase64, "base64"), sampleRate);
    const fileUri = `${FileSystem.cacheDirectory}oi-live-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`;
    await FileSystem.writeAsStringAsync(fileUri, wavBase64, { encoding: FileSystem.EncodingType.Base64 });
    playbackQueueRef.current.push(fileUri);
    await playNext();
  }, [playNext]);

  const handleSocketFrame = useCallback((event: MessageEvent<string>) => {
    const frame = JSON.parse(String(event.data || "{}")) as {
      type?: string;
      detail?: string;
      payload?: Record<string, unknown>;
    };
    if (frame.type === "error") {
      throw new Error(String(frame.detail || "Live connection failed."));
    }
    if (frame.type !== "voice_stream") return;
    const payload = frame.payload || {};
    const eventType = String(payload.event || "");
    if (eventType === "session_started") {
      const nextSessionId = String(payload.live_session_id || "");
      liveSessionIdRef.current = nextSessionId;
      setIsSessionActive(true);
      setConnectionState("ready");
      appendTranscript("system", "Live session ready.");
      return;
    }
    if (eventType === "session_stopped") {
      liveSessionIdRef.current = null;
      setIsSessionActive(false);
      setIsRecording(false);
      setIsAssistantResponding(false);
      setIsVisionStreaming(false);
      assistantDraftRef.current = "";
      clearPendingImageAck("Live session closed.");
      return;
    }
    if (eventType === "text_output") {
      if (options?.onVoiceTurn) return;
      setIsAssistantResponding(true);
      const text = String(payload.text || "");
      assistantDraftRef.current = joinTranscriptText(assistantDraftRef.current, text);
      appendTranscript("assistant", text, !Boolean(payload.is_final));
      return;
    }
    if (eventType === "audio_output") {
      if (options?.onVoiceTurn) return;
      setIsAssistantResponding(true);
      void enqueueAudio(String(payload.audio_data || ""), 24_000).catch((value) => {
        setError(value instanceof Error ? value.message : "Audio playback failed.");
      });
      return;
    }
    if (eventType === "turn_complete") {
      if (assistantDraftRef.current.trim()) {
        options?.onAssistantText?.(assistantDraftRef.current.trim());
        assistantDraftRef.current = "";
      }
      if (!isPlayingRef.current && playbackQueueRef.current.length === 0) {
        if (responseDrainTimerRef.current) clearTimeout(responseDrainTimerRef.current);
        responseDrainTimerRef.current = setTimeout(() => {
          setIsAssistantResponding(false);
          responseDrainTimerRef.current = null;
        }, 420);
      }
      return;
    }
    if (eventType === "image_input_ack") {
      imageAckResolveRef.current?.();
      clearPendingImageAck();
      return;
    }
    if (eventType === "error") {
      setError(String(payload.message || "Live session failed."));
      setConnectionState("error");
    }
  }, [appendTranscript, clearPendingImageAck, enqueueAudio, options]);

  const ensureSession = useCallback(async () => {
    if (liveSessionIdRef.current && socketRef.current?.readyState === WebSocket.OPEN) {
      return liveSessionIdRef.current;
    }
    if (sessionPromiseRef.current) return sessionPromiseRef.current;

    sessionPromiseRef.current = (async () => {
      const token = await getAccessToken();
      const socket = new WebSocket(websocketUrl());
      socketRef.current = socket;
      setConnectionState("connecting");
      setError("");
      const nextSessionId = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Live session did not start.")), 10_000);
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
          try {
            const frame = JSON.parse(String(event.data || "{}")) as { type?: string; detail?: string; payload?: Record<string, unknown> };
            if (frame.type === "auth_ok") {
              sendFrame({ event: "start" });
              return;
            }
            if (frame.type === "error") {
              clearTimeout(timeout);
              reject(new Error(String(frame.detail || "Live connection failed.")));
              return;
            }
            const payload = frame.payload || {};
            if (frame.type === "voice_stream" && String(payload.event || "") === "session_started") {
              clearTimeout(timeout);
              handleSocketFrame(event);
              resolve(String(payload.live_session_id || ""));
              return;
            }
            handleSocketFrame(event);
          } catch (socketError) {
            clearTimeout(timeout);
            reject(socketError instanceof Error ? socketError : new Error("Malformed live frame."));
          }
        };
        socket.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("Could not connect live session."));
        };
        socket.onclose = () => {
          setConnectionState((current) => (current === "error" ? current : "idle"));
          setIsSessionActive(false);
          setIsRecording(false);
          setIsAssistantResponding(false);
          setIsVisionStreaming(false);
          liveSessionIdRef.current = null;
          socketRef.current = null;
          sessionPromiseRef.current = null;
          clearPendingImageAck("Live connection closed.");
        };
      });
      return nextSessionId;
    })();

    try {
      return await sessionPromiseRef.current;
    } finally {
      sessionPromiseRef.current = null;
    }
  }, [clearPendingImageAck, handleSocketFrame, sendFrame]);

  const transcribeRecording = useCallback(async (uri: string, mimeType: string) => {
    const audioBase64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    const headers = await getAuthHeaders();
    const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/live/transcribe`, {
      method: "POST",
      headers,
      body: JSON.stringify({ audio_base64: audioBase64, mime_type: mimeType }),
    }, 20_000);
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || "Transcription failed.");
    }
    const payload = await response.json() as { text?: string };
    return String(payload.text || "").trim();
  }, []);

  const synthesizeAssistantAudio = useCallback(async (text: string) => {
    const headers = await getAuthHeaders();
    const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/live/speak`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text }),
    }, 20_000);
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || "Speech synthesis failed.");
    }
    const payload = await response.json() as { audio_base64?: string; sample_rate?: number };
    return {
      audioBase64: String(payload.audio_base64 || ""),
      sampleRate: Number(payload.sample_rate || 24_000),
    };
  }, []);

  const endRecordingTurn = useCallback(async (reason?: "no_speech") => {
    const recording = recordingRef.current;
    if (!recording) return;
    recordingRef.current = null;
    setIsRecording(false);
    try {
      await recording.stopAndUnloadAsync();
      const status = await recording.getStatusAsync();
      const uri = status.uri;
      if (!uri) return;
      if (reason === "no_speech") {
        appendTranscript("system", "No speech detected. Try again.");
        return;
      }
      appendTranscript("system", "Turn sent.");
      const transcriptText = await transcribeRecording(uri, "audio/mp4");
      if (!transcriptText) {
        appendTranscript("system", "No speech detected. Try again.");
        return;
      }
      if (options?.onVoiceTurn) {
        if (pendingVoiceTurnRef.current) {
          return;
        }
        pendingVoiceTurnRef.current = true;
        setIsAssistantResponding(true);
        const result = await options.onVoiceTurn(transcriptText);
        const assistantText = String(result?.assistantText || "").trim();
        if (assistantText) {
          appendTranscript("assistant", assistantText);
          options.onAssistantText?.(assistantText);
          try {
            const audio = await synthesizeAssistantAudio(assistantText);
            if (audio.audioBase64) {
              await enqueueAudio(audio.audioBase64, audio.sampleRate);
            } else {
              setIsAssistantResponding(false);
            }
          } catch (audioError) {
            setError(audioError instanceof Error ? audioError.message : "Speech synthesis failed.");
            setIsAssistantResponding(false);
          }
        } else {
          setIsAssistantResponding(false);
        }
        return;
      }
      await ensureSession();
      sendFrame({
        event: "text_input",
        text: transcriptText,
        live_session_id: liveSessionIdRef.current || undefined,
      });
    } finally {
      pendingVoiceTurnRef.current = false;
      await FileSystem.deleteAsync(recording.getURI() || "", { idempotent: true }).catch(() => undefined);
    }
  }, [appendTranscript, enqueueAudio, ensureSession, options, sendFrame, synthesizeAssistantAudio, transcribeRecording]);

  const startRecording = useCallback(async () => {
    if (recordingRef.current || isRecording || isAssistantResponding) return;
    const permission = await Audio.requestPermissionsAsync();
    if (!permission.granted) {
      setPermissionState("denied");
      setError("Microphone access is required for live voice.");
      return;
    }
    setPermissionState("granted");
    await ensureSession();
    await stopPlayback();
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
      staysActiveInBackground: false,
    });
    const recording = new Audio.Recording();
    recording.setProgressUpdateInterval(250);
    recording.setOnRecordingStatusUpdate((status) => {
      if (!status.canRecord || !status.isRecording) return;
      const now = Date.now();
      const meter = typeof status.metering === "number" ? status.metering : -160;
      if (meter >= SPEECH_METER_THRESHOLD) {
        speechDetectedRef.current = true;
        lastSpeechAtRef.current = now;
      }
      const silentFor = now - lastSpeechAtRef.current;
      if (speechDetectedRef.current && silentFor >= SILENCE_COMMIT_MS) {
        void endRecordingTurn();
        return;
      }
      if (!speechDetectedRef.current && now - recordingStartedAtRef.current >= NO_SPEECH_TIMEOUT_MS) {
        void endRecordingTurn("no_speech");
      }
    });
    await recording.prepareToRecordAsync({
      ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
      isMeteringEnabled: true,
      keepAudioActiveHint: true,
    });
    await recording.startAsync();
    recordingRef.current = recording;
    recordingStartedAtRef.current = Date.now();
    lastSpeechAtRef.current = 0;
    speechDetectedRef.current = false;
    setIsRecording(true);
    appendTranscript("system", "Listening.");
  }, [appendTranscript, endRecordingTurn, ensureSession, isAssistantResponding, isRecording, stopPlayback]);

  const api = useMemo<MobileLiveMultimodalState>(() => ({
    connectionState,
    permissionState,
    isSessionActive,
    isRecording,
    isAssistantResponding,
    isVisionStreaming,
    transcript,
    error,
    startSession: async () => {
      shouldAutoResumeRef.current = true;
      await ensureSession();
      if (!isRecording && !isAssistantResponding) {
        await startRecording();
      }
    },
    stopSession: async () => {
      shouldAutoResumeRef.current = false;
      if (recordingRef.current) {
        const recording = recordingRef.current;
        recordingRef.current = null;
        setIsRecording(false);
        await recording.stopAndUnloadAsync().catch(() => undefined);
      }
      setIsVisionStreaming(false);
      await stopPlayback();
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({
          type: "voice_stream",
          payload: { event: "stop", live_session_id: liveSessionIdRef.current || undefined },
          timestamp: new Date().toISOString(),
        }));
      }
      socketRef.current?.close();
      socketRef.current = null;
      liveSessionIdRef.current = null;
      setIsSessionActive(false);
    },
    startRecording,
    stopRecording: async () => {
      shouldAutoResumeRef.current = false;
      await endRecordingTurn();
    },
    sendLiveImage: async ({ dataUrl, mimeType }) => {
      const currentSessionId = await ensureSession();
      const [, encoded = ""] = dataUrl.split(",", 2);
      if (!imageAckPromiseRef.current) {
        imageAckPromiseRef.current = new Promise<void>((resolve, reject) => {
          imageAckResolveRef.current = resolve;
          imageAckRejectRef.current = reject;
          setTimeout(() => {
            if (imageAckPromiseRef.current) {
              clearPendingImageAck("Live image send timed out.");
            }
          }, 5_000);
        });
      }
      sendFrame({
        event: "image_input",
        image_data: encoded,
        mime_type: mimeType,
        live_session_id: currentSessionId,
      });
      await imageAckPromiseRef.current;
    },
    startVisionStream: async () => {
      await ensureSession();
      setIsVisionStreaming(true);
    },
    stopVisionStream: () => {
      setIsVisionStreaming(false);
    },
    clearError: () => setError(""),
  }), [
    clearPendingImageAck,
    connectionState,
    endRecordingTurn,
    ensureSession,
    error,
    isAssistantResponding,
    isRecording,
    isSessionActive,
    isVisionStreaming,
    permissionState,
    startRecording,
    stopPlayback,
    transcript,
    sendFrame,
  ]);

  useEffect(() => {
    if (!isSessionActive || isRecording || isAssistantResponding || !shouldAutoResumeRef.current) return;
    const timer = setTimeout(() => {
      void startRecording();
    }, 1800);
    return () => clearTimeout(timer);
  }, [isAssistantResponding, isRecording, isSessionActive, startRecording]);

  useEffect(() => {
    return () => {
      shouldAutoResumeRef.current = false;
      if (recordingRef.current) {
        void recordingRef.current.stopAndUnloadAsync().catch(() => undefined);
      }
      void stopPlayback();
      socketRef.current?.close();
    };
  }, [stopPlayback]);

  return api;
}
