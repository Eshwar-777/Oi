import type { OAuthCredentials } from "@mariozechner/pi-ai";
import type { RuntimeConfig } from "../../config/config.js";
import type { SecretRef } from "../../config/types.secrets.js";

export type ApiKeyCredential = {
  type: "api_key";
  provider: string;
  key?: string;
  keyRef?: SecretRef;
  email?: string;
  metadata?: Record<string, string>;
};

export type TokenCredential = {
  type: "token";
  provider: string;
  token?: string;
  tokenRef?: SecretRef;
  expires?: number;
  email?: string;
};

export type OAuthCredential = OAuthCredentials & {
  type: "oauth";
  provider: string;
  clientId?: string;
  email?: string;
};

export type AuthProfileCredential = ApiKeyCredential | TokenCredential | OAuthCredential;

export type AuthProfileFailureReason =
  | "auth"
  | "auth_permanent"
  | "format"
  | "overloaded"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "model_not_found"
  | "session_expired"
  | "unknown";

export type ProfileUsageStats = {
  lastUsed?: number;
  cooldownUntil?: number;
  disabledUntil?: number;
  disabledReason?: AuthProfileFailureReason;
  errorCount?: number;
  failureCounts?: Partial<Record<AuthProfileFailureReason, number>>;
  lastFailureAt?: number;
};

export type AuthProfileStore = {
  version: number;
  profiles: Record<string, AuthProfileCredential>;
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
  usageStats?: Record<string, ProfileUsageStats>;
};

export type AuthProfileIdRepairResult = {
  config: RuntimeConfig;
  changes: string[];
  migrated: boolean;
  fromProfileId?: string;
  toProfileId?: string;
};
