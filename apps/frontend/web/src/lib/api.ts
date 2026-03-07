const apiBaseUrl = (import.meta.env.VITE_OI_API_URL as string | undefined)?.replace(/\/$/, "") || "";

export function toApiUrl(path: string) {
  return apiBaseUrl ? `${apiBaseUrl}${path}` : path;
}
