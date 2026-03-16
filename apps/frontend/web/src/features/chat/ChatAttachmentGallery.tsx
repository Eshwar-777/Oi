import { Box, Stack, Typography } from "@mui/material";

function isImageAttachment(attachment: Record<string, unknown>) {
  return String(attachment.type || "") === "image" && typeof attachment.preview_url === "string";
}

export function ChatAttachmentGallery({ attachments }: { attachments: Array<Record<string, unknown>> }) {
  if (attachments.length === 0) return null;

  return (
    <Stack spacing={1} sx={{ mt: 1.2 }}>
      {attachments.map((attachment, attachmentIndex) => (
        <Box key={`${String(attachment.type)}-${attachmentIndex}`}>
          {isImageAttachment(attachment) ? (
            <Box
              component="img"
              src={String(attachment.preview_url)}
              alt={String(attachment.caption || attachment.name || "Attachment")}
              sx={{
                width: "100%",
                maxWidth: 280,
                borderRadius: "16px",
                border: "1px solid rgba(15, 23, 42, 0.08)",
              }}
            />
          ) : null}
          {attachment.summary || attachment.caption || attachment.name ? (
            <Typography variant="caption" sx={{ display: "block", mt: 0.75, color: "text.secondary" }}>
              {String(attachment.summary || attachment.caption || attachment.name)}
            </Typography>
          ) : null}
        </Box>
      ))}
    </Stack>
  );
}
