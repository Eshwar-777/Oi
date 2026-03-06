import { OI_GROUP_TITLE } from "./constants";
import type { TabInfo } from "./types";

interface AutoAttachDeps {
  attachedTabs: Map<number, TabInfo>;
  autoAttachInFlight: Set<number>;
  persistAttachedTabs: () => Promise<void>;
  setAttachBadge: () => Promise<void>;
  sendTabAttached: (tabId: number, url: string, title: string) => void;
}

export async function ensureOiGroup(tabId: number): Promise<void> {
  try {
    const groups = await chrome.tabGroups.query({ title: OI_GROUP_TITLE });
    if (groups.length > 0) {
      await chrome.tabs.group({ tabIds: tabId, groupId: groups[0].id });
    } else {
      const groupId = await chrome.tabs.group({ tabIds: tabId });
      await chrome.tabGroups.update(groupId, { title: OI_GROUP_TITLE, color: "red", collapsed: false });
    }
  } catch {
    // Tab groups may not be available.
  }
}

export async function removeFromOiGroup(tabId: number): Promise<void> {
  try {
    await chrome.tabs.ungroup(tabId);
  } catch {
    // no-op
  }
}

export async function isInOiGroup(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.groupId || tab.groupId === -1) return false;
    const group = await chrome.tabGroups.get(tab.groupId);
    return group.title === OI_GROUP_TITLE;
  } catch {
    return false;
  }
}

export async function autoAttachTabIfInOiGroup(
  tabId: number,
  deps: AutoAttachDeps,
  tabHint?: chrome.tabs.Tab,
): Promise<void> {
  const { attachedTabs, autoAttachInFlight } = deps;
  if (attachedTabs.has(tabId) || autoAttachInFlight.has(tabId)) return;

  autoAttachInFlight.add(tabId);
  try {
    const tab = tabHint?.id === tabId ? tabHint : await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab?.id) return;
    if (!tab.groupId || tab.groupId === -1) return;
    const inOiGroup = await isInOiGroup(tab.id);
    if (!inOiGroup) return;

    attachedTabs.set(tab.id, { url: tab.url ?? "", title: tab.title ?? "" });
    await deps.persistAttachedTabs();
    await deps.setAttachBadge();
    deps.sendTabAttached(tab.id, tab.url ?? "", tab.title ?? "");
  } finally {
    autoAttachInFlight.delete(tabId);
  }
}

export async function autoAttachTabsInOiGroup(deps: AutoAttachDeps): Promise<void> {
  const groups = await chrome.tabGroups.query({ title: OI_GROUP_TITLE }).catch(() => []);
  if (!groups.length) return;
  for (const group of groups) {
    if (typeof group.id !== "number") continue;
    const tabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
    for (const tab of tabs) {
      if (tab.id) await autoAttachTabIfInOiGroup(tab.id, deps, tab);
    }
  }
}

