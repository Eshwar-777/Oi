import { parseBrowserInlineDirectives } from "./browser-inline-directives.js";

type FenceSpan = {
  start: number;
  end: number;
};

const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^\n]+)`?/gi;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const HAS_FILE_EXT = /\.\w{1,10}$/;

function parseFenceSpans(buffer: string): FenceSpan[] {
  const spans: FenceSpan[] = [];
  let open:
    | {
        start: number;
        markerChar: string;
        markerLen: number;
      }
    | undefined;

  let offset = 0;
  while (offset <= buffer.length) {
    const nextNewline = buffer.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? buffer.length : nextNewline;
    const line = buffer.slice(offset, lineEnd);
    const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
    if (match) {
      const marker = match[2];
      const markerChar = marker[0];
      const markerLen = marker.length;
      if (!open) {
        open = { start: offset, markerChar, markerLen };
      } else if (open.markerChar === markerChar && markerLen >= open.markerLen) {
        spans.push({ start: open.start, end: lineEnd });
        open = undefined;
      }
    }
    if (nextNewline === -1) {
      break;
    }
    offset = nextNewline + 1;
  }

  if (open) {
    spans.push({ start: open.start, end: buffer.length });
  }

  return spans;
}

function parseAudioTag(text?: string): {
  text: string;
  audioAsVoice: boolean;
  hadTag: boolean;
} {
  const result = parseBrowserInlineDirectives(text, { stripReplyTags: false });
  return {
    text: result.text,
    audioAsVoice: result.audioAsVoice,
    hadTag: result.hasAudioTag,
  };
}

function normalizeMediaSource(src: string) {
  return src.startsWith("file://") ? src.replace("file://", "") : src;
}

function cleanCandidate(raw: string) {
  return raw.replace(/^[`"'[{(]+/, "").replace(/[`"'\\})\],]+$/, "");
}

function isLikelyLocalPath(candidate: string): boolean {
  return (
    candidate.startsWith("/") ||
    candidate.startsWith("./") ||
    candidate.startsWith("../") ||
    candidate.startsWith("~") ||
    WINDOWS_DRIVE_RE.test(candidate) ||
    candidate.startsWith("\\\\") ||
    (!SCHEME_RE.test(candidate) && (candidate.includes("/") || candidate.includes("\\")))
  );
}

function isValidMedia(
  candidate: string,
  opts?: { allowSpaces?: boolean; allowBareFilename?: boolean },
) {
  if (!candidate || candidate.length > 4096) {
    return false;
  }
  if (!opts?.allowSpaces && /\s/.test(candidate)) {
    return false;
  }
  if (/^https?:\/\//i.test(candidate)) {
    return true;
  }
  if (isLikelyLocalPath(candidate)) {
    return true;
  }
  if (opts?.allowBareFilename && !SCHEME_RE.test(candidate) && HAS_FILE_EXT.test(candidate)) {
    return true;
  }
  return false;
}

function unwrapQuoted(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return undefined;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (first !== last || (first !== `"` && first !== "'" && first !== "`")) {
    return undefined;
  }
  return trimmed.slice(1, -1).trim();
}

function isInsideFence(fenceSpans: FenceSpan[], offset: number): boolean {
  return fenceSpans.some((span) => offset >= span.start && offset < span.end);
}

