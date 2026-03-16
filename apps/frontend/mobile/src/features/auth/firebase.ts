import Constants from "expo-constants";
import { getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import { getAuth, inMemoryPersistence, initializeAuth, type Auth, type Persistence } from "firebase/auth";

type FirebaseExtraConfig = Partial<
  Pick<
    FirebaseOptions,
    "apiKey" | "appId" | "authDomain" | "measurementId" | "messagingSenderId" | "projectId" | "storageBucket"
  >
>;

type ExpoConstantsWithFirebase = typeof Constants & {
  expoConfig?: {
    extra?: {
      firebase?: FirebaseExtraConfig;
    };
  };
  manifest?: {
    extra?: {
      firebase?: FirebaseExtraConfig;
    };
  };
  manifest2?: {
    extra?: {
      firebase?: FirebaseExtraConfig;
    };
  };
};

let firebaseApp: FirebaseApp | null = null;
let firebaseAuth: Auth | null = null;
const ASYNC_STORAGE_TEST_KEY = "oi.firebase.auth.persistence.test";

type AsyncStorageLike = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

function loadAsyncStorage(): AsyncStorageLike | null {
  try {
    const candidate = require("@react-native-async-storage/async-storage");
    const moduleValue = (candidate?.default ?? candidate) as Partial<AsyncStorageLike> | undefined;
    if (
      moduleValue
      && typeof moduleValue.getItem === "function"
      && typeof moduleValue.setItem === "function"
      && typeof moduleValue.removeItem === "function"
    ) {
      return moduleValue as AsyncStorageLike;
    }
  } catch {
    return null;
  }
  return null;
}

function createAsyncStoragePersistence(): Persistence | null {
  const storage = loadAsyncStorage();
  if (!storage) {
    return null;
  }
  const asyncStorage = storage;

  class AsyncStoragePersistence {
    static type: "LOCAL" = "LOCAL";
    readonly type: "LOCAL" = "LOCAL";

    async _isAvailable(): Promise<boolean> {
      try {
        await asyncStorage.setItem(ASYNC_STORAGE_TEST_KEY, "1");
        await asyncStorage.removeItem(ASYNC_STORAGE_TEST_KEY);
        return true;
      } catch {
        return false;
      }
    }

    async _set(key: string, value: string): Promise<void> {
      await asyncStorage.setItem(key, value);
    }

    async _get(key: string): Promise<string | null> {
      return await asyncStorage.getItem(key);
    }

    async _remove(key: string): Promise<void> {
      await asyncStorage.removeItem(key);
    }

    _addListener(_key: string, _listener: (value: string | null) => void): void {}

    _removeListener(_key: string, _listener: (value: string | null) => void): void {}
  }

  return AsyncStoragePersistence as unknown as Persistence;
}

function compactConfig(config: FirebaseExtraConfig): FirebaseExtraConfig {
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => typeof value === "string" && value.trim()),
  ) as FirebaseExtraConfig;
}

function readConfig(): FirebaseExtraConfig {
  const constants = Constants as ExpoConstantsWithFirebase;
  const extraConfig = compactConfig({
    ...(constants.expoConfig?.extra?.firebase || {}),
    ...(constants.manifest?.extra?.firebase || {}),
    ...(constants.manifest2?.extra?.firebase || {}),
  });

  const projectId = String(
    extraConfig.projectId
    || process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID
    || "",
  ).trim();

  return compactConfig({
    apiKey: String(extraConfig.apiKey || process.env.EXPO_PUBLIC_FIREBASE_API_KEY || "").trim(),
    authDomain: String(
      extraConfig.authDomain
      || process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN
      || (projectId ? `${projectId}.firebaseapp.com` : ""),
    ).trim(),
    projectId,
    storageBucket: String(extraConfig.storageBucket || process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET || "").trim(),
    appId: String(extraConfig.appId || process.env.EXPO_PUBLIC_FIREBASE_APP_ID || "").trim(),
    messagingSenderId: String(
      extraConfig.messagingSenderId || process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "",
    ).trim(),
    measurementId: String(extraConfig.measurementId || process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID || "").trim(),
  });
}

export function isFirebaseMobileConfigured(): boolean {
  const config = readConfig();
  return Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);
}

export function getFirebaseMobileApp(): FirebaseApp | null {
  if (!isFirebaseMobileConfigured()) {
    return null;
  }

  if (!firebaseApp) {
    firebaseApp = getApps()[0] ?? initializeApp(readConfig() as FirebaseOptions);
  }

  return firebaseApp;
}

export function getFirebaseMobileAuth(): Auth | null {
  const app = getFirebaseMobileApp();
  if (!app) {
    return null;
  }

  if (!firebaseAuth) {
    try {
      const persistence = createAsyncStoragePersistence();
      firebaseAuth = initializeAuth(app, {
        persistence: persistence ?? inMemoryPersistence,
      });
    } catch {
      firebaseAuth = getAuth(app);
    }
  }

  return firebaseAuth;
}
