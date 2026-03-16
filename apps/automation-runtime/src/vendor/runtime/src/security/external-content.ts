export type ExternalContentSource =
  | "email"
  | "webhook"
  | "api"
  | "browser"
  | "channel_metadata"
  | "web_search"
  | "web_fetch"
  | "unknown";

export type WrapExternalContentOptions = {
  source: ExternalContentSource;
  sender?: string;
  subject?: string;
  includeWarning?: boolean;
};

export function wrapExternalContent(
  content: string,
  options: WrapExternalContentOptions,
): string {
  const header = options.includeWarning === false
    ? `[Untrusted ${options.source}]`
    : `SECURITY NOTICE: Untrusted ${options.source} content follows.`;
  const meta = [
    options.sender ? `From: ${options.sender}` : "",
    options.subject ? `Subject: ${options.subject}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return [header, meta, content].filter(Boolean).join("\n\n");
}

export function wrapWebContent(content: string, includeWarning = false): string {
  return wrapExternalContent(content, {
    source: "web_fetch",
    includeWarning,
  });
}
