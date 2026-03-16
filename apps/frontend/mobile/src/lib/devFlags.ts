import Constants from "expo-constants";

type ExpoConstantsWithAppOwnership = typeof Constants & {
  appOwnership?: string | null;
};

export function isMobileAuthBypassEnabled(): boolean {
  return String(process.env.EXPO_PUBLIC_BYPASS_MOBILE_AUTH ?? "")
    .trim()
    .toLowerCase() === "true";
}

export function isExpoGo(): boolean {
  const constantsWithOwnership = Constants as ExpoConstantsWithAppOwnership;
  return Constants.executionEnvironment === "storeClient" || constantsWithOwnership.appOwnership === "expo";
}
