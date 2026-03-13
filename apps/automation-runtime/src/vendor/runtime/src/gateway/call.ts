export async function callGateway<T = unknown>(_opts: {
  url?: string;
  token?: string;
  password?: string;
  tlsFingerprint?: string;
  method: string;
  params?: unknown;
  expectFinal?: boolean;
  timeoutMs?: number;
  clientName?: string;
  clientDisplayName?: string;
  clientVersion?: string;
  platform?: string;
  mode?: string;
  instanceId?: string;
  minProtocol?: number;
  maxProtocol?: number;
  requiredMethods?: string[];
  scopes?: string[];
}): Promise<T> {
  throw new Error("Gateway RPC is unavailable in the browser-core runtime path.");
}
