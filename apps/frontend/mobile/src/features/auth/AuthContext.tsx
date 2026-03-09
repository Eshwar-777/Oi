import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Constants from "expo-constants";
import { useQueryClient } from "@tanstack/react-query";
import { isMobileAuthBypassEnabled } from "@/lib/devFlags";

type FirebaseUser = {
  uid: string;
  email?: string | null;
};

interface FirebaseAuthInstance {
  currentUser: FirebaseUser | null;
  onIdTokenChanged: (listener: (user: FirebaseUser | null) => void) => () => void;
  signInWithEmailAndPassword: (email: string, password: string) => Promise<{ user: FirebaseUser }>;
  signOut: () => Promise<void>;
}

interface FirebaseAuthModule {
  default?: () => FirebaseAuthInstance;
}

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  user: FirebaseUser | null;
  authAvailable: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithCustomToken: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function loadFirebaseAuthFactory(): Promise<(() => FirebaseAuthInstance) | null> {
  if (Constants.executionEnvironment === "storeClient") {
    return null;
  }
  try {
    const authModule = (await import("@react-native-firebase/auth")) as FirebaseAuthModule;
    return typeof authModule.default === "function" ? authModule.default : null;
  } catch {
    return null;
  }
}

export function MobileAuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const bypass = isMobileAuthBypassEnabled();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [authAvailable, setAuthAvailable] = useState(false);

  useEffect(() => {
    if (bypass) {
      setAuthAvailable(true);
      setUser({ uid: "dev-user", email: "dev@localhost" });
      setStatus("authenticated");
      return;
    }

    let active = true;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      const authFactory = await loadFirebaseAuthFactory();
      if (!active) return;
      if (!authFactory) {
        setAuthAvailable(false);
        setUser(null);
        setStatus("unauthenticated");
        return;
      }
      setAuthAvailable(true);
      const auth = authFactory();
      unsubscribe = auth.onIdTokenChanged((nextUser) => {
        if (!active) return;
        setUser(nextUser);
        setStatus(nextUser ? "authenticated" : "unauthenticated");
      });
    })();

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [bypass]);

  async function signIn(email: string, password: string) {
    if (bypass) {
      setUser({ uid: "dev-user", email });
      setStatus("authenticated");
      return;
    }
    const authFactory = await loadFirebaseAuthFactory();
    if (!authFactory) {
      throw new Error("Native Firebase auth is unavailable in Expo Go. Use a dev build or enable bypass.");
    }
    await authFactory().signInWithEmailAndPassword(email, password);
  }

  async function signOut() {
    queryClient.clear();
    setUser(null);
    if (bypass) {
      setStatus("unauthenticated");
      return;
    }
    const authFactory = await loadFirebaseAuthFactory();
    if (!authFactory) {
      setStatus("unauthenticated");
      return;
    }
    await authFactory().signOut();
    setStatus("unauthenticated");
  }

  async function signInWithCustomToken(token: string) {
    if (bypass) {
      setUser({ uid: "dev-user", email: "dev@localhost" });
      setStatus("authenticated");
      return;
    }
    const authFactory = await loadFirebaseAuthFactory();
    if (!authFactory) {
      throw new Error("Native Firebase auth is unavailable in Expo Go. Use a dev build or enable bypass.");
    }
    const auth = authFactory();
    const customAuth = auth as FirebaseAuthInstance & {
      signInWithCustomToken?: (value: string) => Promise<{ user: FirebaseUser }>;
    };
    if (typeof customAuth.signInWithCustomToken !== "function") {
      throw new Error("Custom token sign-in is not available in this mobile build.");
    }
    await customAuth.signInWithCustomToken(token);
  }

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, authAvailable, signIn, signInWithCustomToken, signOut }),
    [authAvailable, status, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useMobileAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useMobileAuth must be used within MobileAuthProvider");
  }
  return value;
}
