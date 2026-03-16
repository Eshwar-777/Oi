import { useMemo } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { useMobileTheme } from "@oi/design-system-mobile";

export interface MobileMessageAttachment {
  type: string;
  preview_url?: string;
  caption?: string;
  name?: string;
  summary?: string;
}

export function MessageAttachmentStrip({ attachments }: { attachments: MobileMessageAttachment[] }) {
  const theme = useMobileTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { gap: theme.spacing[2], marginTop: theme.spacing[2] },
        item: { gap: theme.spacing[1] },
        image: {
          width: 180,
          height: 180,
          borderRadius: theme.radii.md,
          backgroundColor: theme.colors.surfaceMuted,
        },
        caption: { fontSize: theme.typography.fontSize.xs, color: theme.colors.textSoft },
      }),
    [theme],
  );

  if (attachments.length === 0) return null;

  return (
    <View style={styles.container}>
      {attachments.map((attachment, index) => (
        <View key={`${attachment.type}-${attachment.preview_url ?? attachment.name ?? index}`} style={styles.item}>
          {attachment.type === "image" && attachment.preview_url ? (
            <Image source={{ uri: attachment.preview_url }} style={styles.image} />
          ) : null}
          {attachment.summary || attachment.caption || attachment.name ? (
            <Text style={styles.caption}>{attachment.summary || attachment.caption || attachment.name}</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}
