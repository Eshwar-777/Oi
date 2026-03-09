import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  getAuth,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from "firebase/auth";
import { useQueryClient } from "@tanstack/react-query";
import { getFirebaseWebApp, isFirebaseWebConfigured, isWebAuthBypassEnabled } from "./firebase";
import { setCurrentAccessToken } from "./session";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  user: User | { email: string; uid: string } | null;
  errorMessage: string;
  isBypassMode: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthContextValue["user"]>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const bypass = isWebAuthBypassEnabled();

  useEffect(() => {
    if (bypass) {
      setCurrentAccessToken("");
      setUser({ email: "dev@localhost", uid: "dev-user" });
      setStatus("authenticated");
      return;
    }

    const app = getFirebaseWebApp();
    if (!app || !isFirebaseWebConfigured()) {
      setCurrentAccessToken("");
      setUser(null);
      setStatus("unauthenticated");
      setErrorMessage("Firebase web auth is not configured.");
      return;
    }

    const auth = getAuth(app);
    const unsubscribe = onIdTokenChanged(auth, async (nextUser) => {
      setUser(nextUser);
      if (!nextUser) {
        setCurrentAccessToken("");
        setStatus("unauthenticated");
        return;
      }
      const token = await nextUser.getIdToken().catch(() => "");
      setCurrentAccessToken(token);
      setStatus("authenticated");
    });

    return unsubscribe;
  }, [bypass]);

  async function signIn(email: string, password: string) {
    if (bypass) {
      setUser({ email, uid: "dev-user" });
      setStatus("authenticated");
      setErrorMessage("");
      return;
    }
    const app = getFirebaseWebApp();
    if (!app) {
      throw new Error("Firebase web auth is not configured.");
    }
    const auth = getAuth(app);
    await signInWithEmailAndPassword(auth, email, password);
    setErrorMessage("");
  }

  async function signOut() {
    queryClient.clear();
    setCurrentAccessToken("");
    setUser(null);
    if (bypass) {
      setStatus("unauthenticated");
      return;
    }
    const app = getFirebaseWebApp();
    if (!app) {
      setStatus("unauthenticated");
      return;
    }
    await firebaseSignOut(getAuth(app));
    setStatus("unauthenticated");
  }

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      errorMessage,
      isBypassMode: bypass,
      signIn,
      signOut,
    }),
    [bypass, errorMessage, status, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return value;
}
