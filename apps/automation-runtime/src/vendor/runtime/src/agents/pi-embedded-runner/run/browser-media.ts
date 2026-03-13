import fs from "node:fs/promises";
import path from "node:path";
import { type MediaKind, maxBytesForKind } from "../../../media/constants.js";
import { getDefaultMediaLocalRoots } from "../../../media/local-roots.js";
import {
  browserImageHasAlphaChannel,
  convertBrowserHeicToJpeg,
  optimizeBrowserImageToPng,
  resizeBrowserImageToJpeg,
} from "./browser-image-ops.js";
import { detectMime, extensionForMime, kindFromMime } from "../../../media/mime.js";
import { resolveUserPath } from "../../../utils.js";
import { BrowserSafeOpenError, readBrowserLocalFileSafely } from "./browser-fs-safe.js";

type BrowserMediaResult = {
  buffer: Buffer;
  contentType?: string;
  kind: MediaKind | undefined;
  fileName?: string;
};

type BrowserMediaOptions = {
  maxBytes?: number;
  localRoots?: readonly string[] | "any";
  sandboxValidated?: boolean;
  readFile?: (filePath: string) => Promise<Buffer>;
};

type LocalMediaAccessErrorCode =
  | "path-not-allowed"
  | "invalid-root"
  | "unsafe-bypass"
  | "not-found"
  | "invalid-path"
  | "not-file";

class LocalMediaAccessError extends Error {
  code: LocalMediaAccessErrorCode;

  constructor(code: LocalMediaAccessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "LocalMediaAccessError";
  }
}

const HEIC_MIME_RE = /^image\/hei[cf]$/i;
const HEIC_EXT_RE = /\.(heic|heif)$/i;
const MB = 1024 * 1024;

function formatMb(bytes: number, digits = 2): string {
  return (bytes / MB).toFixed(digits);
}

function formatCapLimit(label: string, cap: number, size: number): string {
  return `${label} exceeds ${formatMb(cap, 0)}MB limit (got ${formatMb(size)}MB)`;
}

function formatCapReduce(label: string, cap: number, size: number): string {
  return `${label} could not be reduced below ${formatMb(cap, 0)}MB (got ${formatMb(size)}MB)`;
}

function isHeicSource(opts: { contentType?: string; fileName?: string }): boolean {
  if (opts.contentType && HEIC_MIME_RE.test(opts.contentType.trim())) {
    return true;
  }
  if (opts.fileName && HEIC_EXT_RE.test(opts.fileName.trim())) {
    return true;
  }
  return false;
}

function toJpegFileName(fileName?: string): string | undefined {
  if (!fileName) {
    return undefined;
  }
  const trimmed = fileName.trim();
  if (!trimmed) {
    return fileName;
  }
  const parsed = path.parse(trimmed);
  if (!parsed.ext || HEIC_EXT_RE.test(parsed.ext)) {
    return path.format({ dir: parsed.dir, name: parsed.name || trimmed, ext: ".jpg" });
  }
  return path.format({ dir: parsed.dir, name: parsed.name, ext: ".jpg" });
}

type OptimizedImage = {
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  format: "jpeg" | "png";
  quality?: number;
};

async function assertLocalMediaAllowed(
  mediaPath: string,
  localRoots: readonly string[] | "any" | undefined,
): Promise<void> {
  if (localRoots === "any") {
    return;
  }
  const roots = localRoots ?? getDefaultMediaLocalRoots();
  let resolved: string;
  try {
    resolved = await fs.realpath(mediaPath);
  } catch {
    resolved = path.resolve(mediaPath);
  }

  if (localRoots === undefined) {
    const workspaceRoot = roots.find((root) => path.basename(root) === "workspace");
    if (workspaceRoot) {
      const stateDir = path.dirname(workspaceRoot);
      const rel = path.relative(stateDir, resolved);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        const firstSegment = rel.split(path.sep)[0] ?? "";
        if (firstSegment.startsWith("workspace-")) {
          throw new LocalMediaAccessError(
            "path-not-allowed",
            `Local media path is not under an allowed directory: ${mediaPath}`,
          );
        }
      }
    }
  }

  for (const root of roots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await fs.realpath(root);
    } catch {
      resolvedRoot = path.resolve(root);
    }
    if (resolvedRoot === path.parse(resolvedRoot).root) {
      throw new LocalMediaAccessError(
        "invalid-root",
        `Invalid localRoots entry (refuses filesystem root): ${root}. Pass a narrower directory.`,
      );
    }
    if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)) {
      return;
    }
  }

  throw new LocalMediaAccessError(
    "path-not-allowed",
    `Local media path is not under an allowed directory: ${mediaPath}`,
  );
}

