/**
 * Background service worker for the OI browser extension.
 *
 * Maintains a WebSocket connection to the OI backend and
 * executes browser automation commands from the Companion node.
 */

const BACKEND_WS_URL = "ws://localhost:8080/ws";
let socket: WebSocket | null = null;
let deviceId = "";

async function getOrCreateDeviceId(): Promise<string> {
  const result = await chrome.storage.local.get("oi_device_id");
  if (result.oi_device_id) return result.oi_device_id;

  const id = crypto.randomUUID();
  await chrome.storage.local.set({ oi_device_id: id });
  return id;
}

async function connectWebSocket(): Promise<void> {
  deviceId = await getOrCreateDeviceId();
  socket = new WebSocket(BACKEND_WS_URL);

  socket.onopen = async () => {
    console.log("[OI Extension] WebSocket connected");
    const auth = await chrome.storage.local.get("oi_auth_token");
    socket?.send(
      JSON.stringify({
        type: "auth",
        payload: {
          token: auth.oi_auth_token ?? "",
          device_id: deviceId,
        },
        timestamp: new Date().toISOString(),
      }),
    );
  };

  socket.onmessage = async (event) => {
    try {
      const frame = JSON.parse(event.data);
      await handleBackendCommand(frame);
    } catch (error) {
      console.error("[OI Extension] Failed to handle message:", error);
    }
  };

  socket.onclose = () => {
    console.log("[OI Extension] WebSocket disconnected, reconnecting in 5s");
    setTimeout(connectWebSocket, 5000);
  };
}

async function handleBackendCommand(frame: Record<string, unknown>): Promise<void> {
  const type = frame.type as string;

  if (type === "extension_command") {
    const payload = frame.payload as Record<string, string>;
    const action = payload.action;
    const target = payload.target;

    switch (action) {
      case "navigate":
        await navigateToUrl(target);
        break;
      case "click":
        await sendToContentScript({ action: "click", selector: target });
        break;
      case "type":
        await sendToContentScript({
          action: "type",
          selector: target,
          value: payload.value ?? "",
        });
        break;
      case "screenshot":
        await captureScreenshot();
        break;
      case "read_dom":
        await sendToContentScript({ action: "read_dom", selector: target });
        break;
      default:
        console.warn("[OI Extension] Unknown action:", action);
    }
  }
}

async function navigateToUrl(url: string): Promise<void> {
  const tab = await chrome.tabs.create({ url, active: true });

  // Group the tab under "OI"
  if (tab.id) {
    try {
      const groups = await chrome.tabGroups.query({ title: "OI" });
      if (groups.length > 0) {
        await chrome.tabs.group({ tabIds: tab.id, groupId: groups[0].id });
      } else {
        const groupId = await chrome.tabs.group({ tabIds: tab.id });
        await chrome.tabGroups.update(groupId, {
          title: "OI",
          color: "red",
          collapsed: false,
        });
      }
    } catch {
      // Tab grouping may not be available in all browsers
    }
  }

  sendResult({ action: "navigate", url, status: "done" });
}

async function captureScreenshot(): Promise<void> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab();
    sendResult({ action: "screenshot", data: dataUrl, status: "done" });
  } catch (error) {
    sendResult({ action: "screenshot", status: "error", error: String(error) });
  }
}

async function sendToContentScript(message: Record<string, string>): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, message);
  }
}

function sendResult(payload: Record<string, string>): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        type: "extension_result",
        payload,
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

// Listen for results from content scripts
chrome.runtime.onMessage.addListener((message) => {
  if (message.source === "oi-content-script") {
    sendResult(message.payload);
  }
});

// Connect on install/startup
chrome.runtime.onInstalled.addListener(() => {
  connectWebSocket();
});

chrome.runtime.onStartup.addListener(() => {
  connectWebSocket();
});

connectWebSocket();
