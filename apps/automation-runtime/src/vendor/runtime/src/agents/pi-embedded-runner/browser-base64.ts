const BASE64_CHARS_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function canonicalizeBrowserBase64(base64: string): string | undefined {
  const cleaned = base64.replace(/\s+/g, "");
  if (!cleaned || cleaned.length % 4 !== 0 || !BASE64_CHARS_RE.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}
