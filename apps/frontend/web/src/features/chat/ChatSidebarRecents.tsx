import { useMemo, useState } from "react";
import {
  Box,
  ButtonBase,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { MaterialSymbol } from "@oi/design-system-web";
import {
  CONVERSATION_FILTER_LABELS,
  conversationLabel,
  conversationMatchesFilter,
  conversationStatusTone,
  type ConversationRecentsFilter,
} from "@oi/ui-presentation";
import { useSearchParams } from "react-router-dom";
import { useAssistant } from "@/features/assistant/AssistantContext";

const STATUS_TONE_COLOR: Record<string, string> = {
  danger: "var(--c-danger-600)",
  warning: "var(--c-warning-600)",
  success: "var(--c-success-600)",
  brand: "var(--c-brand-500)",
  neutral: "var(--text-tertiary)",
};

export function ChatSidebarRecents({ collapsed }: { collapsed: boolean }) {
  const isCompactTopbar = useMediaQuery("(max-width: 780px)");
  const { conversations, createConversation, selectConversation, selectedConversationId } = useAssistant();
  const [searchParams, setSearchParams] = useSearchParams();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const filterParam = searchParams.get("filter");
  const filter: ConversationRecentsFilter =
    filterParam && filterParam in CONVERSATION_FILTER_LABELS
      ? (filterParam as ConversationRecentsFilter)
      : "all";

  const filteredConversations = useMemo(
    () => conversations.filter((conversation) => conversationMatchesFilter(conversation, filter)),
    [conversations, filter],
  );

  if (isCompactTopbar) {
    return (
      <Stack
        spacing={1}
        sx={{
          minWidth: 0,
          p: 1,
          borderRadius: "20px",
          border: "1px solid rgba(125, 88, 63, 0.12)",
          background: "linear-gradient(180deg, rgba(255,255,255,0.7), rgba(255,255,255,0.48))",
          boxShadow: "0 10px 22px rgba(50, 43, 32, 0.05)",
        }}
      >
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
          <Typography
            variant="overline"
            sx={{ color: "var(--text-secondary)", fontWeight: 700, letterSpacing: 0.9 }}
          >
            Recents
          </Typography>
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Tooltip title={`Filter: ${CONVERSATION_FILTER_LABELS[filter]}`}>
              <IconButton
                size="small"
                onClick={(event) => setMenuAnchor(event.currentTarget)}
                sx={{
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border-subtle)",
                  backgroundColor: "rgba(255,255,255,0.62)",
                  transition: "transform 180ms ease, background-color 180ms ease, border-color 180ms ease",
                  "&:hover": {
                    transform: "translateY(-1px)",
                    backgroundColor: "rgba(255,255,255,0.88)",
                  },
                }}
                aria-label="Filter recent conversations"
              >
                <MaterialSymbol name="filter_list" sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Start a new conversation">
              <IconButton
                size="small"
                onClick={() => void createConversation()}
                sx={{
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border-subtle)",
                  backgroundColor: "rgba(255,255,255,0.62)",
                  transition: "transform 180ms ease, background-color 180ms ease, border-color 180ms ease",
                  "&:hover": {
                    transform: "translateY(-1px)",
                    backgroundColor: "rgba(255,255,255,0.88)",
                  },
                }}
              >
                <MaterialSymbol name="add" sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>

        <Stack
          direction="row"
          spacing={0.75}
          sx={{
            minWidth: 0,
            overflowX: "auto",
            pb: 0.25,
            scrollbarWidth: "none",
            "&::-webkit-scrollbar": {
              display: "none",
            },
          }}
        >
          {filteredConversations.map((conversation) => {
            const selected = conversation.conversation_id === selectedConversationId;
            const title = conversationLabel(conversation.title);
            return (
              <ButtonBase
                key={conversation.conversation_id}
                onClick={() => void selectConversation(conversation.conversation_id)}
                sx={{
                  minWidth: 156,
                  maxWidth: 240,
                  justifyContent: "flex-start",
                  gap: 1,
                  px: 1.2,
                  py: 0.9,
                  borderRadius: "16px",
                  border: selected ? "1px solid rgba(125, 88, 63, 0.22)" : "1px solid var(--border-subtle)",
                  backgroundColor: selected ? "rgba(125, 88, 63, 0.12)" : "rgba(255,255,255,0.82)",
                  boxShadow: selected ? "0 8px 18px rgba(125, 88, 63, 0.08)" : "none",
                  color: "var(--text-primary)",
                  transition: "transform 180ms ease, background-color 180ms ease, border-color 180ms ease, box-shadow 180ms ease",
                  "&:hover": {
                    transform: "translateY(-1px)",
                    backgroundColor: selected ? "rgba(125, 88, 63, 0.16)" : "rgba(255,255,255,0.94)",
                    boxShadow: "0 12px 20px rgba(50, 43, 32, 0.09)",
                  },
                }}
              >
                <Box
                  aria-hidden="true"
                  sx={{
                    width: 8,
                    height: 8,
                    minWidth: 8,
                    borderRadius: "999px",
                    backgroundColor: STATUS_TONE_COLOR[conversationStatusTone(conversation)],
                    boxShadow: selected ? "0 0 0 5px rgba(125, 88, 63, 0.08)" : "none",
                  }}
                />
                <Typography variant="body2" noWrap sx={{ minWidth: 0, textAlign: "left", fontWeight: selected ? 700 : 500 }}>
                  {title}
                </Typography>
              </ButtonBase>
            );
          })}

          {filteredConversations.length === 0 ? (
            <Typography variant="body2" sx={{ color: "var(--text-secondary)", py: 1 }}>
              No conversations match this filter
            </Typography>
          ) : null}
        </Stack>

        <Menu
          anchorEl={menuAnchor}
          open={Boolean(menuAnchor)}
          onClose={() => setMenuAnchor(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
          transformOrigin={{ vertical: "top", horizontal: "right" }}
        >
          {(Object.keys(CONVERSATION_FILTER_LABELS) as ConversationRecentsFilter[]).map((key) => (
            <MenuItem
              key={key}
              selected={key === filter}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                if (key === "all") {
                  next.delete("filter");
                } else {
                  next.set("filter", key);
                }
                setSearchParams(next, { replace: true });
                setMenuAnchor(null);
              }}
            >
              {CONVERSATION_FILTER_LABELS[key]}
            </MenuItem>
          ))}
        </Menu>
      </Stack>
    );
  }

  return (
    <Stack spacing={1.5} sx={{ height: "100%", minHeight: 0 }}>
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        sx={{ px: collapsed ? 0 : 0.5 }}
      >
        {collapsed ? <Box sx={{ width: 20, height: 20 }} /> : (
          <Typography
            variant="overline"
            sx={{ color: "var(--text-secondary)", fontWeight: 700, letterSpacing: 0.9 }}
          >
            Recents
          </Typography>
        )}
        <Tooltip title={`Filter: ${CONVERSATION_FILTER_LABELS[filter]}`}>
          <IconButton
            size="small"
            onClick={(event) => setMenuAnchor(event.currentTarget)}
            sx={{ color: "var(--text-secondary)" }}
            aria-label="Filter recent conversations"
          >
            <MaterialSymbol name="filter_list" sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </Stack>

      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={() => setMenuAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        {(Object.keys(CONVERSATION_FILTER_LABELS) as ConversationRecentsFilter[]).map((key) => (
          <MenuItem
            key={key}
            selected={key === filter}
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              if (key === "all") {
                next.delete("filter");
              } else {
                next.set("filter", key);
              }
              setSearchParams(next, { replace: true });
              setMenuAnchor(null);
            }}
          >
            {CONVERSATION_FILTER_LABELS[key]}
          </MenuItem>
        ))}
      </Menu>

      <Stack spacing={0.35} sx={{ flex: 1, minHeight: 0, overflowY: "auto", pr: collapsed ? 0 : 0.5 }}>
        {filteredConversations.map((conversation) => {
          const selected = conversation.conversation_id === selectedConversationId;
          const title = conversationLabel(conversation.title);
          const dot = (
            <Box
              aria-hidden="true"
              sx={{
                width: 8,
                height: 8,
                minWidth: 8,
                borderRadius: "999px",
                backgroundColor: STATUS_TONE_COLOR[conversationStatusTone(conversation)],
                boxShadow: `0 0 0 2px ${selected ? "rgba(125, 88, 63, 0.18)" : "transparent"}`,
              }}
            />
          );

          const row = (
            <ButtonBase
              key={conversation.conversation_id}
              onClick={() => void selectConversation(conversation.conversation_id)}
              sx={{
                width: "100%",
                minHeight: 36,
                justifyContent: collapsed ? "center" : "flex-start",
                gap: collapsed ? 0 : 1.1,
                px: collapsed ? 0 : 1,
                py: 0.8,
                borderRadius: "14px",
                color: "var(--text-primary)",
                backgroundColor: selected ? "rgba(125, 88, 63, 0.1)" : "transparent",
                transition: "transform 160ms ease, background-color 160ms ease",
                "&:hover": {
                  backgroundColor: selected ? "rgba(125, 88, 63, 0.14)" : "var(--surface-card-muted)",
                  transform: collapsed ? "none" : "translateX(2px)",
                },
              }}
            >
              {dot}
              {!collapsed ? (
                <Typography
                  variant="body2"
                  noWrap
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: "left",
                    fontWeight: selected ? 700 : 500,
                  }}
                >
                  {title}
                </Typography>
              ) : null}
            </ButtonBase>
          );

          return (
            <Tooltip key={conversation.conversation_id} title={title} placement="right">
              {row}
            </Tooltip>
          );
        })}

        {filteredConversations.length === 0 ? (
          <Typography
            variant="body2"
            sx={{
              px: collapsed ? 0 : 1,
              py: 0.75,
              color: "var(--text-secondary)",
              textAlign: collapsed ? "center" : "left",
            }}
          >
            {collapsed ? "•" : "No conversations match this filter"}
          </Typography>
        ) : null}
      </Stack>

      {!collapsed ? (
        <Tooltip title="Start a new conversation">
          <ButtonBase
            onClick={() => void createConversation()}
            sx={{
              alignSelf: "flex-start",
              px: 1,
              py: 0.75,
              borderRadius: "12px",
              color: "var(--text-secondary)",
              transition: "transform 160ms ease, background-color 160ms ease",
              "&:hover": {
                backgroundColor: "var(--surface-card-muted)",
                transform: "translateX(2px)",
              },
            }}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <MaterialSymbol name="add" sx={{ fontSize: 18 }} />
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                Start chat
              </Typography>
            </Stack>
          </ButtonBase>
        </Tooltip>
      ) : (
        <Tooltip title="Start a new conversation" placement="right">
          <IconButton
            size="small"
            onClick={() => void createConversation()}
            sx={{
              alignSelf: "center",
              color: "var(--text-secondary)",
              transition: "transform 160ms ease, background-color 160ms ease",
              "&:hover": {
                transform: "translateY(-1px)",
              },
            }}
          >
            <MaterialSymbol name="add" sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      )}
    </Stack>
  );
}
