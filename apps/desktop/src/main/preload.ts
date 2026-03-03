import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  showNotification: (title: string, body: string) => {
    ipcRenderer.send("show-notification", { title, body });
  },
  getDeviceInfo: () => ({
    platform: process.platform,
    arch: process.arch,
  }),
});
