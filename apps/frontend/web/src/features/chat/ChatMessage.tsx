import { Box, Paper, Typography } from "@mui/material";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface ChatMessageModel {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface ChatMessageProps {
  message: ChatMessageModel;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user";

  return (
    <Box display="flex" justifyContent={isUser ? "flex-end" : "flex-start"}>
      <Paper
        sx={{
          maxWidth: "min(720px, 88%)",
          px: 2.25,
          py: 1.75,
          borderRadius: "20px",
          backgroundColor: isUser ? "var(--c-neutral-900)" : "var(--surface-card)",
          color: isUser ? "var(--text-inverse)" : "var(--text-primary)",
        }}
      >
        {isUser ? (
          <Typography whiteSpace="pre-wrap" variant="body2">
            {message.content}
          </Typography>
        ) : (
          <Box
            sx={{
              "& p": { my: 0, lineHeight: 1.7 },
              "& p + p": { mt: 1.25 },
              "& ul, & ol": { my: 1, pl: 3 },
              "& code": {
                px: 0.5,
                py: 0.25,
                borderRadius: "8px",
                backgroundColor: "var(--surface-card-muted)",
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: "0.85em",
              },
            }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </Box>
        )}
        <Typography
          variant="caption"
          sx={{
            display: "block",
            mt: 1.25,
            color: isUser ? "rgba(255, 255, 255, 0.68)" : "text.secondary",
          }}
        >
          {message.timestamp}
        </Typography>
      </Paper>
    </Box>
  );
}
