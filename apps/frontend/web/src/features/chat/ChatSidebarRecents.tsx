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
  const {
    conversations,
    createConversation,
    deleteConversation,
    selectConversation,
    selectedConversationId,
  } = useAssistant();
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

  return (
    <Stack spacing={1.5} sx={{ height: "calc(100vh - 243px)", minHeight: 0 }}>
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

      <Stack
        spacing={0.45}
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          scrollbarGutter: "stable",
          pr: collapsed ? 0 : 1.35,
        }}
      >
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
            <Stack
              key={conversation.conversation_id}
              direction="row"
              alignItems="center"
              spacing={collapsed ? 0 : 0.35}
              sx={{
                borderRadius: "14px",
                backgroundColor: selected ? "rgba(125, 88, 63, 0.1)" : "transparent",
                pr: collapsed ? 0 : 0.45,
                "&:hover": {
                  backgroundColor: selected ? "rgba(125, 88, 63, 0.14)" : "var(--surface-card-muted)",
                },
                "& .conversation-delete": {
                  opacity: 0,
                  transform: "scale(0.92)",
                  pointerEvents: "none",
                  transition: "opacity 160ms ease, transform 160ms ease, background-color 160ms ease, color 160ms ease",
                },
                "&:hover .conversation-delete, &:focus-within .conversation-delete": {
                  opacity: 1,
                  transform: "scale(1)",
                  pointerEvents: "auto",
                },
              }}
            >
              <ButtonBase
                onClick={() => void selectConversation(conversation.conversation_id)}
                sx={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 44,
                  justifyContent: collapsed ? "center" : "flex-start",
                  gap: collapsed ? 0 : 1.1,
                  px: collapsed ? 0 : 1,
                  py: 1,
                  borderRadius: "14px",
                  color: "var(--text-primary)",
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
              {!collapsed ? (
                <Tooltip title="Delete conversation">
                  <IconButton
                    size="small"
                    className="conversation-delete"
                    aria-label={`Delete ${title}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void deleteConversation(conversation.conversation_id);
                    }}
                    sx={{
                      width: 30,
                      height: 30,
                      mr: 0.15,
                      color: "var(--text-secondary)",
                      backgroundColor: "color-mix(in srgb, var(--surface-card) 88%, transparent)",
                      border: "1px solid color-mix(in srgb, var(--outline-variant) 72%, transparent)",
                      boxShadow: "0 6px 16px rgba(15, 23, 42, 0.08)",
                      "&:hover": {
                        color: "var(--c-danger-600)",
                        backgroundColor: "color-mix(in srgb, var(--surface-card) 96%, white 4%)",
                      },
                    }}
                  >
                    <Typography
                      component="span"
                      aria-hidden="true"
                      sx={{ fontSize: 17, lineHeight: 1, fontWeight: 600 }}
                    >
                      ×
                    </Typography>
                  </IconButton>
                </Tooltip>
              ) : null}
            </Stack>
          );

          return collapsed ? (
            <Tooltip key={conversation.conversation_id} title={title} placement="right">
              {row}
            </Tooltip>
          ) : row;
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
            {collapsed ? "•" : "No matching conversations"}
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
              "&:hover": {
                backgroundColor: "var(--surface-card-muted)",
              },
            }}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <MaterialSymbol name="add" sx={{ fontSize: 18 }} />
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                New chat
              </Typography>
            </Stack>
          </ButtonBase>
        </Tooltip>
      ) : (
        <Tooltip title="Start a new conversation" placement="right">
          <IconButton
            size="small"
            onClick={() => void createConversation()}
            sx={{ alignSelf: "center", color: "var(--text-secondary)" }}
          >
            <MaterialSymbol name="add" sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      )}
    </Stack>
  );
}
