export function normalizeTrustedSafeBinDirs(value: string[] | undefined): string[] {
  return Array.isArray(value) ? value.map((entry) => entry.trim()).filter(Boolean) : [];
}
