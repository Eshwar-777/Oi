export {};

type NavigatorStatus = {
  relay_state: "connecting" | "connected" | "error";
  relay_error?: string;
  relay_url?: string;
};

const relayInput = document.getElementById("relayUrl") as HTMLInputElement;
const statusBox = document.getElementById("status") as HTMLDivElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const checkBtn = document.getElementById("checkBtn") as HTMLButtonElement;

function renderStatus(status: NavigatorStatus) {
  statusBox.classList.remove("ok", "error");
  if (status.relay_state === "connected") {
    statusBox.classList.add("ok");
    statusBox.textContent = "Relay connected.";
    return;
  }
  if (status.relay_state === "connecting") {
    statusBox.textContent = "Connecting to relay…";
    return;
  }
  statusBox.classList.add("error");
  statusBox.textContent = status.relay_error || "Relay not reachable. Check URL and backend status.";
}

async function loadStatus() {
  const status = (await chrome.runtime.sendMessage({ type: "navigator_get_status" })) as NavigatorStatus;
  if (status.relay_url) relayInput.value = status.relay_url;
  renderStatus(status);
}

saveBtn.addEventListener("click", async () => {
  const relayUrl = relayInput.value.trim();
  if (!relayUrl.startsWith("ws://") && !relayUrl.startsWith("wss://")) {
    statusBox.classList.add("error");
    statusBox.textContent = "Relay URL must start with ws:// or wss://";
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: "navigator_set_relay_url", relay_url: relayUrl });
  if (!result?.ok) {
    statusBox.classList.add("error");
    statusBox.textContent = result?.detail || "Failed to save relay URL.";
    return;
  }
  await new Promise((r) => setTimeout(r, 400));
  await loadStatus();
});

checkBtn.addEventListener("click", async () => {
  await loadStatus();
});

loadStatus();
