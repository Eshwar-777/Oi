import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

type Sharp = typeof import("sharp");

export type BrowserImageMetadata = {
  width: number;
  height: number;
};

export const BROWSER_IMAGE_REDUCE_QUALITY_STEPS = [85, 75, 65, 55, 45, 35] as const;

const execFileAsync = promisify(execFile);

function isBun(): boolean {
  return typeof (process.versions as { bun?: unknown }).bun === "string";
}

function prefersSips(): boolean {
  return (
    process.env.RUNTIME_IMAGE_BACKEND === "sips" ||
    (process.env.RUNTIME_IMAGE_BACKEND !== "sharp" && isBun() && process.platform === "darwin")
  );
}

async function runBrowserExec(
  command: string,
  args: string[],
  opts: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<void> {
  await execFileAsync(command, args, {
    timeout: opts.timeoutMs,
    maxBuffer: opts.maxBuffer,
    encoding: "utf8",
  });
}

async function loadSharp(): Promise<(buffer: Buffer) => ReturnType<Sharp>> {
  const mod = (await import("sharp")) as unknown as { default?: Sharp };
  const sharp = mod.default ?? (mod as unknown as Sharp);
  return (buffer) => sharp(buffer, { failOnError: false });
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-img-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function sipsConvertToJpeg(buffer: Buffer): Promise<Buffer> {
  return await withTempDir(async (dir) => {
    const input = path.join(dir, "in.heic");
    const output = path.join(dir, "out.jpg");
    await fs.writeFile(input, buffer);
    await runBrowserExec("/usr/bin/sips", ["-s", "format", "jpeg", input, "--out", output], {
      timeoutMs: 20_000,
      maxBuffer: 1024 * 1024,
    });
    return await fs.readFile(output);
  });
}

async function sipsMetadataFromBuffer(buffer: Buffer): Promise<BrowserImageMetadata | null> {
  return await withTempDir(async (dir) => {
    const input = path.join(dir, "in.img");
    await fs.writeFile(input, buffer);
    const { stdout } = await execFileAsync(
      "/usr/bin/sips",
      ["-g", "pixelWidth", "-g", "pixelHeight", input],
      {
        timeout: 10_000,
        maxBuffer: 512 * 1024,
        encoding: "utf8",
      },
    );
    const widthMatch = stdout.match(/pixelWidth:\s*([0-9]+)/);
    const heightMatch = stdout.match(/pixelHeight:\s*([0-9]+)/);
    if (!widthMatch?.[1] || !heightMatch?.[1]) {
      return null;
    }
    const width = Number.parseInt(widthMatch[1], 10);
    const height = Number.parseInt(heightMatch[1], 10);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  });
}

export function buildBrowserImageResizeSideGrid(maxSide: number, sideStart: number): number[] {
  return [sideStart, 1800, 1600, 1400, 1200, 1000, 800]
    .map((value) => Math.min(maxSide, value))
    .filter((value, idx, arr) => value > 0 && arr.indexOf(value) === idx)
    .toSorted((a, b) => b - a);
}

export async function getBrowserImageMetadata(
  buffer: Buffer,
): Promise<BrowserImageMetadata | null> {
  if (prefersSips()) {
    return await sipsMetadataFromBuffer(buffer).catch(() => null);
  }

  try {
    const sharp = await loadSharp();
    const meta = await sharp(buffer).metadata();
    const width = Number(meta.width ?? 0);
    const height = Number(meta.height ?? 0);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  } catch {
    return null;
  }
}

async function sipsResizeToJpeg(params: {
  buffer: Buffer;
  maxSide: number;
  quality: number;
}): Promise<Buffer> {
  return await withTempDir(async (dir) => {
    const input = path.join(dir, "in.img");
    const output = path.join(dir, "out.jpg");
    await fs.writeFile(input, params.buffer);
    await runBrowserExec(
      "/usr/bin/sips",
      [
        "-Z",
        String(Math.max(1, Math.round(params.maxSide))),
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        String(Math.max(1, Math.min(100, Math.round(params.quality)))),
        input,
        "--out",
        output,
      ],
      { timeoutMs: 20_000, maxBuffer: 1024 * 1024 },
    );
    return await fs.readFile(output);
  });
}

export async function resizeBrowserImageToJpeg(params: {
  buffer: Buffer;
  maxSide: number;
  quality: number;
  withoutEnlargement?: boolean;
}): Promise<Buffer> {
  if (prefersSips()) {
    return await sipsResizeToJpeg({
      buffer: params.buffer,
      maxSide: params.maxSide,
      quality: params.quality,
    });
  }
  const sharp = await loadSharp();
  return await sharp(params.buffer)
    .rotate()
    .resize({
      width: params.maxSide,
      height: params.maxSide,
      fit: "inside",
      withoutEnlargement: params.withoutEnlargement !== false,
    })
    .jpeg({ quality: params.quality, mozjpeg: true })
    .toBuffer();
}

export async function convertBrowserHeicToJpeg(buffer: Buffer): Promise<Buffer> {
  if (prefersSips()) {
    return await sipsConvertToJpeg(buffer);
  }
  const sharp = await loadSharp();
  return await sharp(buffer).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

export async function browserImageHasAlphaChannel(buffer: Buffer): Promise<boolean> {
  try {
    const sharp = await loadSharp();
    const meta = await sharp(buffer).metadata();
    return meta.hasAlpha || meta.channels === 4;
  } catch {
    return false;
  }
}

async function resizeBrowserImageToPng(params: {
  buffer: Buffer;
  maxSide: number;
  compressionLevel?: number;
  withoutEnlargement?: boolean;
}): Promise<Buffer> {
  const sharp = await loadSharp();
  return await sharp(params.buffer)
    .rotate()
    .resize({
      width: params.maxSide,
      height: params.maxSide,
      fit: "inside",
      withoutEnlargement: params.withoutEnlargement !== false,
    })
    .png({ compressionLevel: params.compressionLevel ?? 6 })
    .toBuffer();
}

export async function optimizeBrowserImageToPng(
  buffer: Buffer,
  maxBytes: number,
): Promise<{
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  compressionLevel: number;
}> {
  const sides = [2048, 1536, 1280, 1024, 800];
  const compressionLevels = [6, 7, 8, 9];
  let smallest: {
    buffer: Buffer;
    size: number;
    resizeSide: number;
    compressionLevel: number;
  } | null = null;

  for (const side of sides) {
    for (const compressionLevel of compressionLevels) {
      try {
        const out = await resizeBrowserImageToPng({
          buffer,
          maxSide: side,
          compressionLevel,
          withoutEnlargement: true,
        });
        const size = out.length;
        if (!smallest || size < smallest.size) {
          smallest = { buffer: out, size, resizeSide: side, compressionLevel };
        }
        if (size <= maxBytes) {
          return {
            buffer: out,
            optimizedSize: size,
            resizeSide: side,
            compressionLevel,
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
      compressionLevel: smallest.compressionLevel,
    };
  }

  throw new Error("Failed to optimize PNG image");
}
