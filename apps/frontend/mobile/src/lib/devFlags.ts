import Constants from "expo-constants";

export function isMobileAuthBypassEnabled(): boolean {
  return String(process.env.EXPO_PUBLIC_BYPASS_MOBILE_AUTH ?? "")
    .trim()
    .toLowerCase() === "true";
}

export function isExpoGo(): boolean {
  return Constants.executionEnvironment === "storeClient";
}