export function splitBrowserMediaFromOutput(raw: string): {
  text: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  audioAsVoice?: boolean;
} {
  const trimmedRaw = raw.trimEnd();
  if (!trimmedRaw.trim()) {
    return { text: "" };
  }
  const mayContainMediaToken = /media:/i.test(trimmedRaw);
  const mayContainAudioTag = trimmedRaw.includes("[[");
  if (!mayContainMediaToken && !mayContainAudioTag) {
    return { text: trimmedRaw };
  }

  const media: string[] = [];
  let foundMediaToken = false;
  const hasFenceMarkers = trimmedRaw.includes("```") || trimmedRaw.includes("~~~");
  const fenceSpans = hasFenceMarkers ? parseFenceSpans(trimmedRaw) : [];
  const lines = trimmedRaw.split("\n");
  const keptLines: string[] = [];

  let lineOffset = 0;
  for (const line of lines) {
    if (hasFenceMarkers && isInsideFence(fenceSpans, lineOffset)) {
      keptLines.push(line);
      lineOffset += line.length + 1;
      continue;
    }

    const trimmedStart = line.trimStart();
    if (!trimmedStart.startsWith("MEDIA:")) {
      keptLines.push(line);
      lineOffset += line.length + 1;
      continue;
    }

    const matches = Array.from(line.matchAll(MEDIA_TOKEN_RE));
    if (matches.length === 0) {
      keptLines.push(line);
      lineOffset += line.length + 1;
      continue;
    }

    const pieces: string[] = [];
    let cursor = 0;
    for (const match of matches) {
      const start = match.index ?? 0;
      pieces.push(line.slice(cursor, start));
      const payload = match[1];
      const unwrapped = unwrapQuoted(payload);
      const payloadValue = unwrapped ?? payload;
      const parts = unwrapped ? [unwrapped] : payload.split(/\s+/).filter(Boolean);
      const mediaStartIndex = media.length;
      let validCount = 0;
      const invalidParts: string[] = [];
      let hasValidMedia = false;

      for (const part of parts) {
        const candidate = normalizeMediaSource(cleanCandidate(part));
        if (isValidMedia(candidate, unwrapped ? { allowSpaces: true } : undefined)) {
          media.push(candidate);
          hasValidMedia = true;
          foundMediaToken = true;
          validCount += 1;
        } else {
          invalidParts.push(part);
        }
      }

      const trimmedPayload = payloadValue.trim();
      const looksLikeLocalPath =
        isLikelyLocalPath(trimmedPayload) || trimmedPayload.startsWith("file://");
      if (
        !unwrapped &&
        validCount === 1 &&
        invalidParts.length > 0 &&
        /\s/.test(payloadValue) &&
        looksLikeLocalPath
      ) {
        const fallback = normalizeMediaSource(cleanCandidate(payloadValue));
        if (isValidMedia(fallback, { allowSpaces: true })) {
          media.splice(mediaStartIndex, media.length - mediaStartIndex, fallback);
          hasValidMedia = true;
          foundMediaToken = true;
          invalidParts.length = 0;
        }
      }

      if (!hasValidMedia) {
        const fallback = normalizeMediaSource(cleanCandidate(payloadValue));
        if (isValidMedia(fallback, { allowSpaces: true, allowBareFilename: true })) {
          media.push(fallback);
          hasValidMedia = true;
          foundMediaToken = true;
          invalidParts.length = 0;
        }
      }

      if (hasValidMedia) {
        if (invalidParts.length > 0) {
          pieces.push(invalidParts.join(" "));
        }
      } else if (looksLikeLocalPath) {
        foundMediaToken = true;
      } else {
        pieces.push(match[0]);
      }

      cursor = start + match[0].length;
    }

    pieces.push(line.slice(cursor));
    const cleanedLine = pieces.join("").replace(/[ \t]{2,}/g, " ").trim();
    if (cleanedLine) {
      keptLines.push(cleanedLine);
    }
    lineOffset += line.length + 1;
  }

  let cleanedText = keptLines
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

  const audioTagResult = parseAudioTag(cleanedText);
  const hasAudioAsVoice = audioTagResult.audioAsVoice;
  if (audioTagResult.hadTag) {
    cleanedText = audioTagResult.text.replace(/\n{2,}/g, "\n").trim();
  }

  if (media.length === 0) {
    const result: {
      text: string;
      mediaUrls?: string[];
      mediaUrl?: string;
      audioAsVoice?: boolean;
    } = {
      text: foundMediaToken || hasAudioAsVoice ? cleanedText : trimmedRaw,
    };
    if (hasAudioAsVoice) {
      result.audioAsVoice = true;
    }
    return result;
  }

  return {
    text: cleanedText,
    mediaUrls: media,
    mediaUrl: media[0],
    ...(hasAudioAsVoice ? { audioAsVoice: true } : {}),
  };
}
