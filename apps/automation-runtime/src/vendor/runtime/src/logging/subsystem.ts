export type SubsystemLogger = {
  subsystem: string;
  isEnabled: (_level: string, _target?: "any" | "console" | "file") => boolean;
  trace: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  fatal: (message: string, meta?: Record<string, unknown>) => void;
  raw: (message: string) => void;
  child: (name: string) => SubsystemLogger;
};

function write(level: string, subsystem: string, message: string, meta?: Record<string, unknown>): void {
  const prefix = `[${subsystem}] ${message}`;
  const args = meta && Object.keys(meta).length > 0 ? [prefix, meta] : [prefix];
  if (level === "error" || level === "fatal") {
    console.error(...args);
    return;
  }
  if (level === "warn") {
    console.warn(...args);
    return;
  }
  if (level === "debug" || level === "trace") {
    console.debug(...args);
    return;
  }
  console.log(...args);
}

export function createSubsystemLogger(subsystem: string): SubsystemLogger {
  return {
    subsystem,
    isEnabled: () => true,
    trace: (message, meta) => write("trace", subsystem, message, meta),
    debug: (message, meta) => write("debug", subsystem, message, meta),
    info: (message, meta) => write("info", subsystem, message, meta),
    warn: (message, meta) => write("warn", subsystem, message, meta),
    error: (message, meta) => write("error", subsystem, message, meta),
    fatal: (message, meta) => write("fatal", subsystem, message, meta),
    raw: (message) => console.log(message),
    child: (name) => createSubsystemLogger(`${subsystem}/${name}`),
  };
}
