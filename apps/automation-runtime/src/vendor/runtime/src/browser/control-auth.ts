import type { RuntimeConfig } from "../config/types.js";

export type BrowserControlAuth = {
  token?: string;
  password?: string;
};

export function resolveBrowserControlAuth(
  cfg: RuntimeConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): BrowserControlAuth {
  const token =
    env.RUNTIME_BROWSER_CONTROL_TOKEN?.trim() ||
    env.RUNTIME_GATEWAY_TOKEN?.trim() ||
    undefined;
  const password =
    env.RUNTIME_BROWSER_CONTROL_PASSWORD?.trim() ||
    env.RUNTIME_GATEWAY_PASSWORD?.trim() ||
    undefined;
  const browserCfg = (cfg as { browser?: { controlAuth?: BrowserControlAuth } } | undefined)?.browser;
  return {
    token: browserCfg?.controlAuth?.token?.trim() || token,
    password: browserCfg?.controlAuth?.password?.trim() || password,
  };
}

export async function ensureBrowserControlAuth(params: {
  cfg: RuntimeConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  auth: BrowserControlAuth;
  generatedToken?: string;
}> {
  return {
    auth: resolveBrowserControlAuth(params.cfg, params.env),
  };
}