async function optimizeImageWithFallback(params: {
  buffer: Buffer;
  cap: number;
  meta?: { contentType?: string; fileName?: string };
}): Promise<OptimizedImage> {
  const { buffer, cap, meta } = params;
  const isPng = meta?.contentType === "image/png" || meta?.fileName?.toLowerCase().endsWith(".png");
  const hasAlpha = isPng && (await browserImageHasAlphaChannel(buffer));

  if (hasAlpha) {
    const optimized = await optimizeBrowserImageToPng(buffer, cap);
    if (optimized.buffer.length <= cap) {
      return { ...optimized, format: "png" };
    }
  }

  let source = buffer;
  if (isHeicSource(meta ?? {})) {
    source = await convertBrowserHeicToJpeg(buffer);
  }

  const sides = [2048, 1536, 1280, 1024, 800];
  const qualities = [80, 70, 60, 50, 40];
  let smallest: {
    buffer: Buffer;
    size: number;
    resizeSide: number;
    quality: number;
  } | null = null;

  for (const side of sides) {
    for (const quality of qualities) {
      try {
        const out = await resizeBrowserImageToJpeg({
          buffer: source,
          maxSide: side,
          quality,
          withoutEnlargement: true,
        });
        const size = out.length;
        if (!smallest || size < smallest.size) {
          smallest = { buffer: out, size, resizeSide: side, quality };
        }
        if (size <= cap) {
          return {
            buffer: out,
            optimizedSize: size,
            resizeSide: side,
            format: "jpeg",
            quality,
          };
        }
      } catch {
        // Keep trying smaller encodes.
      }
    }
  }

  if (smallest) {
    return {
      buffer: smallest.buffer,
      optimizedSize: smallest.size,
      resizeSide: smallest.resizeSide,
      format: "jpeg",
      quality: smallest.quality,
    };
  }

  throw new Error("Failed to optimize image");
}

async function clampAndFinalize(params: {
  buffer: Buffer;
  contentType?: string;
  kind: MediaKind | undefined;
  fileName?: string;
  maxBytes?: number;
}): Promise<BrowserMediaResult> {
  const cap = params.maxBytes ?? maxBytesForKind(params.kind ?? "document");
  if (params.kind === "image") {
    const isGif = params.contentType === "image/gif";
    if (isGif) {
      if (params.buffer.length > cap) {
        throw new Error(formatCapLimit("GIF", cap, params.buffer.length));
      }
      return params;
    }

    const optimized = await optimizeImageWithFallback({
      buffer: params.buffer,
      cap,
      meta: {
        contentType: params.contentType,
        fileName: params.fileName,
      },
    });
    if (optimized.buffer.length > cap) {
      throw new Error(formatCapReduce("Media", cap, optimized.buffer.length));
    }
    return {
      buffer: optimized.buffer,
      contentType: optimized.format === "png" ? "image/png" : "image/jpeg",
      kind: "image",
      fileName:
        optimized.format === "jpeg" && isHeicSource(params)
          ? toJpegFileName(params.fileName)
          : params.fileName,
    };
  }

  if (params.buffer.length > cap) {
    throw new Error(formatCapLimit("Media", cap, params.buffer.length));
  }
  return params;
}

export async function loadBrowserLocalMedia(
  mediaPath: string,
  maxBytesOrOptions?: number | BrowserMediaOptions,
): Promise<BrowserMediaResult> {
  const options: BrowserMediaOptions =
    typeof maxBytesOrOptions === "number" || maxBytesOrOptions === undefined
      ? { maxBytes: maxBytesOrOptions }
      : maxBytesOrOptions;
  let resolvedPath = mediaPath.replace(/^\s*MEDIA\s*:\s*/i, "");

  if (resolvedPath.startsWith("~")) {
    resolvedPath = resolveUserPath(resolvedPath);
  }

  const { maxBytes, localRoots, sandboxValidated = false, readFile: readFileOverride } = options;

  if ((sandboxValidated || localRoots === "any") && !readFileOverride) {
    throw new LocalMediaAccessError(
      "unsafe-bypass",
      "Refusing localRoots bypass without readFile override. Use sandboxValidated with readFile, or pass explicit localRoots.",
    );
  }
  if (!(sandboxValidated || localRoots === "any")) {
    await assertLocalMediaAllowed(resolvedPath, localRoots);
  }

  let data: Buffer;
  if (readFileOverride) {
    data = await readFileOverride(resolvedPath);
  } else {
    try {
      data = (await readBrowserLocalFileSafely({ filePath: resolvedPath })).buffer;
    } catch (err) {
      if (err instanceof BrowserSafeOpenError) {
        if (err.code === "not-found") {
          throw new LocalMediaAccessError("not-found", `Local media file not found: ${resolvedPath}`, {
            cause: err,
          });
        }
        if (err.code === "not-file") {
          throw new LocalMediaAccessError("not-file", `Local media path is not a file: ${resolvedPath}`, {
            cause: err,
          });
        }
        throw new LocalMediaAccessError(
          "invalid-path",
          `Local media path is not safe to read: ${resolvedPath}`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  const mime = await detectMime({ buffer: data, filePath: resolvedPath });
  const kind = kindFromMime(mime);
  let fileName = path.basename(resolvedPath) || undefined;
  if (fileName && !path.extname(fileName) && mime) {
    const ext = extensionForMime(mime);
    if (ext) {
      fileName = `${fileName}${ext}`;
    }
  }

  return await clampAndFinalize({
    buffer: data,
    contentType: mime,
    kind,
    fileName,
    maxBytes,
  });
}
