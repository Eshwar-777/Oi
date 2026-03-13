export function sanitizeForLog(value: string): string {
  return value.replace(/\x1B\[[0-9;]*m/g, "");
}
