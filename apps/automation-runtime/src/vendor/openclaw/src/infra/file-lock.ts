export async function withFileLock<T>(
  _targetPath: string,
  _options: unknown,
  callback: () => Promise<T> | T,
): Promise<T> {
  return await callback();
}

export async function acquireFileLock(_targetPath: string, _options?: unknown) {
  return {
    release: async () => {},
  };
}

export type FileLockHandle = Awaited<ReturnType<typeof acquireFileLock>>;
export type FileLockOptions = Record<string, unknown>;
