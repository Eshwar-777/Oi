import { createBrowserRouter, Navigate } from "react-router-dom";
import { AssistantProvider } from "../features/assistant/AssistantContext";
import { AppFrame } from "./AppFrame";
import { LandingPage } from "./LandingPage";
import { ChatPage } from "../features/chat/ChatPage";
import { SchedulesPage } from "../features/schedules/SchedulesPage";
import { DevicesPage } from "../features/settings/DevicesPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { AuthActionPage } from "../features/auth/AuthActionPage";
import { ForgotPasswordPage } from "../features/auth/ForgotPasswordPage";
import { LoginPage } from "../features/auth/LoginPage";
import { SignupPage } from "../features/auth/SignupPage";
import { VerificationPendingPage } from "../features/auth/VerificationPendingPage";
import { RequireAuth } from "../features/auth/RequireAuth";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <LandingPage />,
  },
  {
    path: "/login",
    element: <LoginPage />,
  },
  {
    path: "/signup",
    element: <SignupPage />,
  },
  {
    path: "/verify-email",
    element: <VerificationPendingPage />,
  },
  {
    path: "/forgot-password",
    element: <ForgotPasswordPage />,
  },
  {
    path: "/auth/action",
    element: <AuthActionPage />,
  },
  {
    element: <RequireAuth />,
    children: [
      {
        path: "/",
        element: (
          <AssistantProvider>
            <AppFrame />
          </AssistantProvider>
        ),
        children: [
          { path: "chat", element: <ChatPage /> },
          { path: "sessions", element: <DevicesPage /> },
          { path: "schedules", element: <SchedulesPage /> },
          { path: "settings", element: <SettingsPage /> },
          { path: "settings/devices", element: <DevicesPage /> },
        ],
      },
    ],
  },
  {
    path: "*",
    element: <Navigate to="/" replace />,
  },
]);
