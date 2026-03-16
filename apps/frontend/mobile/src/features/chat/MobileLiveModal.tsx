import { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useMobileTheme } from "@oi/design-system-mobile";
import { MobileCameraComposer } from "@/features/chat/MobileCameraComposer";
import type { MobileLiveMultimodalState } from "@/features/chat/useLiveMultimodal";

function orbIntensity(live: MobileLiveMultimodalState) {
  if (live.isRecording) return 1;
  if (live.isAssistantResponding) return 0.84;
  if (live.isSessionActive) return 0.64;
  return 0.36;
}

function orbCaption(live: MobileLiveMultimodalState) {
  if (live.connectionState === "connecting") return "Opening live mode.";
  if (live.isAssistantResponding) return "Replying.";
  if (live.isSessionActive) return "Listening.";
  return "Ready when you are.";
}

export function MobileLiveModal({
  open,
  live,
  onClose,
  onAddImage,
  onCapture,
}: {
  open: boolean;
  live: MobileLiveMultimodalState;
  onClose: () => void;
  onAddImage: () => void;
  onCapture: (payload: { dataUrl: string; label: string }) => void;
}) {
  const theme = useMobileTheme();
  const [cameraOpen, setCameraOpen] = useState(false);
  const startedRef = useRef(false);
  const intensity = useMemo(() => orbIntensity(live), [live]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        backdrop: {
          flex: 1,
          backgroundColor: "rgba(9, 12, 18, 0.12)",
          justifyContent: "flex-end",
          alignItems: "flex-end",
          paddingHorizontal: theme.spacing[4],
          paddingBottom: 96,
        },
        modal: {
          width: 320,
          height: 360,
          borderRadius: 28,
          backgroundColor: theme.colors.surface,
          overflow: "hidden",
          paddingHorizontal: theme.spacing[3],
          paddingTop: theme.spacing[3],
          paddingBottom: theme.spacing[3],
        },
        header: {
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: theme.spacing[2],
        },
        headerEyebrow: {
          fontSize: theme.typography.fontSize.xs,
          textTransform: "uppercase",
          letterSpacing: 1.2,
          color: theme.colors.textSoft,
          fontWeight: "700",
        },
        closeButton: {
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: "center",
          justifyContent: "center",
        },
        closeText: {
          fontSize: 28,
          lineHeight: 28,
          color: theme.colors.text,
          fontWeight: "300",
        },
        stage: {
          flex: 1,
          minHeight: 0,
          borderRadius: 22,
          overflow: "hidden",
          position: "relative",
          backgroundColor: theme.colors.surfaceMuted,
        },
        stageGlow: {
          position: "absolute",
          inset: 0,
          backgroundColor: "rgba(96,165,250,0.05)",
        },
        stageGlowCamera: {
          backgroundColor: "rgba(96,165,250,0.08)",
        },
        cameraStage: {
          ...StyleSheet.absoluteFillObject,
        },
        orbShell: {
          position: "absolute",
          left: "50%",
          top: "50%",
          width: 188,
          height: 188,
          marginLeft: -94,
          marginTop: -94,
          borderRadius: 999,
          alignItems: "center",
          justifyContent: "center",
          shadowColor: "#60A5FA",
        },
        orbShellDocked: {
          left: theme.spacing[3],
          bottom: theme.spacing[3],
          top: undefined,
          marginLeft: 0,
          marginTop: 0,
          width: 92,
          height: 92,
        },
        orbRingSoft: {
          position: "absolute",
          inset: 10,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: "rgba(191,219,254,0.8)",
        },
        orbRingHard: {
          position: "absolute",
          inset: 20,
          borderRadius: 999,
          borderWidth: 2,
          borderColor: "rgba(147,197,253,0.6)",
        },
        orbCore: {
          position: "absolute",
          inset: 32,
          borderRadius: 999,
          backgroundColor: "#D8E8FF",
          alignItems: "center",
          justifyContent: "center",
        },
        orbTitle: {
          fontSize: theme.typography.fontSize.sm,
          fontWeight: "700",
          color: theme.colors.text,
        },
        orbCaption: {
          marginTop: theme.spacing[1],
          fontSize: theme.typography.fontSize.xs,
          color: theme.colors.textMuted,
        },
        errorBanner: {
          position: "absolute",
          left: theme.spacing[3],
          right: theme.spacing[3],
          bottom: theme.spacing[3],
          borderRadius: theme.radii.md,
          backgroundColor: "rgba(181, 74, 47, 0.12)",
          paddingHorizontal: theme.spacing[3],
          paddingVertical: theme.spacing[2],
        },
        errorText: {
          color: "#B54A2F",
          fontSize: theme.typography.fontSize.xs,
          lineHeight: 18,
        },
        footer: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
          paddingHorizontal: theme.spacing[3],
          paddingBottom: theme.spacing[4],
          gap: theme.spacing[2],
        },
        imageIconButton: {
          width: 48,
          height: 48,
          borderRadius: 24,
          borderWidth: 1,
          borderColor: theme.colors.border,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.surfaceMuted,
        },
        imageIconText: {
          fontSize: 22,
          color: theme.colors.text,
          fontWeight: "300",
        },
        liveButton: {
          width: 48,
          height: 48,
          borderRadius: 24,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surfaceMuted,
          alignItems: "center",
          justifyContent: "center",
        },
        liveButtonActive: {
          borderColor: theme.colors.primary,
          backgroundColor: theme.colors.primarySoft,
        },
        liveButtonText: {
          fontSize: 18,
          color: theme.colors.primary,
          fontWeight: "700",
        },
      }),
    [theme],
  );

  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      setCameraOpen(false);
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    void live.startSession().catch(() => undefined);
  }, [live, open]);

  const handleClose = () => {
    void live.stopSession();
    setCameraOpen(false);
    onClose();
  };

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={styles.backdrop}>
        <View style={styles.modal}>
          <View style={styles.header}>
            <Text style={styles.headerEyebrow}>Live</Text>
            <Pressable style={styles.closeButton} onPress={handleClose}>
              <Text style={styles.closeText}>×</Text>
            </Pressable>
          </View>

          <View style={styles.stage}>
            <View style={[styles.stageGlow, cameraOpen ? styles.stageGlowCamera : null]} />
            {cameraOpen ? (
              <View style={styles.cameraStage}>
                <MobileCameraComposer
                  embedded
                  open={cameraOpen}
                  onClose={() => {
                    live.stopVisionStream();
                    setCameraOpen(false);
                  }}
                  onCapture={onCapture}
                  onStartStreaming={live.startVisionStream}
                  onStopStreaming={live.stopVisionStream}
                  onStreamFrame={live.sendLiveImage}
                  isStreaming={live.isVisionStreaming}
                  streamingState={live.connectionState}
                />
              </View>
            ) : null}

            <View
              style={[
                styles.orbShell,
                cameraOpen ? styles.orbShellDocked : null,
                {
                  shadowOpacity: 0.16 + intensity * 0.12,
                  shadowRadius: 24 + intensity * 14,
                  transform: [{ scale: 0.94 + intensity * 0.08 }],
                },
              ]}
            >
              <View style={[styles.orbRingSoft, { opacity: 0.22 + intensity * 0.24 }]} />
              <View style={[styles.orbRingHard, { opacity: 0.3 + intensity * 0.22 }]} />
              <View style={[styles.orbCore, { opacity: 0.82 + intensity * 0.14 }]}>
                <Text style={styles.orbTitle}>Live</Text>
                {!cameraOpen ? <Text style={styles.orbCaption}>{orbCaption(live)}</Text> : null}
              </View>
            </View>
          </View>

          {live.error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText}>{live.error}</Text>
            </View>
          ) : null}

          <View style={styles.footer}>
            <Pressable style={styles.imageIconButton} onPress={onAddImage}>
              <Text style={styles.imageIconText}>+</Text>
            </Pressable>
            <Pressable
              style={[styles.liveButton, cameraOpen ? styles.liveButtonActive : null]}
              onPress={() => {
                if (cameraOpen) {
                  live.stopVisionStream();
                  setCameraOpen(false);
                  return;
                }
                setCameraOpen(true);
                void live.startVisionStream().catch(() => undefined);
              }}
            >
              <Text style={styles.liveButtonText}>◉</Text>
            </Pressable>
          </View>

        </View>
      </View>
    </Modal>
  );
}
