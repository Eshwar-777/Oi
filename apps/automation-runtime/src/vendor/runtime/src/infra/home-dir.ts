import os from "node:os";
import path from "node:path";
import { expandHomePrefix, resolveRequiredHomeDir } from "../config/browser-support.js";

export { expandHomePrefix, resolveRequiredHomeDir };

export function resolveEffectiveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const resolved = resolveRequiredHomeDir(env, homedir);
  return resolved ? path.resolve(resolved) : undefined;
}
