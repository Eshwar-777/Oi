import type { OpenClawConfig } from "../config/types.js";

export type BrowserControlAuth = {
  token?: string;
  password?: string;
};

export function resolveBrowserControlAuth(
  cfg: OpenClawConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): BrowserControlAuth {
  const token =
    env.OPENCLAW_BROWSER_CONTROL_TOKEN?.trim() ||
    env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
    undefined;
  const password =
    env.OPENCLAW_BROWSER_CONTROL_PASSWORD?.trim() ||
    env.OPENCLAW_GATEWAY_PASSWORD?.trim() ||
    undefined;
  const browserCfg = (cfg as { browser?: { controlAuth?: BrowserControlAuth } } | undefined)?.browser;
  return {
    token: browserCfg?.controlAuth?.token?.trim() || token,
    password: browserCfg?.controlAuth?.password?.trim() || password,
  };
}

export async function ensureBrowserControlAuth(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  auth: BrowserControlAuth;
  generatedToken?: string;
}> {
  return {
    auth: resolveBrowserControlAuth(params.cfg, params.env),
  };
}
