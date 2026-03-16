const BROWSER_CHANNEL_ALIASES: Record<string, string> = {
  imsg: "imessage",
  "internet-relay-chat": "irc",
  "google-chat": "googlechat",
  gchat: "googlechat",
};

const BROWSER_DELIVERABLE_MESSAGE_CHANNELS = [
  "telegram",
  "whatsapp",
  "discord",
  "irc",
  "googlechat",
  "slack",
  "signal",
  "imessage",
  "line",
] as const;

const BROWSER_DELIVERABLE_MESSAGE_CHANNEL_SET = new Set<string>(
  BROWSER_DELIVERABLE_MESSAGE_CHANNELS,
);

const BROWSER_INTERNAL_MESSAGE_CHANNEL = "webchat";

const BROWSER_GATEWAY_MESSAGE_CHANNEL_SET = new Set<string>([
  ...BROWSER_DELIVERABLE_MESSAGE_CHANNELS,
  BROWSER_INTERNAL_MESSAGE_CHANNEL,
]);

const BROWSER_MARKDOWN_CAPABLE_CHANNELS = new Set<string>([
  "slack",
  "telegram",
  "signal",
  "discord",
  "googlechat",
  "tui",
  BROWSER_INTERNAL_MESSAGE_CHANNEL,
]);

function normalizeBrowserMessageChannel(raw?: string | null): string | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === BROWSER_INTERNAL_MESSAGE_CHANNEL) {
    return BROWSER_INTERNAL_MESSAGE_CHANNEL;
  }
  return BROWSER_CHANNEL_ALIASES[normalized] ?? normalized;
}

export function resolveBrowserGatewayMessageChannel(raw?: string | null): string | undefined {
  const normalized = normalizeBrowserMessageChannel(raw);
  if (!normalized) {
    return undefined;
  }
  return BROWSER_GATEWAY_MESSAGE_CHANNEL_SET.has(normalized) ? normalized : undefined;
}

export function isBrowserMarkdownCapableMessageChannel(raw?: string | null): boolean {
  const normalized = normalizeBrowserMessageChannel(raw);
  if (!normalized) {
    return false;
  }
  return BROWSER_MARKDOWN_CAPABLE_CHANNELS.has(normalized);
}

export function listBrowserDeliverableMessageChannels(): string[] {
  return [...BROWSER_DELIVERABLE_MESSAGE_CHANNEL_SET];
}
