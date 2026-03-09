/// <reference types="vite/client" />

interface ElectronAPI {
  showNotification: (title: string, body: string, route?: string) => void;
  getDeviceInfo?: () => Promise<unknown>;
  getDesktopDeviceRegistration?: () => Promise<{ deviceId: string; deviceName: string }>;
  getRunnerStatus?: () => Promise<unknown>;
  onAppWillQuit?: (listener: () => void) => () => void;
}

interface Window {
  electronAPI?: ElectronAPI;
}
