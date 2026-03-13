import process from "node:process";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatUncaughtError,
  readErrorName,
} from "./errors.js";

type UnhandledRejectionHandler = (reason: unknown) => boolean;

const handlers = new Set<UnhandledRejectionHandler>();

const FATAL_ERROR_CODES = new Set([
  "ERR_OUT_OF_MEMORY",
  "ERR_SCRIPT_EXECUTION_TIMEOUT",
  "ERR_WORKER_OUT_OF_MEMORY",
  "ERR_WORKER_UNCAUGHT_EXCEPTION",
  "ERR_WORKER_INITIALIZATION_FAILED",
]);

const CONFIG_ERROR_CODES = new Set(["INVALID_CONFIG", "MISSING_API_KEY", "MISSING_CREDENTIALS"]);

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ECONNABORTED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_DNS_RESOLVE_FAILED",
  "UND_ERR_CONNECT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "EPROTO",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_PROTOCOL_RETURNED_AN_ERROR",
]);

const TRANSIENT_NETWORK_ERROR_NAMES = new Set([
  "AbortError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "TimeoutError",
]);

const TRANSIENT_NETWORK_MESSAGE_CODE_RE =
  /\b(ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|EPIPE|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|EPROTO|UND_ERR_CONNECT_TIMEOUT|UND_ERR_DNS_RESOLVE_FAILED|UND_ERR_CONNECT|UND_ERR_SOCKET|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)\b/i;

const TRANSIENT_NETWORK_MESSAGE_SNIPPETS = [
  "getaddrinfo",
  "socket hang up",
  "client network socket disconnected before secure tls connection was established",
  "network error",
  "network is unreachable",
  "temporary failure in name resolution",
  "tlsv1 alert",
  "ssl routines",
  "packet length too long",
  "write eproto",
];

function isWrappedFetchFailedMessage(message: string): boolean {
  if (message === "fetch failed") {
    return true;
  }
  return /:\s*fetch failed$/.test(message);
}

function getErrorCause(err: unknown): unknown {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  return (err as { cause?: unknown }).cause;
}

function extractErrorCodeOrErrno(err: unknown): string | undefined {
  const code = extractErrorCode(err);
  if (code) {
    return code.trim().toUpperCase();
  }
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const errno = (err as { errno?: unknown }).errno;
  if (typeof errno === "string" && errno.trim()) {
    return errno.trim().toUpperCase();
  }
  if (typeof errno === "number" && Number.isFinite(errno)) {
    return String(errno);
  }
  return undefined;
}

function extractErrorCodeWithCause(err: unknown): string | undefined {
  return extractErrorCode(err) ?? extractErrorCode(getErrorCause(err));
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const name = "name" in err ? String((err as { name?: unknown }).name) : "";
  if (name === "AbortError") {
    return true;
  }
  const message = "message" in err ? (err as { message?: unknown }).message : "";
  return message === "This operation was aborted";
}

function isFatalError(err: unknown): boolean {
  const code = extractErrorCodeWithCause(err);
  return Boolean(code && FATAL_ERROR_CODES.has(code));
}

function isConfigError(err: unknown): boolean {
  const code = extractErrorCodeWithCause(err);
  return Boolean(code && CONFIG_ERROR_CODES.has(code));
}

export function isTransientNetworkError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  for (const candidate of collectErrorGraphCandidates(err, (current) => {
    const nested: Array<unknown> = [
      current.cause,
      current.reason,
      current.original,
      current.error,
      current.data,
    ];
    if (Array.isArray(current.errors)) {
      nested.push(...current.errors);
    }
    return nested;
  })) {
    const code = extractErrorCodeOrErrno(candidate);
    if (code && TRANSIENT_NETWORK_CODES.has(code)) {
      return true;
    }
    const name = readErrorName(candidate);
    if (name && TRANSIENT_NETWORK_ERROR_NAMES.has(name)) {
      return true;
    }
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const rawMessage = (candidate as { message?: unknown }).message;
    const message = typeof rawMessage === "string" ? rawMessage.toLowerCase().trim() : "";
    if (!message) {
      continue;
    }
    if (TRANSIENT_NETWORK_MESSAGE_CODE_RE.test(message)) {
      return true;
    }
    if (isWrappedFetchFailedMessage(message)) {
      return true;
    }
    if (TRANSIENT_NETWORK_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) {
      return true;
    }
  }
  return false;
}

export function registerUnhandledRejectionHandler(handler: UnhandledRejectionHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function isUnhandledRejectionHandled(reason: unknown): boolean {
  for (const handler of handlers) {
    try {
      if (handler(reason)) {
        return true;
      }
    } catch (err) {
      console.error(
        "[runtime] Unhandled rejection handler failed:",
        err instanceof Error ? (err.stack ?? err.message) : err,
      );
    }
  }
  return false;
}

export function installUnhandledRejectionHandler(): void {
  process.on("unhandledRejection", (reason) => {
    if (isUnhandledRejectionHandled(reason)) {
      return;
    }
    if (isAbortError(reason)) {
      console.warn("[runtime] Suppressed AbortError:", formatUncaughtError(reason));
      return;
    }
    if (isFatalError(reason)) {
      console.error("[runtime] FATAL unhandled rejection:", formatUncaughtError(reason));
      process.exit(1);
      return;
    }
    if (isConfigError(reason)) {
      console.error("[runtime] CONFIGURATION ERROR - requires fix:", formatUncaughtError(reason));
      process.exit(1);
      return;
    }
    if (isTransientNetworkError(reason)) {
      console.warn(
        "[runtime] Non-fatal unhandled rejection (continuing):",
        formatUncaughtError(reason),
      );
      return;
    }
    console.error("[runtime] Unhandled promise rejection:", formatUncaughtError(reason));
    process.exit(1);
  });
}
