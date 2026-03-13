export function estimateBase64DecodedBytes(base64: string): number {
  let effectiveLen = 0;
  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    if (code <= 0x20) {
      continue;
    }
    effectiveLen += 1;
  }

  if (effectiveLen === 0) {
    return 0;
  }

  let padding = 0;
  let end = base64.length - 1;
  while (end >= 0 && base64.charCodeAt(end) <= 0x20) {
    end -= 1;
  }
  if (end >= 0 && base64[end] === "=") {
    padding = 1;
    end -= 1;
    while (end >= 0 && base64.charCodeAt(end) <= 0x20) {
      end -= 1;
    }
    if (end >= 0 && base64[end] === "=") {
      padding = 2;
    }
  }

  const estimated = Math.floor((effectiveLen * 3) / 4) - padding;
  return Math.max(0, estimated);
}

const BASE64_CHARS_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function canonicalizeBase64(base64: string): string | undefined {
  const cleaned = base64.replace(/\s+/g, "");
  if (!cleaned || cleaned.length % 4 !== 0 || !BASE64_CHARS_RE.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}
