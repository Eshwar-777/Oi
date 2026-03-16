export function isSafeExecutableValue(value: string | undefined): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed && !/[;&|`$<>]/.test(trimmed));
}
