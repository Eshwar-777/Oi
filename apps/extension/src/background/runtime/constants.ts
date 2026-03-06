export const DEFAULT_RELAY_WS_URL = import.meta.env.VITE_OI_RELAY_WS_URL || "ws://127.0.0.1:8080/ws";
export const PING_INTERVAL_MS = 25000;

export const STORAGE_KEY_ATTACHED_TABS = "oi_attached_tabs";
export const STORAGE_KEY_AUTH_TOKEN = "oi_auth_token";
export const STORAGE_KEY_AUTH_RENEWAL = "oi_auth_renewal";
export const STORAGE_KEY_FIREBASE_CONFIG = "oi_firebase_config";
export const STORAGE_KEY_AUTH_REFRESH_URL = "oi_auth_refresh_url";

export const OI_GROUP_TITLE = "OI";

export const DEBUG_INFOBAR_GUARD_TOP_PX = 72;
export const DEBUG_INFOBAR_SAFE_OFFSET_PX = 8;

export const UI_STABILIZER_MAX_ATTEMPTS = 3;
export const UI_STABILIZER_POLICY = {
  cookiePreference: "accept" as "accept" | "reject",
  safeCloseKeywords: [
    "close", "dismiss", "skip", "got it", "not now", "later", "cancel", "no thanks",
    "continue", "ok", "understand", "accept all", "allow all",
  ],
  riskyKeywords: ["delete", "remove", "purchase", "pay", "confirm payment", "book now", "checkout"],
};

