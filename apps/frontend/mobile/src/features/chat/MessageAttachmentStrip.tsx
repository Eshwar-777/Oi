import { Image, StyleSheet, Text, View } from "react-native";
import { mobileTheme } from "@oi/design-system-mobile";

export interface MobileMessageAttachment {
  type: string;
  preview_url?: string;
  caption?: string;
  name?: string;
  summary?: string;
}

export function MessageAttachmentStrip({ attachments }: { attachments: MobileMessageAttachment[] }) {
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

const styles = StyleSheet.create({
  container: {
    gap: mobileTheme.spacing[2],
    marginTop: mobileTheme.spacing[2],
  },
  item: {
    gap: mobileTheme.spacing[1],
  },
  image: {
    width: 180,
    height: 180,
    borderRadius: mobileTheme.radii.md,
    backgroundColor: mobileTheme.colors.surfaceMuted,
  },
  caption: {
    fontSize: mobileTheme.typography.fontSize.xs,
    color: mobileTheme.colors.textSoft,
  },
});
