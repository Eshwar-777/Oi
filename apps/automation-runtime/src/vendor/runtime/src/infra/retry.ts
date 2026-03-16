export async function retryAsync<T>(
  fn: (attempt: number) => Promise<T>,
  options?: { retries?: number },
): Promise<T> {
  const retries = Math.max(0, options?.retries ?? 2);
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt > retries) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
