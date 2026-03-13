const passthrough = (value: string) => value;

export const theme = {
  muted: passthrough,
  success: passthrough,
  warn: passthrough,
  info: passthrough,
  error: passthrough,
};

export function colorize(value: string): string {
  return value;
}

export function isRich(): boolean {
  return false;
}
