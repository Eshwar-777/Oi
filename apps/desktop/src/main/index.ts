import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  Notification,
  ipcMain,
} from "electron";
import path from "path";

const WEB_URL = process.env.OI_WEB_URL ?? "http://localhost:3000";
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "OI",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`${WEB_URL}/chat`);

  mainWindow.on("close", (event) => {
    event.preventDefault();
    mainWindow?.hide();
  });
}

function createTray(): void {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open OI",
      click: () => mainWindow?.show(),
    },
    { type: "separator" },
    {
      label: "Chat",
      click: () => {
        mainWindow?.show();
        mainWindow?.loadURL(`${WEB_URL}/chat`);
      },
    },
    {
      label: "Navigator",
      click: () => {
        mainWindow?.show();
        mainWindow?.loadURL(`${WEB_URL}/navigator`);
      },
    },
    { type: "separator" },
    {
      label: "Settings",
      click: () => {
        mainWindow?.show();
        mainWindow?.loadURL(`${WEB_URL}/settings`);
      },
    },
    { type: "separator" },
    {
      label: "Quit OI",
      click: () => {
        mainWindow?.destroy();
        app.quit();
      },
    },
  ]);

  tray.setToolTip("OI");
  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    mainWindow?.show();
  });
}

function showNotification(title: string, body: string, route?: string): void {
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body });
    notification.on("click", () => {
      mainWindow?.show();
      if (route) {
        mainWindow?.loadURL(`${WEB_URL}${route}`);
      }
    });
    notification.show();
  }
}

function registerIpcHandlers(): void {
  ipcMain.on("show-notification", (_event, payload) => {
    const { title, body, route } = payload ?? {};
    if (title && body) {
      showNotification(title, body, route);
    }
  });

  ipcMain.handle("get-device-info", () => ({
    platform: process.platform,
    arch: process.arch,
    hostname: require("os").hostname(),
  }));
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();
  createTray();
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

export { showNotification };
