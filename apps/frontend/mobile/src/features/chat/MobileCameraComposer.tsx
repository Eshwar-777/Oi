import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { PrimaryButton, SecondaryButton, SurfaceCard, mobileTheme } from "@oi/design-system-mobile";

const STREAM_BASE_DELAY_MS = 1100;
const STREAM_MAX_DELAY_MS = 2200;

export function MobileCameraComposer({
  embedded = false,
  open,
  onClose,
  onCapture,
  onStartStreaming,
  onStopStreaming,
  onStreamFrame,
  isStreaming,
  streamingState,
}: {
  embedded?: boolean;
  open: boolean;
  onClose: () => void;
  onCapture: (payload: { dataUrl: string; label: string }) => void;
  onStartStreaming: () => Promise<void>;
  onStopStreaming: () => void;
  onStreamFrame: (payload: { dataUrl: string; mimeType: string }) => Promise<void>;
  isStreaming: boolean;
  streamingState: "idle" | "connecting" | "ready" | "error";
}) {
  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [errorMessage, setErrorMessage] = useState("");
  const [capturing, setCapturing] = useState(false);
  const streamingBusyRef = useRef(false);
  const streamTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!open) return null;

  async function ensurePermission() {
    if (permission?.granted) return true;
    const next = await requestPermission();
    if (next.granted) return true;
    setErrorMessage("Camera permission is required to show the agent what you see.");
    return false;
  }

  async function handleCapture() {
    if (!(await ensurePermission())) return;
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    setErrorMessage("");
    try {
      const frame = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.7,
      });
      const mimeType = frame.uri?.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      if (!frame.base64) {
        throw new Error("Camera capture did not return image data.");
      }
      onCapture({
        dataUrl: `data:${mimeType};base64,${frame.base64}`,
        label: `Camera capture ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      });
      onClose();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to capture image.");
    } finally {
      setCapturing(false);
    }
  }

  useEffect(() => {
    if (!open || !isStreaming || !permission?.granted) return;
    let cancelled = false;
    const streamNextFrame = async () => {
      if (cancelled || !cameraRef.current || streamingBusyRef.current) return;
      streamingBusyRef.current = true;
      const startedAt = Date.now();
      try {
        const frame = await cameraRef.current.takePictureAsync({
          base64: true,
          quality: 0.35,
          skipProcessing: true,
        });
        const mimeType = frame.uri?.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
        if (frame.base64 && !cancelled) {
          await onStreamFrame({
            dataUrl: `data:${mimeType};base64,${frame.base64}`,
            mimeType,
          });
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Live camera streaming failed.");
      } finally {
        streamingBusyRef.current = false;
        if (!cancelled) {
          const elapsed = Date.now() - startedAt;
          const nextDelay = Math.min(STREAM_MAX_DELAY_MS, Math.max(STREAM_BASE_DELAY_MS, STREAM_BASE_DELAY_MS + Math.max(0, elapsed - 350)));
          streamTimerRef.current = setTimeout(() => {
            void streamNextFrame();
          }, nextDelay);
        }
      }
    };
    void streamNextFrame();
    return () => {
      cancelled = true;
      if (streamTimerRef.current) {
        clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
      }
    };
  }, [isStreaming, onStreamFrame, open, permission?.granted]);

  return (
    <SurfaceCard style={[styles.container, embedded ? styles.embeddedContainer : null]}>
      {embedded ? (
        <View style={styles.embeddedTopBar}>
          <Text style={styles.embeddedBadge}>{isStreaming ? "Live camera" : "Camera ready"}</Text>
        </View>
      ) : null}
      {embedded ? null : (
        <>
      <Text style={styles.eyebrow}>Camera</Text>
      <Text style={styles.title}>Show the assistant your current view</Text>
      <Text style={styles.status}>
        {isStreaming ? "Streaming frames into the live session." : streamingState === "connecting" ? "Connecting live camera." : "Capture once or start live camera."}
      </Text>
        </>
      )}
      {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
      {permission?.granted ? (
        <CameraView ref={cameraRef} style={[styles.camera, embedded ? styles.embeddedCamera : null]} facing="back" />
      ) : (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderTitle}>Camera preview</Text>
          <Text style={styles.placeholderText}>Grant camera access to capture a live frame inside the conversation.</Text>
        </View>
      )}
      {embedded ? (
        <View style={styles.embeddedActions}>
          <Pressable style={styles.embeddedIconButton} onPress={() => void handleCapture()}>
            <Text style={styles.embeddedIconText}>+</Text>
          </Pressable>
          <Pressable style={styles.embeddedIconButton} onPress={onClose}>
            <Text style={styles.embeddedIconText}>×</Text>
          </Pressable>
        </View>
      ) : null}
      {embedded ? null : (
        <>
      <View style={styles.actions}>
        <View style={styles.actionButton}>
          <PrimaryButton onPress={() => void handleCapture()} loading={capturing}>
            Capture frame
          </PrimaryButton>
        </View>
        <View style={styles.actionButton}>
          <SecondaryButton onPress={() => void (isStreaming ? onStopStreaming() : onStartStreaming())}>
            {isStreaming ? "Stop live camera" : streamingState === "connecting" ? "Connecting..." : "Start live camera"}
          </SecondaryButton>
        </View>
      </View>
      <View style={styles.actions}>
        <View style={styles.actionButton}>
          <SecondaryButton onPress={onClose}>Close camera</SecondaryButton>
        </View>
      </View>
        </>
      )}
    </SurfaceCard>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: mobileTheme.spacing[3],
  },
  embeddedContainer: {
    padding: 0,
    overflow: "hidden",
    minHeight: 360,
    backgroundColor: "#0C1320",
  },
  embeddedTopBar: {
    position: "absolute",
    top: mobileTheme.spacing[3],
    left: mobileTheme.spacing[3],
    zIndex: 2,
  },
  embeddedBadge: {
    color: "#F7FAFF",
    fontSize: mobileTheme.typography.fontSize.xs,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  eyebrow: {
    fontSize: mobileTheme.typography.fontSize.xs,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    color: mobileTheme.colors.textSoft,
  },
  title: {
    fontSize: mobileTheme.typography.fontSize.lg,
    fontWeight: "700",
    color: mobileTheme.colors.text,
  },
  status: {
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.textSoft,
  },
  error: {
    color: mobileTheme.colors.error,
    fontSize: mobileTheme.typography.fontSize.sm,
  },
  camera: {
    width: "100%",
    aspectRatio: 3 / 4,
    borderRadius: mobileTheme.radii.lg,
    overflow: "hidden",
  },
  embeddedCamera: {
    aspectRatio: undefined,
    height: "100%",
    borderRadius: 0,
  },
  placeholder: {
    minHeight: 240,
    borderRadius: mobileTheme.radii.lg,
    backgroundColor: mobileTheme.colors.surfaceMuted,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: mobileTheme.spacing[4],
    gap: mobileTheme.spacing[2],
  },
  placeholderTitle: {
    fontSize: mobileTheme.typography.fontSize.base,
    fontWeight: "700",
    color: mobileTheme.colors.text,
  },
  placeholderText: {
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.textSoft,
    textAlign: "center",
  },
  actions: {
    flexDirection: "row",
    gap: mobileTheme.spacing[2],
  },
  embeddedActions: {
    position: "absolute",
    right: mobileTheme.spacing[3],
    bottom: mobileTheme.spacing[3],
    flexDirection: "row",
    gap: mobileTheme.spacing[2],
  },
  embeddedIconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(10, 16, 28, 0.38)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  embeddedIconText: {
    color: "#F7FAFF",
    fontSize: 24,
    lineHeight: 28,
    fontWeight: "400",
  },
  actionButton: {
    flex: 1,
  },
});
