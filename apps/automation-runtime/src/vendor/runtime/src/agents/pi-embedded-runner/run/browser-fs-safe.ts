import type { Stats } from "node:fs";
import fs from "node:fs/promises";

export class BrowserSafeOpenError extends Error {
  code: "invalid-path" | "not-found" | "not-file" | "too-large";

  constructor(
    code: "invalid-path" | "not-found" | "not-file" | "too-large",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
    this.name = "BrowserSafeOpenError";
  }
}

export type BrowserSafeLocalReadResult = {
  buffer: Buffer;
  realPath: string;
  stat: Stats;
};

export async function readBrowserLocalFileSafely(params: {
  filePath: string;
  maxBytes?: number;
}): Promise<BrowserSafeLocalReadResult> {
  let stat: Stats;
  try {
    stat = await fs.lstat(params.filePath);
  } catch (error) {
    throw new BrowserSafeOpenError("not-found", "file not found", { cause: error });
  }
  if (stat.isSymbolicLink()) {
    throw new BrowserSafeOpenError("invalid-path", "symlink not allowed");
  }
  if (!stat.isFile()) {
    throw new BrowserSafeOpenError("not-file", "not a file");
  }
  if (params.maxBytes !== undefined && stat.size > params.maxBytes) {
    throw new BrowserSafeOpenError(
      "too-large",
      `file exceeds limit of ${params.maxBytes} bytes (got ${stat.size})`,
    );
  }
  const realPath = await fs.realpath(params.filePath).catch(() => params.filePath);
  const buffer = await fs.readFile(params.filePath);
  return { buffer, realPath, stat };
}
