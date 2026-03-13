export function isSafeScpRemoteHost(value: string | undefined): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed && /^[A-Za-z0-9._:-]+$/.test(trimmed));
}
