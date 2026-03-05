interface AttachedTab {
  tab_id: number;
  url: string;
  title: string;
  is_current: boolean;
}

interface NavigatorStatus {
  relay_state: "connecting" | "connected" | "error";
  relay_error?: string;
  attached_count: number;
  attached_tabs: AttachedTab[];
  current_tab_attached: boolean;
  current_tab_title?: string;
  current_tab_url?: string;
}

const statusDot = document.getElementById("statusDot") as HTMLSpanElement;
const statusText = document.getElementById("statusText") as HTMLSpanElement;
const attachLine = document.getElementById("attachLine") as HTMLDivElement;
const stateHint = document.getElementById("stateHint") as HTMLDivElement;
const toggleAttach = document.getElementById("toggleAttach") as HTMLButtonElement;
const tabList = document.getElementById("tabList") as HTMLUListElement;
const tabCountBadge = document.getElementById("tabCountBadge") as HTMLSpanElement;

async function getStatus(): Promise<NavigatorStatus> {
  return (await chrome.runtime.sendMessage({ type: "navigator_get_status" })) as NavigatorStatus;
}

function friendlyTitle(tab: AttachedTab): string {
  if (tab.title) return tab.title;
  try {
    return new URL(tab.url).hostname.replace(/^www\./, "");
  } catch {
    return "Tab";
  }
}

function friendlyUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname !== "/" ? u.pathname : "");
  } catch {
    return url;
  }
}

function renderStatus(status: NavigatorStatus) {
  statusDot.classList.remove("warning", "error");
  if (status.relay_state === "connected") {
    statusText.textContent = "Relay connected";
  } else if (status.relay_state === "connecting") {
    statusDot.classList.add("warning");
    statusText.textContent = "Connecting…";
  } else {
    statusDot.classList.add("error");
    statusText.textContent = "Relay not reachable";
  }

  if (status.current_tab_attached) {
    attachLine.textContent = "This tab is in the OI group.";
    stateHint.textContent = "Click Detach to remove it from OI control.";
    toggleAttach.textContent = "Detach";
    toggleAttach.className = "primary";
    toggleAttach.style.background = "#fee2e2";
    toggleAttach.style.color = "#991b1b";
  } else {
    attachLine.textContent = status.current_tab_title
      ? `"${status.current_tab_title}" is not attached.`
      : "This tab is not attached.";
    stateHint.textContent = "Click Attach to add it to the OI group and let the agent control it.";
    toggleAttach.textContent = "Attach";
    toggleAttach.className = "primary";
    toggleAttach.style.background = "#751636";
    toggleAttach.style.color = "white";
  }

  if (status.relay_state === "error" && status.relay_error) {
    stateHint.textContent = `${status.relay_error}. Open Setup to fix relay URL or start backend.`;
  }

  tabCountBadge.textContent = String(status.attached_count);

  if (status.attached_tabs.length === 0) {
    tabList.innerHTML = '<li class="empty-state">No tabs attached yet</li>';
    return;
  }

  tabList.innerHTML = "";
  for (const tab of status.attached_tabs) {
    const li = document.createElement("li");
    li.className = "tab-item";
    li.innerHTML = `
      <div class="tab-info">
        <div class="tab-title">${escapeHtml(friendlyTitle(tab))}</div>
        <div class="tab-url">${escapeHtml(friendlyUrl(tab.url))}</div>
      </div>
      <span class="badge-oi">OI</span>
      <button class="danger-sm" data-tab-id="${tab.tab_id}">Detach</button>
    `;
    const btn = li.querySelector("button")!;
    btn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "navigator_detach_tab", tab_id: tab.tab_id });
      await refresh();
    });
    tabList.appendChild(li);
  }
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function refresh() {
  const status = await getStatus();
  renderStatus(status);
}

toggleAttach.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "navigator_toggle_attach_current" });
  await refresh();
});

document.getElementById("refreshStatus")?.addEventListener("click", async () => {
  await refresh();
});

document.getElementById("openOptions")?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("openApp")?.addEventListener("click", () => {
  chrome.tabs.create({ url: "http://localhost:3000/navigator" });
});

refresh();
