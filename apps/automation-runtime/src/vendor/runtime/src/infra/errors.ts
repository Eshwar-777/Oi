import { redactBrowserIdentifier } from "../agents/browser-redact-identifier.js";
import { redactBrowserSensitiveText } from "../agents/browser-redact.js";

export function readErrorName(err: unknown): string {
  if (!err || typeof err !== "object") {
    return "";
  }
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

export function formatErrorMessage(err: unknown): string {
  const value =
    err instanceof Error
      ? err.message || err.name
      : typeof err === "string"
        ? err
        : typeof err === "number" || typeof err === "boolean" || typeof err === "bigint"
          ? String(err)
          : JSON.stringify(err);
  return redactBrowserSensitiveText(value || "Error");
}

export function extractErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

export function formatUncaughtError(err: unknown): string {
  return formatErrorMessage(err);
}

export function hasErrnoCode(err: unknown, code: string): boolean {
  return extractErrorCode(err) === code;
}

export function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(extractErrorCode(err));
}

export function collectErrorGraphCandidates(err: unknown): unknown[] {
  return err == null ? [] : [err];
}
