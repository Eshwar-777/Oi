import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppFrame } from "./AppFrame";
import { LandingPage } from "./LandingPage";
import { ChatPage } from "../features/chat/ChatPage";
import { SchedulesPage } from "../features/schedules/SchedulesPage";
import { DevicesPage } from "../features/settings/DevicesPage";
import { MeshPage } from "../features/settings/MeshPage";
import { SettingsPage } from "../features/settings/SettingsPage";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <LandingPage />,
  },
  {
    path: "/",
    element: <AppFrame />,
    children: [
      { path: "chat", element: <ChatPage /> },
      { path: "schedules", element: <SchedulesPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "settings/devices", element: <DevicesPage /> },
      { path: "settings/mesh", element: <MeshPage /> },
    ],
  },
  {
    path: "*",
    element: <Navigate to="/" replace />,
  },
]);
