export function normalizeSafeBinProfileFixtures<T extends Record<string, unknown>>(value: T | undefined): T {
  return (value ?? ({} as T));
}
