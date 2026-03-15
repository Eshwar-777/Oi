import { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { mobileTheme } from "@oi/design-system-mobile";
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
  const [cameraOpen, setCameraOpen] = useState(false);
  const startedRef = useRef(false);
  const intensity = useMemo(() => orbIntensity(live), [live]);

  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      setCameraOpen(false);
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    void live.startSession();
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

          <View style={styles.footer}>
            <View style={styles.footerLeft}>
              <Pressable style={styles.imageIconButton} onPress={onAddImage}>
                <Text style={styles.imageIconText}>+</Text>
              </Pressable>
            </View>
            <Pressable
              style={[styles.liveButton, cameraOpen ? styles.liveButtonActive : null]}
              onPress={() => {
                if (cameraOpen) {
                  live.stopVisionStream();
                  setCameraOpen(false);
                  return;
                }
                setCameraOpen(true);
                void live.startVisionStream();
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

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(9, 12, 18, 0.12)",
    justifyContent: "flex-end",
    alignItems: "flex-end",
    paddingHorizontal: mobileTheme.spacing[4],
    paddingBottom: 96,
  },
  modal: {
    width: 320,
    height: 360,
    borderRadius: 28,
    backgroundColor: "rgba(251, 248, 243, 0.98)",
    overflow: "hidden",
    paddingHorizontal: mobileTheme.spacing[3],
    paddingTop: mobileTheme.spacing[3],
    paddingBottom: mobileTheme.spacing[3],
    shadowColor: "#111827",
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: mobileTheme.spacing[2],
  },
  headerEyebrow: {
    fontSize: mobileTheme.typography.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    color: mobileTheme.colors.textSoft,
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
    color: mobileTheme.colors.text,
    fontWeight: "300",
  },
  stage: {
    flex: 1,
    minHeight: 0,
    borderRadius: 22,
    overflow: "hidden",
    position: "relative",
    backgroundColor: "#F5F2EB",
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
    left: mobileTheme.spacing[3],
    bottom: mobileTheme.spacing[3],
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
    inset: 28,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(96,165,250,0.8)",
  },
  orbCore: {
    position: "absolute",
    inset: 36,
    borderRadius: 999,
    backgroundColor: "#D8E8FF",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: mobileTheme.spacing[4],
  },
  orbTitle: {
    fontSize: 26,
    fontWeight: "800",
    color: mobileTheme.colors.text,
  },
  orbCaption: {
    marginTop: mobileTheme.spacing[2],
    fontSize: mobileTheme.typography.fontSize.sm,
    color: mobileTheme.colors.textMuted,
    textAlign: "center",
    minHeight: 20,
  },
  footer: {
    marginTop: mobileTheme.spacing[2],
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  footerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: mobileTheme.spacing[2],
  },
  imageIconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    backgroundColor: "rgba(255,255,255,0.72)",
  },
  imageIconText: {
    fontSize: 22,
    lineHeight: 22,
    color: mobileTheme.colors.text,
    fontWeight: "300",
  },
  liveButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: mobileTheme.colors.border,
    backgroundColor: "rgba(255,255,255,0.72)",
    shadowColor: "#111827",
    shadowOpacity: 0.08,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  liveButtonActive: {
    backgroundColor: "rgba(96,165,250,0.12)",
    borderColor: "rgba(96,165,250,0.4)",
  },
  liveButtonText: {
    fontSize: 18,
    color: mobileTheme.colors.text,
  },
});
