import { splitBrowserMediaFromOutput } from "./browser-media-parse.js";
import { parseBrowserInlineDirectives } from "./browser-inline-directives.js";
import { resolveBrowserToolDisplay } from "../browser-tool-display.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shortenHomePath(value: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) {
    return value;
  }
  return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function shortenHomeInString(value: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) {
    return value;
  }
  return value.split(home).join("~");
}

export const BROWSER_SILENT_REPLY_TOKEN = "NO_REPLY";

type BrowserToolAggregateOptions = {
  markdown?: boolean;
};

type BrowserReplyDirectiveParseResult = {
  text: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  replyToId?: string;
  replyToCurrent: boolean;
  replyToTag: boolean;
  audioAsVoice?: boolean;
  isSilent: boolean;
};

const silentExactRegexByToken = new Map<string, RegExp>();

function getSilentExactRegex(token: string): RegExp {
  const cached = silentExactRegexByToken.get(token);
  if (cached) {
    return cached;
  }
  const regex = new RegExp(`^\\s*${escapeRegExp(token)}\\s*$`);
  silentExactRegexByToken.set(token, regex);
  return regex;
}

export function isBrowserSilentReplyText(
  text: string | undefined,
  token: string = BROWSER_SILENT_REPLY_TOKEN,
): boolean {
  if (!text) {
    return false;
  }
  return getSilentExactRegex(token).test(text);
}

export function parseBrowserReplyDirectives(
  raw: string,
  options: { currentMessageId?: string; silentToken?: string } = {},
): BrowserReplyDirectiveParseResult {
  const split = splitBrowserMediaFromOutput(raw);
  let text = split.text ?? "";
  const replyParsed = parseBrowserInlineDirectives(text, {
    currentMessageId: options.currentMessageId,
    stripAudioTag: false,
    stripReplyTags: true,
  });
  if (replyParsed.hasReplyTag) {
    text = replyParsed.text;
  }
  const silentToken = options.silentToken ?? BROWSER_SILENT_REPLY_TOKEN;
  const isSilent = isBrowserSilentReplyText(text, silentToken);
  if (isSilent) {
    text = "";
  }
  return {
    text,
    mediaUrls: split.mediaUrls,
    mediaUrl: split.mediaUrl,
    replyToId: replyParsed.replyToId,
    replyToCurrent: replyParsed.replyToCurrent,
    replyToTag: replyParsed.hasReplyTag,
    audioAsVoice: split.audioAsVoice,
    isSilent,
  };
}

function shortenMeta(meta: string): string {
  return meta ? shortenHomeInString(meta) : meta;
}

function isPathLike(value: string): boolean {
  if (!value) {
    return false;
  }
  if (value.includes(" ") || value.includes("://") || value.includes("·")) {
    return false;
  }
  if (value.includes("&&") || value.includes("||")) {
    return false;
  }
  return /^~?(\/[^\s]+)+$/.test(value);
}

function maybeWrapMarkdown(value: string, markdown?: boolean): string {
  if (!markdown || value.includes("`")) {
    return value;
  }
  return `\`${value}\``;
}

function splitExecFlags(meta: string): { flags: string[]; body: string } {
  const parts = meta
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);
  const flags: string[] = [];
  const bodyParts: string[] = [];
  for (const part of parts) {
    if (part === "elevated" || part === "pty") {
      flags.push(part);
    } else {
      bodyParts.push(part);
    }
  }
  return { flags, body: bodyParts.join(" · ") };
}

function formatMetaForDisplay(toolName: string | undefined, meta: string, markdown?: boolean): string {
  const normalized = (toolName ?? "").trim().toLowerCase();
  if (normalized === "exec" || normalized === "bash") {
    const { flags, body } = splitExecFlags(meta);
    if (flags.length > 0) {
      if (!body) {
        return flags.join(" · ");
      }
      return `${flags.join(" · ")} · ${maybeWrapMarkdown(body, markdown)}`;
    }
  }
  return maybeWrapMarkdown(meta, markdown);
}

export function formatBrowserToolAggregate(
  toolName?: string,
  metas?: string[],
  options?: BrowserToolAggregateOptions,
): string {
  const filtered = (metas ?? []).filter(Boolean).map(shortenMeta);
  const display = resolveBrowserToolDisplay({ name: toolName });
  const prefix = `${display.emoji} ${display.label}`;
  if (!filtered.length) {
    return prefix;
  }

  const rawSegments: string[] = [];
  const grouped: Record<string, string[]> = {};
  for (const meta of filtered) {
    if (!isPathLike(meta) || meta.includes("→")) {
      rawSegments.push(meta);
      continue;
    }
    const parts = meta.split("/");
    if (parts.length > 1) {
      const dir = shortenHomePath(parts.slice(0, -1).join("/"));
      const base = parts.at(-1) ?? meta;
      grouped[dir] ??= [];
      grouped[dir].push(base);
      continue;
    }
    grouped["."] ??= [];
    grouped["."].push(meta);
  }

  const groupedSegments = Object.entries(grouped).map(([dir, files]) => {
    const brace = files.length > 1 ? `{${files.join(", ")}}` : files[0];
    return dir === "." ? brace : `${dir}/${brace}`;
  });

  const meta = [...rawSegments, ...groupedSegments].join("; ");
  return `${prefix}: ${formatMetaForDisplay(toolName, meta, options?.markdown)}`;
}
