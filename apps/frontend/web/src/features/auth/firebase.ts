import { initializeApp, type FirebaseApp } from "firebase/app";

let firebaseApp: FirebaseApp | null = null;

function readConfig() {
  return {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
    appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
    measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID as string | undefined,
  };
}

export function isWebAuthBypassEnabled() {
  const explicitBypass = String(import.meta.env.VITE_BYPASS_WEB_AUTH ?? "").trim().toLowerCase() === "true";
  return explicitBypass;
}

export function isFirebaseWebConfigured() {
  const config = readConfig();
  return Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);
}

export function getFirebaseWebApp(): FirebaseApp | null {
  if (!isFirebaseWebConfigured()) {
    return null;
  }
  if (!firebaseApp) {
    firebaseApp = initializeApp(readConfig());
  }
  return firebaseApp;
}
