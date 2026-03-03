import { app, BrowserWindow, Tray, Menu, nativeImage, Notification } from "electron";
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
    // Minimize to tray instead of closing
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
    {
      label: "Chat",
      click: () => {
        mainWindow?.show();
        mainWindow?.loadURL(`${WEB_URL}/chat`);
      },
    },
    {
      label: "Tasks",
      click: () => {
        mainWindow?.show();
        mainWindow?.loadURL(`${WEB_URL}/tasks`);
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

function showNotification(title: string, body: string): void {
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body });
    notification.on("click", () => mainWindow?.show());
    notification.show();
  }
}

app.whenReady().then(() => {
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
  // Keep running in tray on macOS
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Export for IPC usage
export { showNotification };
