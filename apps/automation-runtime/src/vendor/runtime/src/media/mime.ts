import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { type MediaKind, mediaKindFromMime } from "./constants.js";

const EXT_BY_MIME: Record<string, string> = {
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/x-m4a": ".m4a",
  "audio/mp4": ".m4a",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "application/pdf": ".pdf",
  "application/json": ".json",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "application/x-tar": ".tar",
  "application/x-7z-compressed": ".7z",
  "application/vnd.rar": ".rar",
  "application/msword": ".doc",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "text/csv": ".csv",
  "text/plain": ".txt",
  "text/markdown": ".md",
};

const MIME_BY_EXT: Record<string, string> = {
  ...Object.fromEntries(Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime])),
  ".jpeg": "image/jpeg",
  ".js": "text/javascript",
};

const AUDIO_FILE_EXTENSIONS = new Set([
  ".aac",
  ".caf",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
]);

export function normalizeMimeType(mime?: string | null): string | undefined {
  if (!mime) {
    return undefined;
  }
  const cleaned = mime.split(";")[0]?.trim().toLowerCase();
  return cleaned || undefined;
}

async function sniffMime(buffer?: Buffer): Promise<string | undefined> {
  if (!buffer) {
    return undefined;
  }
  try {
    const type = await fileTypeFromBuffer(buffer);
    return type?.mime ?? undefined;
  } catch {
    return undefined;
  }
}

export function getFileExtension(filePath?: string | null): string | undefined {
  if (!filePath) {
    return undefined;
  }
  try {
    if (/^https?:\/\//i.test(filePath)) {
      const url = new URL(filePath);
      return path.extname(url.pathname).toLowerCase() || undefined;
    }
  } catch {
    // Fall through.
  }
  const ext = path.extname(filePath).toLowerCase();
  return ext || undefined;
}

export function isAudioFileName(fileName?: string | null): boolean {
  const ext = getFileExtension(fileName);
  return Boolean(ext && AUDIO_FILE_EXTENSIONS.has(ext));
}

function isGenericMime(mime?: string): boolean {
  if (!mime) {
    return true;
  }
  const normalized = mime.toLowerCase();
  return normalized === "application/octet-stream" || normalized === "application/zip";
}

export async function detectMime(opts: {
  buffer?: Buffer;
  headerMime?: string | null;
  filePath?: string;
}): Promise<string | undefined> {
  const ext = getFileExtension(opts.filePath);
  const extMime = ext ? MIME_BY_EXT[ext] : undefined;
  const headerMime = normalizeMimeType(opts.headerMime);
  const sniffed = await sniffMime(opts.buffer);

  if (sniffed && (!isGenericMime(sniffed) || !extMime)) {
    return sniffed;
  }
  if (extMime) {
    return extMime;
  }
  if (headerMime && !isGenericMime(headerMime)) {
    return headerMime;
  }
  return sniffed ?? headerMime;
}

export function extensionForMime(mime?: string | null): string | undefined {
  const normalized = normalizeMimeType(mime);
  return normalized ? EXT_BY_MIME[normalized] : undefined;
}

export function isGifMedia(opts: {
  contentType?: string | null;
  fileName?: string | null;
}): boolean {
  if (opts.contentType?.toLowerCase() === "image/gif") {
    return true;
  }
  return getFileExtension(opts.fileName) === ".gif";
}

export function imageMimeFromFormat(format?: string | null): string | undefined {
  if (!format) {
    return undefined;
  }
  switch (format.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return undefined;
  }
}

export function kindFromMime(mime?: string | null): MediaKind | undefined {
  return mediaKindFromMime(normalizeMimeType(mime));
}
