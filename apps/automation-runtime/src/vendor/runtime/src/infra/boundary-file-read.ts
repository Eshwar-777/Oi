import fs from "node:fs";

export function canUseBoundaryFileOpen(ioFs: typeof fs): boolean {
  return typeof ioFs.readFileSync === "function";
}

export type BoundaryFileOpenResult =
  | { ok: true; path: string; fd: number; stat: fs.Stats; rootRealPath: string }
  | { ok: false; reason: string; error?: unknown };

export function openBoundaryFileSync(params: {
  absolutePath: string;
  ioFs?: typeof fs;
  maxBytes?: number;
}): BoundaryFileOpenResult {
  const ioFs = params.ioFs ?? fs;
  try {
    const stat = ioFs.statSync(params.absolutePath);
    if (typeof params.maxBytes === "number" && stat.size > params.maxBytes) {
      return { ok: false, reason: "validation", error: new Error("file too large") };
    }
    const fd = ioFs.openSync(params.absolutePath, "r");
    return { ok: true, path: params.absolutePath, fd, stat, rootRealPath: params.absolutePath };
  } catch (error) {
    return { ok: false, reason: "validation", error };
  }
}

export async function openBoundaryFile(params: {
  absolutePath: string;
  rootPath?: string;
  boundaryLabel?: string;
  rootRealPath?: string;
  maxBytes?: number;
  rejectHardlinks?: boolean;
  allowedType?: unknown;
  skipLexicalRootCheck?: boolean;
  aliasPolicy?: unknown;
  ioFs?: typeof fs;
}): Promise<BoundaryFileOpenResult> {
  return openBoundaryFileSync({
    absolutePath: params.absolutePath,
    ioFs: params.ioFs,
    maxBytes: params.maxBytes,
  });
}
