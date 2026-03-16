import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  showNotification: (title: string, body: string, route?: string) => {
    ipcRenderer.send("show-notification", { title, body, route });
  },
  getDeviceInfo: () => ipcRenderer.invoke("get-device-info"),
  getDesktopDeviceRegistration: () => ipcRenderer.invoke("get-desktop-device-registration"),
  getRunnerStatus: () => ipcRenderer.invoke("get-runner-status"),
  startRunner: () => ipcRenderer.invoke("start-runner"),
  onAppWillQuit: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("app-will-quit", wrapped);
    return () => {
      ipcRenderer.removeListener("app-will-quit", wrapped);
    };
  },
});
