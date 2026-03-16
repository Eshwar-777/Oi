import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  applyActionCode,
  createUserWithEmailAndPassword,
  getAuth,
  onIdTokenChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type ActionCodeSettings,
  type User,
} from "firebase/auth";
import { useQueryClient } from "@tanstack/react-query";
import { authFetch } from "@/api/authFetch";
import { getFirebaseWebApp, isFirebaseWebConfigured, isWebAuthBypassEnabled } from "./firebase";
import { setCurrentAccessToken, setCurrentCsrfToken } from "./session";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  user: User | { email: string; uid: string } | null;
  errorMessage: string;
  noticeMessage: string;
  isBypassMode: boolean;
  needsEmailVerification: boolean;
  pendingVerificationEmail: string;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  resendVerificationEmail: () => Promise<void>;
  refreshVerificationStatus: () => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  completeEmailVerification: (oobCode: string) => Promise<void>;
  clearMessages: () => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function isFirebaseUser(user: AuthContextValue["user"]): user is User {
  return Boolean(user && typeof user === "object" && "emailVerified" in user);
}

function actionCodeSettings(pathname: string): ActionCodeSettings | undefined {
  if (typeof window === "undefined") return undefined;
  return {
    url: `${window.location.origin}${pathname}`,
    handleCodeInApp: false,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthContextValue["user"]>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [noticeMessage, setNoticeMessage] = useState("");
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState("");
  const bypass = isWebAuthBypassEnabled();
  const backendSessionRequestRef = useRef<Promise<void> | null>(null);
  const backendSessionRequestKeyRef = useRef("");
  const backendSessionEstablishedKeyRef = useRef("");

  function clearMessages() {
    setErrorMessage("");
    setNoticeMessage("");
  }

  async function establishBackendSession(nextUser: User) {
    const token = await nextUser.getIdToken();
    const requestKey = `${nextUser.uid}:${token}`;
    setCurrentAccessToken(token);
    if (backendSessionEstablishedKeyRef.current === requestKey) {
      return;
    }
    if (
      backendSessionRequestKeyRef.current === requestKey &&
      backendSessionRequestRef.current
    ) {
      await backendSessionRequestRef.current;
      return;
    }
    const pending = (async () => {
      const response = await authFetch("/api/auth/session", { method: "POST" }, { useBearer: true });
      if (!response.ok) {
        throw new Error("Backend session bootstrap failed.");
      }
      const payload = (await response.json().catch(() => ({}))) as { csrf_token?: string };
      setCurrentCsrfToken(payload.csrf_token ?? "");
      backendSessionEstablishedKeyRef.current = requestKey;
    })();
    backendSessionRequestKeyRef.current = requestKey;
    backendSessionRequestRef.current = pending;
    try {
      await pending;
    } finally {
      if (backendSessionRequestKeyRef.current === requestKey) {
        backendSessionRequestRef.current = null;
      }
    }
  }

  async function establishBypassBackendSession() {
    setCurrentAccessToken("");
    await authFetch("/api/auth/csrf");
    const response = await authFetch("/api/auth/session", { method: "POST" });
    if (!response.ok) {
      throw new Error("Backend session bootstrap failed.");
    }
  }

  useEffect(() => {
    if (bypass) {
      setCurrentAccessToken("");
      setCurrentCsrfToken("");
      backendSessionRequestRef.current = null;
      backendSessionRequestKeyRef.current = "";
      backendSessionEstablishedKeyRef.current = "";
      void establishBypassBackendSession()
        .then(() => {
          setCurrentAccessToken("");
          setCurrentCsrfToken("");
          backendSessionRequestRef.current = null;
          backendSessionRequestKeyRef.current = "";
          backendSessionEstablishedKeyRef.current = "";
          setUser({ email: "dev@localhost", uid: "dev-user" });
          setPendingVerificationEmail("");
          clearMessages();
          setStatus("authenticated");
        })
        .catch(() => {
          setCurrentAccessToken("");
          setUser(null);
          setPendingVerificationEmail("");
          setNoticeMessage("");
          setErrorMessage("Backend session bootstrap failed.");
          setStatus("unauthenticated");
        });
      setStatus("loading");
      return;
    }

    const app = getFirebaseWebApp();
    if (!app || !isFirebaseWebConfigured()) {
      setCurrentAccessToken("");
      setCurrentCsrfToken("");
      backendSessionRequestRef.current = null;
      backendSessionRequestKeyRef.current = "";
      backendSessionEstablishedKeyRef.current = "";
      setUser(null);
      setPendingVerificationEmail("");
      setNoticeMessage("");
      setErrorMessage("Firebase web auth is not configured.");
      setStatus("unauthenticated");
      return;
    }

    const auth = getAuth(app);
    const unsubscribe = onIdTokenChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setErrorMessage("");
      if (!nextUser) {
        setCurrentAccessToken("");
        setCurrentCsrfToken("");
        backendSessionRequestRef.current = null;
        backendSessionRequestKeyRef.current = "";
        backendSessionEstablishedKeyRef.current = "";
        setStatus("unauthenticated");
        setPendingVerificationEmail("");
        return;
      }
      if (!nextUser.emailVerified) {
        setCurrentAccessToken("");
        setCurrentCsrfToken("");
        backendSessionRequestRef.current = null;
        backendSessionRequestKeyRef.current = "";
        backendSessionEstablishedKeyRef.current = "";
        setStatus("unauthenticated");
        setPendingVerificationEmail(nextUser.email ?? "");
        setNoticeMessage(`Verify the email link sent to ${nextUser.email ?? "your inbox"} to continue.`);
        return;
      }
      try {
        await establishBackendSession(nextUser);
        setPendingVerificationEmail("");
        setNoticeMessage("");
        setStatus("authenticated");
      } catch {
        setCurrentAccessToken("");
        setCurrentCsrfToken("");
        backendSessionRequestRef.current = null;
        backendSessionRequestKeyRef.current = "";
        setStatus("unauthenticated");
        setErrorMessage("Backend session bootstrap failed.");
      }
    });

    return unsubscribe;
  }, [bypass]);

  async function signIn(email: string, password: string) {
    if (bypass) {
      setUser({ email, uid: "dev-user" });
      setPendingVerificationEmail("");
      clearMessages();
      setStatus("authenticated");
      return;
    }

    const app = getFirebaseWebApp();
    if (!app) {
      throw new Error("Firebase web auth is not configured.");
    }

    clearMessages();
    const credential = await signInWithEmailAndPassword(getAuth(app), email, password);
    if (!credential.user.emailVerified) {
      setCurrentAccessToken("");
      setCurrentCsrfToken("");
      backendSessionRequestRef.current = null;
      backendSessionRequestKeyRef.current = "";
      backendSessionEstablishedKeyRef.current = "";
      setUser(credential.user);
      setPendingVerificationEmail(credential.user.email ?? email);
      setStatus("unauthenticated");
      setNoticeMessage(`Your account exists but email verification is still pending for ${credential.user.email ?? email}.`);
      return;
    }
    await establishBackendSession(credential.user);
    setPendingVerificationEmail("");
    setStatus("authenticated");
  }

  async function signUp(email: string, password: string) {
    if (bypass) {
      setUser({ email, uid: "dev-user" });
      setPendingVerificationEmail("");
      clearMessages();
      setStatus("authenticated");
      return;
    }

    const app = getFirebaseWebApp();
    if (!app) {
      throw new Error("Firebase web auth is not configured.");
    }

    clearMessages();
    const credential = await createUserWithEmailAndPassword(getAuth(app), email, password);
    await sendEmailVerification(credential.user, actionCodeSettings("/auth/action"));
    setCurrentAccessToken("");
    setCurrentCsrfToken("");
    backendSessionRequestRef.current = null;
    backendSessionRequestKeyRef.current = "";
    backendSessionEstablishedKeyRef.current = "";
    setUser(credential.user);
    setPendingVerificationEmail(credential.user.email ?? email);
    setStatus("unauthenticated");
    setNoticeMessage(`We sent a verification link to ${credential.user.email ?? email}.`);
  }

  async function resendVerificationEmail() {
    if (bypass) return;
    if (!isFirebaseUser(user)) {
      throw new Error("No pending verification account found.");
    }
    await sendEmailVerification(user, actionCodeSettings("/auth/action"));
    setNoticeMessage(`Verification email resent to ${user.email ?? (pendingVerificationEmail || "your inbox")}.`);
    setErrorMessage("");
  }

  async function refreshVerificationStatus() {
    if (bypass) return;
    if (!isFirebaseUser(user)) {
      throw new Error("No pending verification account found.");
    }
    await user.reload();
    const auth = getAuth(getFirebaseWebApp()!);
    const refreshedUser = auth.currentUser;
    setUser(refreshedUser);
    if (!refreshedUser?.emailVerified) {
      setCurrentAccessToken("");
      setCurrentCsrfToken("");
      backendSessionRequestRef.current = null;
      backendSessionRequestKeyRef.current = "";
      backendSessionEstablishedKeyRef.current = "";
      setStatus("unauthenticated");
      setNoticeMessage(`Still waiting for email verification for ${refreshedUser?.email ?? (pendingVerificationEmail || "this account")}.`);
      return;
    }
    await establishBackendSession(refreshedUser);
    setPendingVerificationEmail("");
    setNoticeMessage("");
    setStatus("authenticated");
  }

  async function sendPasswordReset(email: string) {
    if (bypass) return;
    const app = getFirebaseWebApp();
    if (!app) {
      throw new Error("Firebase web auth is not configured.");
    }
    await sendPasswordResetEmail(getAuth(app), email, actionCodeSettings("/login"));
    setErrorMessage("");
    setNoticeMessage(`Password reset instructions sent to ${email}.`);
  }

  async function completeEmailVerification(oobCode: string) {
    if (bypass) return;
    const app = getFirebaseWebApp();
    if (!app) {
      throw new Error("Firebase web auth is not configured.");
    }
    const auth = getAuth(app);
    await applyActionCode(auth, oobCode);
    if (auth.currentUser) {
      await auth.currentUser.reload();
      if (auth.currentUser.emailVerified) {
        await establishBackendSession(auth.currentUser);
        setUser(auth.currentUser);
        setPendingVerificationEmail("");
        setNoticeMessage("");
        setStatus("authenticated");
        return;
      }
    }
    setNoticeMessage("Email verified. Sign in to continue.");
    setErrorMessage("");
  }

  async function signOut() {
    queryClient.clear();
    if (!bypass && isFirebaseUser(user)) {
      await authFetch("/api/auth/session", { method: "DELETE" }).catch(() => undefined);
    }
    setCurrentAccessToken("");
    setCurrentCsrfToken("");
    backendSessionRequestRef.current = null;
    backendSessionRequestKeyRef.current = "";
    backendSessionEstablishedKeyRef.current = "";
    setUser(null);
    setPendingVerificationEmail("");
    clearMessages();
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
      noticeMessage,
      isBypassMode: bypass,
      needsEmailVerification: Boolean(isFirebaseUser(user) && !user.emailVerified),
      pendingVerificationEmail,
      signIn,
      signUp,
      resendVerificationEmail,
      refreshVerificationStatus,
      sendPasswordReset,
      completeEmailVerification,
      clearMessages,
      signOut,
    }),
    [bypass, errorMessage, noticeMessage, pendingVerificationEmail, status, user],
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
