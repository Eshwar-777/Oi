export const API_ERROR_EVENT = "oi:api-error";

export function getErrorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof Error) {
    return error.message || fallback;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}

export function emitApiError(message: string) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(API_ERROR_EVENT, {
      detail: { message },
    }),
  );
}

