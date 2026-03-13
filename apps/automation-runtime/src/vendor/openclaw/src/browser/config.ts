import {
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "./constants.js";

export type ResolvedBrowserConfig = {
  enabled: boolean;
  evaluateEnabled: boolean;
  controlPort: number;
  cdpPortRangeStart: number;
  cdpPortRangeEnd: number;
  cdpProtocol: "http" | "https";
  cdpHost: string;
  cdpIsLoopback: boolean;
  remoteCdpTimeoutMs: number;
  remoteCdpHandshakeTimeoutMs: number;
  color: string;
  executablePath?: string;
  headless: boolean;
  noSandbox: boolean;
  attachOnly: boolean;
  defaultProfile: string;
  profiles: Record<
    string,
    {
      cdpPort?: number;
      cdpUrl?: string;
      cdpHost?: string;
      color?: string;
      driver?: "openclaw" | "extension";
      attachOnly?: boolean;
    }
  >;
  ssrfPolicy?: unknown;
  extraArgs: string[];
  relayBindHost?: string;
};

export type ResolvedBrowserProfile = {
  name: string;
  cdpPort: number;
  cdpUrl: string;
  cdpHost: string;
  cdpIsLoopback: boolean;
  color: string;
  driver: "openclaw" | "extension";
  attachOnly: boolean;
};

export function resolveBrowserConfig(cfg?: {
  enabled?: boolean;
  evaluateEnabled?: boolean;
  controlPort?: number;
  headless?: boolean;
  noSandbox?: boolean;
  attachOnly?: boolean;
  defaultProfile?: string;
  profiles?: ResolvedBrowserConfig["profiles"];
  color?: string;
  extraArgs?: string[];
}): ResolvedBrowserConfig {
  return {
    enabled: cfg?.enabled ?? true,
    evaluateEnabled: cfg?.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED,
    controlPort: cfg?.controlPort ?? 0,
    cdpPortRangeStart: 0,
    cdpPortRangeEnd: 0,
    cdpProtocol: "http",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    remoteCdpTimeoutMs: 1500,
    remoteCdpHandshakeTimeoutMs: 3000,
    color: cfg?.color ?? DEFAULT_OPENCLAW_BROWSER_COLOR,
    headless: cfg?.headless ?? true,
    noSandbox: cfg?.noSandbox ?? false,
    attachOnly: cfg?.attachOnly ?? true,
    defaultProfile: cfg?.defaultProfile ?? DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
    profiles:
      cfg?.profiles ??
      {
        [DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME]: {
          cdpPort: 0,
          color: DEFAULT_OPENCLAW_BROWSER_COLOR,
        },
      },
    extraArgs: cfg?.extraArgs ?? [],
  };
}

export function resolveProfile(
  resolved: ResolvedBrowserConfig,
  name: string,
): ResolvedBrowserProfile | null {
  const profile = resolved.profiles[name];
  if (!profile) {
    return null;
  }
  const cdpPort = profile.cdpPort ?? 0;
  const cdpHost = profile.cdpHost ?? resolved.cdpHost;
  const cdpUrl = profile.cdpUrl ?? `${resolved.cdpProtocol}://${cdpHost}:${cdpPort}`;
  return {
    name,
    cdpPort,
    cdpUrl,
    cdpHost,
    cdpIsLoopback: true,
    color: profile.color ?? resolved.color,
    driver: profile.driver ?? "openclaw",
    attachOnly: profile.attachOnly ?? resolved.attachOnly,
  };
}
