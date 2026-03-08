import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  showNotification: (title: string, body: string, route?: string) => {
    ipcRenderer.send("show-notification", { title, body, route });
  },
  getDeviceInfo: () => ipcRenderer.invoke("get-device-info"),
  getRunnerStatus: () => ipcRenderer.invoke("get-runner-status"),
});
