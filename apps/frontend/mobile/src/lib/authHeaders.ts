import Constants from "expo-constants";

interface FirebaseAuthUser {
  getIdToken(): Promise<string>;
}

interface FirebaseAuthInstance {
  currentUser: FirebaseAuthUser | null;
}

interface FirebaseAuthModule {
  default?: () => FirebaseAuthInstance;
}

export async function getAccessToken(): Promise<string> {
  if (Constants.executionEnvironment === "storeClient") {
    return "";
  }

  try {
    const authModule = await import("@react-native-firebase/auth") as FirebaseAuthModule;
    const authFactory = authModule.default;
    const user = typeof authFactory === "function" ? authFactory().currentUser : null;
    if (!user) return "";
    return (await user.getIdToken()) || "";
  } catch {
    return "";
  }
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  // Expo Go does not include React Native Firebase native modules.
  if (Constants.executionEnvironment === "storeClient") {
    return headers;
  }

  try {
    const token = await getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    // Expo Go or missing native module: continue without bearer token.
  }

  return headers;
}
