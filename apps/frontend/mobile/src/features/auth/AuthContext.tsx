import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  onIdTokenChanged,
  signInWithCustomToken as firebaseSignInWithCustomToken,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from "firebase/auth";
import { useQueryClient } from "@tanstack/react-query";
import { getFirebaseMobileAuth, isFirebaseMobileConfigured } from "@/features/auth/firebase";
import { isMobileAuthBypassEnabled } from "@/lib/devFlags";
import { setCachedAccessToken } from "@/lib/authHeaders";

type AuthUser = User | {
  uid: string;
  email?: string | null;
};

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  authAvailable: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithCustomToken: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function MobileAuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const bypass = isMobileAuthBypassEnabled();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authAvailable, setAuthAvailable] = useState(() => bypass || isFirebaseMobileConfigured());

  useEffect(() => {
    if (bypass) {
      setCachedAccessToken("");
      setAuthAvailable(true);
      setUser({ uid: "dev-user", email: "dev@localhost" });
      setStatus("authenticated");
      return;
    }

    let active = true;
    const auth = getFirebaseMobileAuth();
    if (!auth) {
      setCachedAccessToken("");
      setAuthAvailable(false);
      setUser(null);
      setStatus("unauthenticated");
      return;
    }

    setAuthAvailable(true);
    const unsubscribe = onIdTokenChanged(auth, (nextUser) => {
      if (!active) return;
      setUser(nextUser);
      setStatus(nextUser ? "authenticated" : "unauthenticated");
      if (!nextUser) {
        setCachedAccessToken("");
        return;
      }
      void nextUser
        .getIdToken()
        .then((token) => setCachedAccessToken(token || ""))
        .catch(() => setCachedAccessToken(""));
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [bypass]);

  async function signIn(email: string, password: string) {
    if (bypass) {
      setCachedAccessToken("");
      setUser({ uid: "dev-user", email });
      setStatus("authenticated");
      return;
    }
    const auth = getFirebaseMobileAuth();
    if (!auth) {
      throw new Error("Firebase mobile auth is not configured for this build.");
    }
    const result = await signInWithEmailAndPassword(auth, email, password);
    setCachedAccessToken((await result.user.getIdToken()) || "");
  }

  async function signOut() {
    queryClient.clear();
    setCachedAccessToken("");
    setUser(null);
    if (bypass) {
      setStatus("unauthenticated");
      return;
    }
    const auth = getFirebaseMobileAuth();
    if (!auth) {
      setStatus("unauthenticated");
      return;
    }
    await firebaseSignOut(auth);
    setStatus("unauthenticated");
  }

  async function signInWithCustomToken(token: string) {
    if (bypass) {
      setUser({ uid: "dev-user", email: "dev@localhost" });
      setStatus("authenticated");
      return;
    }
    const auth = getFirebaseMobileAuth();
    if (!auth) {
      throw new Error("Firebase mobile auth is not configured for this build.");
    }
    const result = await firebaseSignInWithCustomToken(auth, token);
    setCachedAccessToken((await result.user.getIdToken()) || "");
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
