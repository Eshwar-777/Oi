export type BrowserSubsystemLogger = {
  subsystem: string;
  isEnabled: (_level: string, _target?: "any" | "console" | "file") => boolean;
  trace: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  fatal: (message: string, meta?: Record<string, unknown>) => void;
  raw: (message: string) => void;
  child: (name: string) => BrowserSubsystemLogger;
};

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) {
    return "";
  }
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return "";
  }
}

function emit(level: string, subsystem: string, message: string, meta?: Record<string, unknown>) {
  const line = `[runtime/${level}] [${subsystem}] ${message}${formatMeta(meta)}`;
  if (level === "error" || level === "fatal") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export function createBrowserSubsystemLogger(subsystem: string): BrowserSubsystemLogger {
  return {
    subsystem,
    isEnabled: () => true,
    trace: (message, meta) => emit("trace", subsystem, message, meta),
    debug: (message, meta) => emit("debug", subsystem, message, meta),
    info: (message, meta) => emit("info", subsystem, message, meta),
    warn: (message, meta) => emit("warn", subsystem, message, meta),
    error: (message, meta) => emit("error", subsystem, message, meta),
    fatal: (message, meta) => emit("fatal", subsystem, message, meta),
    raw: (message) => console.log(message),
    child: (name) => createBrowserSubsystemLogger(`${subsystem}/${name}`),
  };
}
