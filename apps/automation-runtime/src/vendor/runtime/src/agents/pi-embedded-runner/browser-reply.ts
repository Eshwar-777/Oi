export const BROWSER_SILENT_REPLY_TOKEN = "__OI_BROWSER_SILENT_REPLY__";

type FormatOptions = {
  markdown?: boolean;
};

type ParsedReply = {
  text: string;
  mediaUrls: string[];
  audioAsVoice: boolean;
  replyToId?: string;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
};

export function formatBrowserToolAggregate(
  toolName: string,
  metas?: string[],
  options?: FormatOptions,
): string {
  const label = options?.markdown ? `\`${toolName}\`` : toolName;
  const suffix = (metas ?? []).filter(Boolean).join(" ");
  return suffix ? `${label} ${suffix}` : label;
}

export function isBrowserSilentReplyText(text: string | undefined | null, token = BROWSER_SILENT_REPLY_TOKEN): boolean {
  return String(text || "").includes(token);
}

export function parseBrowserReplyDirectives(text: string | undefined | null): ParsedReply {
  const value = String(text || "");
  const mediaUrls = Array.from(value.matchAll(/https?:\/\/\S+\.(?:png|jpe?g|gif|webp|mp4|mov|m4a|mp3)/gi)).map(
    (match) => match[0],
  );
  return {
    text: value.replace(BROWSER_SILENT_REPLY_TOKEN, "").trim(),
    mediaUrls,
    audioAsVoice: false,
  };
}
