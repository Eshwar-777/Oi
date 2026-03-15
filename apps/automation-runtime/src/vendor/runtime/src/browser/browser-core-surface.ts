import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import {
  DEFAULT_AI_SNAPSHOT_EFFICIENT_DEPTH,
  DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS,
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  DEFAULT_BROWSER_DEFAULT_PROFILE_NAME,
} from "./constants.js";
import { loadBrowserConfig } from "../config/browser-config.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";

export {
  DEFAULT_AI_SNAPSHOT_EFFICIENT_DEPTH,
  DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS,
  DEFAULT_AI_SNAPSHOT_MAX_CHARS,
  resolveBrowserConfig,
};

type BrowserTabRef = {
  baseUrl?: string;
  profile?: string;
  targetId: string;
};

type SnapshotRefEntry = {
  xpath: string;
  role: string;
  name: string;
};

type SnapshotForAIPage = Page & {
  _snapshotForAI?: (options?: { timeout?: number; track?: string }) => Promise<{ full?: string }>;
};

type BrowserSnapshotOptions = {
  profile?: string;
  targetId?: string;
  selector?: string;
  frame?: string;
  snapshotFormat?: "ai" | "aria" | "role";
  maxChars?: number;
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  refs?: "aria" | "role";
  mode?: "efficient";
};

const SESSION_TAB_TRACKER = new Map<string, BrowserTabRef>();
const SNAPSHOT_REFS = new Map<string, Map<string, SnapshotRefEntry>>();
export const DEFAULT_UPLOAD_DIR = path.join(os.homedir(), "Downloads");
const SNAPSHOT_OPERATION_TIMEOUT_MS = 5_000;

function normalizeProfile(profile?: string): string {
  return profile?.trim() || DEFAULT_BROWSER_DEFAULT_PROFILE_NAME;
}

function slug(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_");
}

function normalizeKeyboardKey(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "Enter";
  const lowered = raw.toLowerCase();
  if (lowered === "return") return "Enter";
  if (lowered === "esc") return "Escape";
  if (lowered === "spacebar") return " ";
  return raw;
}

function normalizedUrlParts(rawUrl: string): {
  href: string;
  origin: string;
  host: string;
  path: string;
  siteKey: string;
} | null {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed || trimmed.toLowerCase() === "about:blank") {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    const host = parsed.hostname.toLowerCase();
    const hostParts = host.split(".").filter(Boolean);
    const siteKey = hostParts.slice(-2).join(".") || host;
    return {
      href: parsed.href,
      origin: parsed.origin.toLowerCase(),
      host,
      path,
      siteKey,
    };
  } catch {
    return null;
  }
}

function reusablePageScore(candidateUrl: string, targetUrl: string): number {
  const candidate = normalizedUrlParts(candidateUrl);
  const target = normalizedUrlParts(targetUrl);
  if (!candidate || !target) {
    return 0;
  }
  if (candidate.href === target.href) {
    return 120;
  }
  if (candidate.origin === target.origin && candidate.path === target.path) {
    return 100;
  }
  if (candidate.origin === target.origin) {
    return 80;
  }
  if (candidate.siteKey && candidate.siteKey === target.siteKey) {
    return 50;
  }
  return 0;
}

async function bestReusablePageIndex(pages: Page[], targetUrl: string): Promise<number> {
  let bestIndex = -1;
  let bestScore = 0;
  for (const [index, page] of pages.entries()) {
    const score = reusablePageScore(page.url(), targetUrl);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function isBlockedTopLevelNavigationError(error: unknown): boolean {
  const message = String(error || "").toLowerCase();
  return message.includes("net::err_blocked_by_response");
}

function normalizeScrollCoordinate(
  value: unknown,
): number | "page_end" | "page_start" {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) {
    return 0;
  }
  if (raw === "page_end" || raw === "bottom" || raw === "end" || raw === "max") {
    return "page_end";
  }
  if (raw === "page_start" || raw === "top" || raw === "start") {
    return "page_start";
  }
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : 0;
}

function compileEvaluateSource(source: unknown): string {
  const raw = typeof source === "string" ? source.trim() : "";
  if (!raw) {
    return "null";
  }
  const lowered = raw.toLowerCase();
  const looksLikeFunction =
    raw.includes("=>") ||
    lowered.startsWith("function") ||
    lowered.startsWith("async function") ||
    lowered.startsWith("async (") ||
    lowered.startsWith("async(") ||
    lowered.startsWith("(");
  return looksLikeFunction ? `(${raw})()` : raw;
}

async function connectForProfile(profile?: string): Promise<{
  browser: Browser;
  page: Page | null;
  pages: Page[];
  resolvedProfile: string;
}> {
  const cfg = loadBrowserConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const profileName = normalizeProfile(profile || resolved.defaultProfile);
  const selected = resolveProfile(resolved, profileName);
  if (!selected?.cdpUrl) {
    throw new Error(`Browser profile "${profileName}" is not configured.`);
  }
  const browser = await chromium.connectOverCDP(selected.cdpUrl);
  const pages = browser.contexts().flatMap((context) => context.pages());
  let preferredPage: Page | null = null;
  for (const candidate of pages) {
    try {
      const hasFocus = await candidate.evaluate(() => document.hasFocus());
      if (hasFocus) {
        preferredPage = candidate;
      }
    } catch {
      continue;
    }
  }
  if (!preferredPage) {
    const realPages = pages.filter((candidate) => {
      const url = candidate.url().trim().toLowerCase();
      return url !== "" && url !== "about:blank";
    });
    preferredPage = realPages.at(-1) ?? pages.at(-1) ?? null;
  }
  return { browser, page: preferredPage, pages, resolvedProfile: profileName };
}

async function resetPageViewport(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      window.scrollTo({ left: 0, top: 0 });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    })
    .catch(() => undefined);
}

async function getTargetId(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  const info = (await session.send("Target.getTargetInfo")) as {
    targetInfo?: { targetId?: string };
  };
  return info.targetInfo?.targetId || `page:${Date.now()}`;
}

async function resolvePage(params: {
  profile?: string;
  targetId?: string;
}): Promise<{
  browser: Browser;
  page: Page;
  pages: Page[];
  targetId: string;
  profile: string;
}> {
  const connected = await connectForProfile(params.profile);
  try {
    if (connected.pages.length === 0) {
      throw new Error("No browser pages are currently open.");
    }
    let page = connected.page;
    let targetId =
      params.targetId?.trim() || String(process.env.OI_BROWSER_TARGET_ID || "").trim() || undefined;
    if (targetId) {
      for (const candidate of connected.pages) {
        const candidateTargetId = await getTargetId(candidate);
        if (candidateTargetId === targetId) {
          page = candidate;
          break;
        }
      }
    }
    if (!page) {
      throw new Error("No browser page is available.");
    }
    targetId = await getTargetId(page);
    return {
      browser: connected.browser,
      page,
      pages: connected.pages,
      targetId,
      profile: connected.resolvedProfile,
    };
  } catch (error) {
    await closeBrowserConnection(connected.browser);
    throw error;
  }
}

async function pageSummary(page: Page): Promise<{ title: string; url: string; targetId: string }> {
  return {
    title: await page.title().catch(() => ""),
    url: page.url(),
    targetId: await getTargetId(page),
  };
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxChars)}...`, truncated: true };
}

async function withOperationTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function closeBrowserConnection(browser: Browser): Promise<void> {
  await Promise.race([
    browser.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 250)),
  ]).catch(() => undefined);
}

function buildRefSnapshotFromAiText(params: {
  snapshot: string;
  format: "ai" | "aria" | "role";
  maxChars: number;
  targetId: string;
  page: Page;
}) {
  const refs: Record<string, SnapshotRefEntry> = {};
  const nodes: Array<Record<string, unknown>> = [];
  const compactLines: string[] = [];
  const linePattern = /^\s*-\s+(.+?)\s+\[ref=(e\d+)\](?:\s+\[[^\]]+\])*\s*:?\s*$/;
  const namePattern = /^([a-zA-Z][\w-]*)(?:\s+"([^"]+)")?/;
  for (const rawLine of params.snapshot.split(/\r?\n/)) {
    const match = linePattern.exec(rawLine);
    if (!match) {
      continue;
    }
    const descriptor = String(match[1] || "").trim();
    const ref = String(match[2] || "").trim();
    const descriptorMatch = namePattern.exec(descriptor);
    if (!descriptorMatch) {
      continue;
    }
    const role = String(descriptorMatch[1] || "").trim().toLowerCase();
    const name = String(descriptorMatch[2] || "").trim();
    refs[ref] = { xpath: `synthetic:${ref}`, role, name };
    nodes.push({ ref, role, name, text: name });
    compactLines.push(`[${ref}] ${role}${name ? ` "${name}"` : ""}`);
  }
  const snapshotText = params.format === "ai" ? params.snapshot : compactLines.join("\n");
  const truncated = truncate(snapshotText, params.maxChars);
  SNAPSHOT_REFS.set(params.targetId, new Map(Object.entries(refs)));
  return {
    format: params.format,
    targetId: params.targetId,
    url: params.page.url(),
    snapshot: truncated.text,
    truncated: truncated.truncated,
    refs,
    nodes,
    stats: {
      nodeCount: nodes.length,
      textLength: params.snapshot.length,
      source: "snapshotForAI",
    },
    labels: false,
    labelsCount: nodes.length,
  };
}

type ScopedCandidate = {
  visible: boolean;
  area: number;
  containsActive?: boolean;
  controlCount?: number;
  headingCount?: number;
};

function selectBestScopedCandidateIndex(candidates: ScopedCandidate[]): number {
  let bestIndex = -1;
  let bestScore = -1;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate?.visible) {
      continue;
    }
    const controlCount = Math.max(0, Number(candidate.controlCount || 0));
    const headingCount = Math.max(0, Number(candidate.headingCount || 0));
    const area = Math.max(0, Number(candidate.area || 0));
    const compactness = Math.max(0, 2_000_000 - Math.min(area, 2_000_000));
    const score =
      (candidate.containsActive ? 1_000_000_000 : 0) +
      controlCount * 100_000 +
      headingCount * 5_000 +
      compactness;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

async function scopedLocatorForSnapshot(params: {
  page: Page;
  selector?: string;
  frame?: string;
}): Promise<Locator> {
  const scopedSelector = params.selector?.trim();
  const scopedFrame = params.frame?.trim();
  if (scopedFrame) {
    const locator = scopedSelector
      ? params.page.frameLocator(scopedFrame).locator(scopedSelector)
      : params.page.frameLocator(scopedFrame).locator(":root");
    if (!scopedSelector) {
      return locator;
    }
      const bestIndex = await locator.evaluateAll((elements) => {
        const active = document.activeElement;
        const countControls = (root) =>
          root.querySelectorAll(
            [
              "input[type='checkbox']",
              "input[type='radio']",
              "button",
              "select",
              "[role='checkbox']",
              "[role='radio']",
              "[role='switch']",
              "[role='button']",
              "[role='option']",
              "[role='listbox']",
            ].join(","),
          ).length;
        const countHeadings = (root) =>
          root.querySelectorAll(
            ["legend", "label", "h1", "h2", "h3", "h4", "h5", "h6", "[role='heading']"].join(","),
          ).length;
        let best = -1;
        let bestScore = -1;
        for (let index = 0; index < elements.length; index += 1) {
          const element = elements[index];
          if (!(element instanceof HTMLElement)) {
          continue;
        }
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const visible =
          rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        if (!visible) {
          continue;
          }
          const containsActive = Boolean(
            active && active instanceof Node && (element === active || element.contains(active)),
          );
          const area = rect.width * rect.height;
          const score =
            (containsActive ? 1_000_000_000 : 0) +
            countControls(element) * 100_000 +
            countHeadings(element) * 5_000 +
            Math.max(0, 2_000_000 - Math.min(area, 2_000_000));
          if (score > bestScore) {
            best = index;
            bestScore = score;
          }
        }
      return best;
    });
    return bestIndex >= 0 ? locator.nth(bestIndex) : locator.first();
  }
  if (!scopedSelector) {
    return params.page.locator(":root");
  }
  const locator = params.page.locator(scopedSelector);
  const candidates = (await locator.evaluateAll((elements) => {
    const active = document.activeElement;
    const countControls = (root) =>
      root.querySelectorAll(
        [
          "input[type='checkbox']",
          "input[type='radio']",
          "button",
          "select",
          "[role='checkbox']",
          "[role='radio']",
          "[role='switch']",
          "[role='button']",
          "[role='option']",
          "[role='listbox']",
        ].join(","),
      ).length;
    const countHeadings = (root) =>
      root.querySelectorAll(
        ["legend", "label", "h1", "h2", "h3", "h4", "h5", "h6", "[role='heading']"].join(","),
      ).length;
    return elements.map((element) => {
      if (!(element instanceof HTMLElement)) {
        return { visible: false, area: 0, containsActive: false, controlCount: 0, headingCount: 0 };
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const visible =
        rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      return {
        visible,
        area: rect.width * rect.height,
        controlCount: countControls(element),
        headingCount: countHeadings(element),
        containsActive: Boolean(
          active && active instanceof Node && (element === active || element.contains(active)),
        ),
      };
    });
  })) as ScopedCandidate[];
  const bestIndex = selectBestScopedCandidateIndex(candidates);
  return bestIndex >= 0 ? locator.nth(bestIndex) : locator.first();
}

async function collectSnapshot(params: {
  page: Page;
  selector?: string;
  frame?: string;
  snapshotFormat?: string;
  targetId: string;
  maxChars?: number;
  interactive?: boolean;
  compact?: boolean;
  refsMode?: "aria" | "role";
}): Promise<{
  format: "ai" | "aria" | "role";
  targetId: string;
  url: string;
  snapshot: string;
  truncated: boolean;
  refs: Record<string, SnapshotRefEntry>;
  nodes: Array<Record<string, unknown>>;
  stats: Record<string, unknown>;
  labels?: boolean;
  labelsCount?: number;
}> {
  const format =
    params.snapshotFormat === "aria" || params.snapshotFormat === "role" ? params.snapshotFormat : "ai";
  const scopedSelector = params.selector?.trim();
  const scopedRef = selectorRefToken(scopedSelector);
  const scopedFrame = params.frame?.trim();
  const useLocatorSnapshot = Boolean(scopedFrame || scopedRef || params.refsMode === "role");
  if (!scopedSelector && !scopedFrame && params.refsMode !== "role") {
    const pageWithAiSnapshot = params.page as SnapshotForAIPage;
    if (typeof pageWithAiSnapshot._snapshotForAI === "function") {
      const snapshotResult = await withOperationTimeout(
        pageWithAiSnapshot._snapshotForAI({
          timeout: SNAPSHOT_OPERATION_TIMEOUT_MS,
          track: "response",
        }),
        SNAPSHOT_OPERATION_TIMEOUT_MS + 250,
        "page ai snapshot timed out",
      );
      const maxChars =
        params.maxChars ??
        (format === "ai" ? DEFAULT_AI_SNAPSHOT_MAX_CHARS : DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS);
      return buildRefSnapshotFromAiText({
        snapshot: String(snapshotResult?.full || ""),
        format,
        maxChars,
        targetId: params.targetId,
        page: params.page,
      });
    }
  }
  if (useLocatorSnapshot) {
    const locator = await withOperationTimeout(
      (async () => {
        if (scopedRef) {
          const locatorCandidates = await locatorForRequest(params.page, params.targetId, {
            kind: "click",
            ref: scopedRef,
          });
          const resolvedLocator = await resolveLocatorCandidate(locatorCandidates, {
            requireVisible: false,
            timeoutMs: SNAPSHOT_OPERATION_TIMEOUT_MS,
          });
          if (!resolvedLocator) {
            throw new Error(`Scoped snapshot ref not found: ${scopedRef}`);
          }
          return resolvedLocator;
        }
        return await scopedLocatorForSnapshot({
          page: params.page,
          selector: scopedSelector,
          frame: scopedFrame,
        });
      })(),
      SNAPSHOT_OPERATION_TIMEOUT_MS,
      "snapshot locator resolution timed out",
    );
    const ariaSnapshot = String(
      (await withOperationTimeout(
        locator.ariaSnapshot().catch(() => ""),
        SNAPSHOT_OPERATION_TIMEOUT_MS,
        "aria snapshot timed out",
      )) || "",
    );
    const visibleText = String(
      (await withOperationTimeout(
        locator
          .evaluate((element) => {
            const node = element as HTMLElement;
            return node.innerText || node.textContent || "";
          })
          .catch(() => ""),
        SNAPSHOT_OPERATION_TIMEOUT_MS,
        "scoped snapshot text extraction timed out",
      )) || "",
    )
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const lines = ariaSnapshot
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const refs: Record<string, SnapshotRefEntry> = {};
    const nodes: Array<Record<string, unknown>> = [];
    for (const line of lines) {
      const match = /^-+\s*([a-zA-Z][\w-]*)(?:\s+"([^"]+)")?/.exec(line);
      if (!match) {
        continue;
      }
      const role = String(match[1] || "").trim().toLowerCase();
      const name = String(match[2] || "").trim();
      const ref = `e${nodes.length + 1}`;
      refs[ref] = { xpath: `synthetic:${ref}`, role, name };
      nodes.push({ ref, role, name, text: name });
    }
    const snapshotText =
      format === "ai"
        ? [visibleText, nodes.length ? "\n\nInteractive refs:\n" + nodes.map((node) => {
            const role = String(node.role || "").trim();
            const name = String(node.name || "").trim();
            return `[${String(node.ref || "")}] ${role}${name ? ` "${name}"` : ""}`;
          }).join("\n") : ""]
            .filter(Boolean)
            .join("")
        : nodes
            .map((node) => {
              const role = String(node.role || "").trim();
              const name = String(node.name || "").trim();
              return `[${String(node.ref || "")}] ${role}${name ? ` "${name}"` : ""}`;
            })
            .join("\n");
    const maxChars =
      params.maxChars ??
      (format === "ai" ? DEFAULT_AI_SNAPSHOT_MAX_CHARS : DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS);
    const truncated = truncate(snapshotText, maxChars);
    SNAPSHOT_REFS.set(params.targetId, new Map(Object.entries(refs)));
    return {
      format,
      targetId: params.targetId,
      url: params.page.url(),
      snapshot: truncated.text,
      truncated: truncated.truncated,
      refs,
      nodes,
      stats: {
        nodeCount: nodes.length,
        textLength: visibleText.length,
        scoped: true,
      },
      labels: false,
      labelsCount: nodes.length,
    };
  }
  const result = await withOperationTimeout(
    params.page.evaluate(
      ({ selector, format, interactive, compact }) => {
      const runner = new Function(
        "selector",
        "format",
        "interactive",
        "compact",
        `
          const isVisible = (candidate) => {
            if (!candidate) return false;
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          };
          const pickForegroundRoot = () => {
            const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            const activeSurface = active?.closest?.(
              [
                "[role='dialog']",
                "[aria-modal='true']",
                "dialog",
                "[data-overlay]",
                ".modal",
                "[class*='modal']",
                ".drawer",
                "[class*='drawer']",
                ".popup",
                "[class*='popup']",
              ].join(","),
            );
            if (activeSurface && isVisible(activeSurface)) {
              return activeSurface;
            }
            const activeForm = active?.closest?.("form");
            if (activeForm && isVisible(activeForm)) {
              return activeForm;
            }
            const candidates = Array.from(
              document.querySelectorAll(
                [
                  "[role='dialog']",
                  "[aria-modal='true']",
                  "dialog",
                  "[data-overlay]",
                  ".modal",
                  "[class*='modal']",
                  ".drawer",
                  "[class*='drawer']",
                  ".popup",
                  "[class*='popup']",
                ].join(","),
              ),
            )
              .filter((candidate) => candidate instanceof HTMLElement && isVisible(candidate))
              .sort((left, right) => {
                const leftRect = left.getBoundingClientRect();
                const rightRect = right.getBoundingClientRect();
                return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
              });
            return candidates[0] || null;
          };
          const pickSelectorRoot = (selectorValue) => {
            if (!selectorValue) return null;
            const candidates = Array.from(document.querySelectorAll(selectorValue))
              .filter((candidate) => candidate instanceof HTMLElement && isVisible(candidate));
            if (candidates.length === 0) {
              return null;
            }
            const focused = candidates.find((candidate) => candidate === document.activeElement || candidate.contains(document.activeElement));
            if (focused) return focused;
            candidates.sort((left, right) => {
              const leftRect = left.getBoundingClientRect();
              const rightRect = right.getBoundingClientRect();
              return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
            });
            return candidates[0] || null;
          };
          const selectorRoot = pickSelectorRoot(selector);
          if (selector && !selectorRoot) {
            return {
              lines: [],
              refs: {},
              nodes: [],
              text: "",
              scopedSelectorMiss: true,
            };
          }
          const root = selectorRoot || pickForegroundRoot() || document.body;
          if (!root) {
            return { lines: [], refs: {}, nodes: [], text: "" };
          }
          const interactiveSelector = [
            "button",
            "a[href]",
            "input",
            "textarea",
            "select",
            "[role]",
            "[contenteditable='true']",
            "[tabindex]",
          ].join(",");
          const candidateRoot = interactive === false ? root : root;
          const candidates = Array.from(candidateRoot.querySelectorAll(interactiveSelector));
          const elements = [];
          const limit = compact === false ? 240 : 120;
          for (const candidate of candidates) {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            if (
              rect.width <= 0 ||
              rect.height <= 0 ||
              style.visibility === "hidden" ||
              style.display === "none"
            ) {
              continue;
            }
            elements.push(candidate);
            if (elements.length >= limit) {
              break;
            }
          }
          const refs = {};
          const nodes = [];
          const lines = [];
          for (let index = 0; index < elements.length; index += 1) {
            const el = elements[index];
            const tagName = el.tagName.toLowerCase();
            const role =
              el.getAttribute("role") ||
              (tagName === "a" ? "link" : tagName === "input" ? "input" : tagName);
            const name =
              el.getAttribute("aria-label") ||
              el.placeholder ||
              el.value ||
              (el.textContent || "").replace(/\\s+/g, " ").trim();
            const normalizedRole = String(role || "").toLowerCase();
            const isEditable =
              tagName === "input" ||
              tagName === "textarea" ||
              tagName === "select" ||
              el.getAttribute("contenteditable") === "true" ||
              normalizedRole === "textbox" ||
              normalizedRole === "combobox";
            const isFocused = document.activeElement === el;
            if (normalizedRole === "presentation" || normalizedRole === "none") {
              continue;
            }
            if (!name && !isEditable && !isFocused) {
              continue;
            }
            const id = "e" + (nodes.length + 1);
            const segments = [];
            let current = el;
            while (current && current.nodeType === Node.ELEMENT_NODE) {
              const currentTag = current.tagName.toLowerCase();
              let siblingIndex = 1;
              let sibling = current.previousElementSibling;
              while (sibling) {
                if (sibling.tagName.toLowerCase() === currentTag) {
                  siblingIndex += 1;
                }
                sibling = sibling.previousElementSibling;
              }
              segments.unshift(currentTag + "[" + siblingIndex + "]");
              current = current.parentElement;
            }
            refs[id] = { xpath: "/" + segments.join("/"), role, name };
            nodes.push({ ref: id, role, name, text: name });
            lines.push("[" + id + "] " + role + (name ? ' "' + name + '"' : ""));
          }
          const text = (root.innerText || "").replace(/\\s+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
          return { lines, refs, nodes, text };
        `,
      ) as (selector?: string, format?: string) => {
        lines: string[];
        refs: Record<string, { xpath: string; role: string; name: string }>;
        nodes: Array<Record<string, unknown>>;
        text: string;
        scopedSelectorMiss?: boolean;
      };
        return runner(selector, format, interactive, compact);
      },
      { selector: params.selector, format, interactive: params.interactive !== false, compact: params.compact !== false },
    ),
    SNAPSHOT_OPERATION_TIMEOUT_MS,
    "page snapshot evaluation timed out",
  );

  if (scopedSelector && result.scopedSelectorMiss) {
    throw new Error(`Scoped snapshot selector not found: ${scopedSelector}`);
  }

  const maxChars = params.maxChars ?? (format === "ai" ? DEFAULT_AI_SNAPSHOT_MAX_CHARS : DEFAULT_AI_SNAPSHOT_EFFICIENT_MAX_CHARS);
  const snapshotText =
    format === "ai"
      ? [result.text, result.lines.length ? "\n\nInteractive refs:\n" + result.lines.join("\n") : ""]
          .filter(Boolean)
          .join("")
      : result.lines.join("\n");
  const truncated = truncate(snapshotText, maxChars);
  SNAPSHOT_REFS.set(params.targetId, new Map(Object.entries(result.refs)));
  return {
    format,
    targetId: params.targetId,
    url: params.page.url(),
    snapshot: truncated.text,
    truncated: truncated.truncated,
    refs: result.refs,
    nodes: result.nodes,
    stats: {
      nodeCount: result.nodes.length,
      textLength: result.text.length,
    },
    labels: false,
    labelsCount: result.nodes.length,
  };
}

function lookupRef(targetId: string, ref?: string): SnapshotRefEntry | undefined {
  const refs = SNAPSHOT_REFS.get(targetId);
  return ref ? refs?.get(ref) : undefined;
}

function supportsRoleLocator(role: string): boolean {
  return new Set([
    "alert",
    "button",
    "checkbox",
    "combobox",
    "dialog",
    "group",
    "link",
    "listbox",
    "main",
    "menuitem",
    "option",
    "radio",
    "region",
    "switch",
    "tab",
    "textbox",
    "toolbar",
  ]).has(role);
}

function looksLikeCssSelector(selector: string): boolean {
  const trimmed = selector.trim();
  if (!trimmed) {
    return false;
  }
  if (
    trimmed.startsWith("xpath=") ||
    trimmed.startsWith("css=") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith(".") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("[")
  ) {
    return true;
  }
  if (/[>~+:[\]#.=]/.test(trimmed)) {
    return true;
  }
  return new Set([
    "a",
    "button",
    "input",
    "textarea",
    "select",
    "option",
    "label",
    "form",
    "main",
    "section",
    "article",
    "header",
    "footer",
    "nav",
    "dialog",
  ]).has(trimmed.toLowerCase());
}

function semanticLocatorCandidates(page: Page, text: string): Locator[] {
  const roles: Array<Parameters<Page["getByRole"]>[0]> = [
    "button",
    "link",
    "tab",
    "option",
    "checkbox",
    "radio",
    "menuitem",
    "switch",
  ];
  const candidates: Locator[] = [];
  for (const role of roles) {
    candidates.push(page.getByRole(role, { name: text, exact: true }));
    candidates.push(page.getByRole(role, { name: text }));
  }
  candidates.push(page.getByLabel(text, { exact: true }));
  candidates.push(page.getByLabel(text));
  candidates.push(page.getByPlaceholder(text, { exact: true }));
  candidates.push(page.getByPlaceholder(text));
  candidates.push(page.getByText(text, { exact: true }));
  candidates.push(page.getByText(text));
  return candidates;
}

function entryMayBeEditable(entry: SnapshotRefEntry | undefined): boolean {
  if (!entry) {
    return false;
  }
  const role = String(entry.role || "").trim().toLowerCase();
  return (
    role === "input" ||
    role === "textbox" ||
    role === "textarea" ||
    role === "combobox" ||
    role === "searchbox"
  );
}

function editableDescendantCandidates(locator: Locator): Locator[] {
  return [
    locator.locator("input").first(),
    locator.locator("textarea").first(),
    locator.locator("[contenteditable='true']").first(),
    locator.locator("[role='textbox']").first(),
    locator.locator("[role='combobox']").first(),
  ];
}

function selectorRefToken(selector: string | undefined): string | undefined {
  const trimmed = typeof selector === "string" ? selector.trim() : "";
  if (!trimmed) {
    return undefined;
  }
  const directRef = /^@?(e\d+)$/i.exec(trimmed);
  if (directRef?.[1]) {
    return directRef[1];
  }
  const attrRef = /^\[ref=['"]?(e\d+)['"]?\]$/i.exec(trimmed);
  if (attrRef?.[1]) {
    return attrRef[1];
  }
  const namedRef = /^ref=['"]?(e\d+)['"]?$/i.exec(trimmed);
  if (namedRef?.[1]) {
    return namedRef[1];
  }
  return undefined;
}

async function locatorForRequest(page: Page, targetId: string, request: Record<string, unknown>) {
  const ref = typeof request.ref === "string" ? request.ref.trim() : undefined;
  const selector = typeof request.selector === "string" ? request.selector.trim() : undefined;
  const entry = lookupRef(targetId, ref);
  const candidates: Locator[] = [];
  const kind =
    typeof request.kind === "string"
      ? request.kind.trim().toLowerCase()
      : typeof request.action === "string"
        ? request.action.trim().toLowerCase()
        : "";
  const prefersEditableResolution = kind === "type" || kind === "fill";
  if (selector) {
    if (!looksLikeCssSelector(selector)) {
      candidates.push(...semanticLocatorCandidates(page, selector));
    }
    candidates.push(page.locator(selector));
  }
  if (entry?.name) {
    if (prefersEditableResolution && entryMayBeEditable(entry)) {
      candidates.push(page.getByRole("textbox", { name: entry.name, exact: true }));
      candidates.push(page.getByRole("textbox", { name: entry.name }));
      candidates.push(page.getByRole("combobox", { name: entry.name, exact: true }));
      candidates.push(page.getByRole("combobox", { name: entry.name }));
      candidates.push(page.getByRole("searchbox", { name: entry.name, exact: true }));
      candidates.push(page.getByRole("searchbox", { name: entry.name }));
    }
    if (entry.role === "input") {
      candidates.push(page.getByRole("textbox", { name: entry.name, exact: true }));
      candidates.push(page.getByRole("textbox", { name: entry.name }));
    }
    if (supportsRoleLocator(entry.role)) {
      candidates.push(
        page.getByRole(entry.role as Parameters<Page["getByRole"]>[0], {
          name: entry.name,
          exact: true,
        }),
      );
      candidates.push(
        page.getByRole(entry.role as Parameters<Page["getByRole"]>[0], {
          name: entry.name,
        }),
      );
    }
    candidates.push(page.getByLabel(entry.name, { exact: true }));
    candidates.push(page.getByLabel(entry.name));
    if (entry.role === "generic") {
      candidates.push(page.getByText(entry.name, { exact: true }));
      candidates.push(page.getByText(entry.name));
    }
    if (entry.role === "link") {
      candidates.push(page.getByText(entry.name, { exact: true }));
      candidates.push(page.getByText(entry.name));
    }
  }
  if (entry?.xpath && entry.xpath.startsWith("/")) {
    const xpathLocator = page.locator(`xpath=${entry.xpath}`);
    if (prefersEditableResolution) {
      candidates.push(...editableDescendantCandidates(xpathLocator));
    }
    candidates.push(xpathLocator);
  }
  return candidates.length > 0 ? candidates : null;
}

async function resolveLocatorCandidate(
  candidates: Locator[] | null,
  opts?: { requireVisible?: boolean; timeoutMs?: number },
): Promise<Locator | null> {
  if (!candidates?.length) {
    return null;
  }
  const timeoutMs = opts?.timeoutMs ?? 1_500;
  let fallback: Locator | null = null;
  for (const candidate of candidates) {
    const locator = candidate.first();
    try {
      await locator.waitFor({
        state: opts?.requireVisible === false ? "attached" : "visible",
        timeout: timeoutMs,
      });
      return locator;
    } catch {
      fallback ??= locator;
    }
  }
  return fallback;
}

async function locatorCandidateSequence(
  candidates: Locator[] | null,
): Promise<Locator[]> {
  if (!candidates?.length) {
    return [];
  }
  return candidates.map((candidate) => candidate.first());
}

async function clickLocator(locator: Locator, request: Record<string, unknown>) {
  const button = typeof request.button === "string" && request.button.trim() ? request.button : "left";
  const modifiers = Array.isArray(request.modifiers)
    ? request.modifiers.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const clickCount = request.doubleClick === true ? 2 : 1;
  await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
  await locator.click({
    button: button as "left" | "right" | "middle",
    clickCount,
    modifiers,
    timeout: 5_000,
  });
}

function boundingBoxClickPoint(box: { x: number; y: number; width: number; height: number }): {
  x: number;
  y: number;
} {
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

async function captureInteractionFallbackScreenshot(page: Page, targetId: string): Promise<string | undefined> {
  try {
    const dir = path.join(os.tmpdir(), "runtime-browser-fallback");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${slug(targetId)}-${Date.now()}.png`);
    await page.screenshot({ path: filePath });
    return filePath;
  } catch {
    return undefined;
  }
}

async function clickLocatorWithVisualFallback(
  page: Page,
  locator: Locator,
  targetId: string,
  request: Record<string, unknown>,
): Promise<{ screenshotPath?: string; fallbackUsed: boolean }> {
  const button = typeof request.button === "string" && request.button.trim() ? request.button : "left";
  const modifiers = Array.isArray(request.modifiers)
    ? request.modifiers.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const clickCount = request.doubleClick === true ? 2 : 1;
  await locator.scrollIntoViewIfNeeded({ timeout: 4_000 }).catch(() => undefined);
  try {
    await locator.click({
      button: button as "left" | "right" | "middle",
      clickCount,
      modifiers,
      timeout: 8_000,
    });
    return { fallbackUsed: false };
  } catch (error) {
    const screenshotPath = await captureInteractionFallbackScreenshot(page, targetId);
    const box = await locator.boundingBox().catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) {
      throw error;
    }
    const point = boundingBoxClickPoint(box);
    await page.mouse.move(point.x, point.y);
    await page.mouse.click(point.x, point.y, {
      button: button as "left" | "right" | "middle",
      clickCount,
      delay: request.doubleClick === true ? 40 : 20,
    });
    return { screenshotPath, fallbackUsed: true };
  }
}

export async function browserStatus(_baseUrl?: string, opts?: { profile?: string }) {
  const { browser, pages, resolvedProfile } = await connectForProfile(opts?.profile);
  try {
    return {
      ok: true,
      running: true,
      profile: resolvedProfile,
      pageCount: pages.length,
      pages: await Promise.all(pages.map((page) => pageSummary(page))),
    };
  } finally {
    await closeBrowserConnection(browser);
  }
}

export async function browserProfiles(_baseUrl?: string) {
  const cfg = loadBrowserConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  return Object.keys(resolved.profiles);
}

export async function browserTabs(_baseUrl?: string, opts?: { profile?: string }) {
  const { browser, pages } = await connectForProfile(opts?.profile);
  try {
    return await Promise.all(
      pages.map(async (page) => ({
        ...(await pageSummary(page)),
        active: true,
      })),
    );
  } finally {
    await closeBrowserConnection(browser);
  }
}

export async function browserOpenTab(_baseUrl: string | undefined, url: string, opts?: { profile?: string }) {
  const { browser, pages } = await connectForProfile(opts?.profile);
  try {
    const context = browser.contexts()[0]!;
    const reusableIndex = await bestReusablePageIndex(pages, url);
    if (reusableIndex >= 0) {
      const page = pages[reusableIndex]!;
      await page.bringToFront().catch(() => undefined);
      if (reusablePageScore(page.url(), url) < 120) {
        await page.goto(url, { waitUntil: "domcontentloaded" });
      }
      await resetPageViewport(page);
      return await pageSummary(page);
    }
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await resetPageViewport(page);
    return await pageSummary(page);
  } finally {
    await closeBrowserConnection(browser);
  }
}

export async function browserFocusTab(_baseUrl: string | undefined, targetId: string, opts?: { profile?: string }) {
  const resolved = await resolvePage({ profile: opts?.profile, targetId });
  try {
    await resolved.page.bringToFront();
    return { ok: true, targetId: resolved.targetId };
  } finally {
    await closeBrowserConnection(resolved.browser);
  }
}

export async function browserCloseTab(_baseUrl: string | undefined, targetId: string, opts?: { profile?: string }) {
  const resolved = await resolvePage({ profile: opts?.profile, targetId });
  try {
    await resolved.page.close();
    return { ok: true, targetId: resolved.targetId };
  } finally {
    await closeBrowserConnection(resolved.browser);
  }
}

export async function browserNavigate(
  _baseUrl: string | undefined,
  params: { targetId?: string; url: string },
  opts?: { profile?: string },
) {
  const resolved = await resolvePage({ profile: opts?.profile, targetId: params.targetId });
  try {
    try {
      await resolved.page.goto(params.url, { waitUntil: "domcontentloaded" });
      await resetPageViewport(resolved.page);
      return await pageSummary(resolved.page);
    } catch (error) {
      if (!isBlockedTopLevelNavigationError(error)) {
        throw error;
      }
      const context = resolved.page.context();
      const retryPage = await context.newPage();
      try {
        await retryPage.bringToFront().catch(() => undefined);
        await retryPage.goto(params.url, { waitUntil: "domcontentloaded" });
        await resetPageViewport(retryPage);
        return await pageSummary(retryPage);
      } catch (retryError) {
        await retryPage.close().catch(() => undefined);
        throw retryError;
      }
    }
  } finally {
    await closeBrowserConnection(resolved.browser);
  }
}

export const __testOnly = {
  bestReusablePageIndex,
  boundingBoxClickPoint,
  reusablePageScore,
  isBlockedTopLevelNavigationError,
  entryMayBeEditable,
  selectBestScopedCandidateIndex,
  selectorRefToken,
};

export async function browserSnapshot(
  _baseUrl: string | undefined,
  opts?: BrowserSnapshotOptions,
) {
  const resolved = await resolvePage({ profile: opts?.profile, targetId: opts?.targetId });
  const captureSnapshot = async (page: Page, targetId: string) =>
    await collectSnapshot({
      page,
      selector: opts?.selector,
      frame: opts?.frame,
      snapshotFormat: opts?.snapshotFormat,
      targetId,
      maxChars: opts?.maxChars,
      interactive: opts?.interactive,
      compact: opts?.compact,
      refsMode: opts?.refs,
    });
  try {
    await resolved.page.waitForLoadState("domcontentloaded", { timeout: 1_500 }).catch(() => undefined);
    await resolved.page.waitForLoadState("networkidle", { timeout: 750 }).catch(() => undefined);
    try {
      return await captureSnapshot(resolved.page, resolved.targetId);
    } catch (error) {
      const message = String(error || "").toLowerCase();
      if (
        message.includes("execution context was destroyed") ||
        message.includes("most likely because of a navigation") ||
        message.includes("frame was detached") ||
        message.includes("snapshot") && message.includes("timed out")
      ) {
        const retry = await resolvePage({ profile: opts?.profile, targetId: resolved.targetId }).catch(() => null);
        if (retry) {
          try {
            await retry.page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => undefined);
            await retry.page.waitForLoadState("networkidle", { timeout: 1_000 }).catch(() => undefined);
            return await captureSnapshot(retry.page, retry.targetId);
          } finally {
            await closeBrowserConnection(retry.browser);
          }
        }
        await resolved.page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => undefined);
        await resolved.page.waitForLoadState("networkidle", { timeout: 1_000 }).catch(() => undefined);
        return await captureSnapshot(resolved.page, resolved.targetId);
      }
      throw error;
    }
  } finally {
    await closeBrowserConnection(resolved.browser);
  }
}

export async function browserConsoleMessages(_baseUrl?: string, opts?: { profile?: string; targetId?: string; level?: string }) {
  const resolved = await resolvePage({ profile: opts?.profile, targetId: opts?.targetId });
  try {
    return {
      ok: true,
      targetId: resolved.targetId,
      messages: [],
    };
  } finally {
    await closeBrowserConnection(resolved.browser);
  }
}

export async function browserAct(
  _baseUrl: string | undefined,
  request: Record<string, unknown>,
  opts?: { profile?: string },
) {
  const targetId = typeof request.targetId === "string" ? request.targetId.trim() : undefined;
  const resolved = await resolvePage({ profile: opts?.profile, targetId });
  try {
    const kind = typeof request.kind === "string" ? request.kind.trim() : typeof request.action === "string" ? request.action.trim() : "";
    const locatorCandidates = await locatorForRequest(resolved.page, resolved.targetId, request);
    switch (kind) {
      case "click": {
        const locator = await resolveLocatorCandidate(locatorCandidates);
        if (!locator) throw new Error("click requires ref or selector");
        const clickResult = await clickLocatorWithVisualFallback(
          resolved.page,
          locator,
          resolved.targetId,
          request,
        );
        return {
          ok: true,
          targetId: resolved.targetId,
          fallbackUsed: clickResult.fallbackUsed,
          screenshotPath: clickResult.screenshotPath,
        };
      }
      case "hover": {
        const locator = await resolveLocatorCandidate(locatorCandidates);
        if (!locator) throw new Error("hover requires ref or selector");
        await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
        await locator.hover({ timeout: 5_000 });
        return { ok: true, targetId: resolved.targetId };
      }
      case "scrollIntoView": {
        const locator = await resolveLocatorCandidate(locatorCandidates, { requireVisible: false });
        if (!locator) throw new Error("scrollIntoView requires ref or selector");
        try {
          await locator.scrollIntoViewIfNeeded({ timeout: 8_000 });
          return { ok: true, targetId: resolved.targetId, fallbackUsed: false };
        } catch (error) {
          const screenshotPath = await captureInteractionFallbackScreenshot(resolved.page, resolved.targetId);
          const box = await locator.boundingBox().catch(() => null);
          if (!box || box.width <= 0 || box.height <= 0) {
            throw error;
          }
          const point = boundingBoxClickPoint(box);
          await resolved.page.mouse.move(point.x, point.y);
          await resolved.page.mouse.wheel(0, Math.max(200, Math.round(box.y)));
          return {
            ok: true,
            targetId: resolved.targetId,
            fallbackUsed: true,
            screenshotPath,
          };
        }
      }
      case "type": {
        const text = typeof request.text === "string" ? request.text : "";
        const slowly = request.slowly === true;
        const sequence = await locatorCandidateSequence(locatorCandidates);
        if (!sequence.length) throw new Error("type requires ref or selector");
        let lastError: unknown = null;
        let succeededLocator: Locator | null = null;
        for (const locator of sequence) {
          try {
            await locator.waitFor({ state: "visible", timeout: 1_500 });
            await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
            if (slowly) {
              await locator.click({ timeout: 5_000 });
              if (
                typeof (
                  locator as {
                    type?: (value: string, opts?: { timeout?: number; delay?: number }) => Promise<void>;
                  }
                ).type === "function"
              ) {
                await (
                  locator as {
                    type: (value: string, opts?: { timeout?: number; delay?: number }) => Promise<void>;
                  }
                ).type(text, { timeout: 5_000, delay: 75 });
              } else {
                await resolved.page.keyboard.type(text, { delay: 75 });
              }
            } else {
              try {
                await locator.fill(text, { timeout: 5_000 });
              } catch {
                await locator.click({ timeout: 5_000 });
                if (
                  typeof (
                    locator as {
                      type?: (value: string, opts?: { timeout?: number; delay?: number }) => Promise<void>;
                    }
                  ).type === "function"
                ) {
                  await (
                    locator as {
                      type: (value: string, opts?: { timeout?: number; delay?: number }) => Promise<void>;
                    }
                  ).type(text, { timeout: 5_000, delay: 20 });
                } else {
                  await resolved.page.keyboard.type(text, { delay: 20 });
                }
              }
            }
            succeededLocator = locator;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!succeededLocator) {
          throw lastError || new Error("type requires ref or selector");
        }
        if (request.submit) {
          await succeededLocator.press("Enter", { timeout: 5_000 });
        }
        return { ok: true, targetId: resolved.targetId };
      }
      case "fill": {
        const locator = await resolveLocatorCandidate(locatorCandidates);
        if (!locator) throw new Error("fill requires ref or selector");
        const text = typeof request.text === "string" ? request.text : "";
        await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
        await locator.fill(text, { timeout: 5_000 });
        if (request.submit) {
          await locator.press("Enter", { timeout: 5_000 });
        }
        return { ok: true, targetId: resolved.targetId };
      }
      case "press": {
        const locator = await resolveLocatorCandidate(locatorCandidates, { requireVisible: false });
        const key = normalizeKeyboardKey(request.key);
        if (locator) {
          await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
          await locator.press(key, { timeout: 5_000 });
        } else {
          await resolved.page.keyboard.press(key);
        }
        return { ok: true, targetId: resolved.targetId };
      }
      case "scroll": {
        const locator = await resolveLocatorCandidate(locatorCandidates, { requireVisible: false });
        const x = normalizeScrollCoordinate(request.x);
        const y = normalizeScrollCoordinate(request.y);
        const selector = typeof request.selector === "string" ? request.selector.trim() : "";
        if (selector === "document" || selector === "body" || (!locator && !selector)) {
          await resolved.page.evaluate(
            ([dx, dy]) => {
              const resolvedX = typeof dx === "number" ? dx : 0;
              if (dy === "page_end") {
                window.scrollTo({ left: resolvedX, top: document.body.scrollHeight });
                return;
              }
              if (dy === "page_start") {
                window.scrollTo({ left: resolvedX, top: 0 });
                return;
              }
              window.scrollBy(resolvedX, typeof dy === "number" ? dy : 0);
            },
            [x, y],
          );
          return { ok: true, targetId: resolved.targetId };
        }
        if (!locator) {
          throw new Error("scroll requires ref or selector");
        }
        await locator.evaluate(
          (element, coords) => {
            const node = element as HTMLElement;
            if (coords.y === "page_end") {
              node.scrollTop = node.scrollHeight;
              return;
            }
            if (coords.y === "page_start") {
              node.scrollTop = 0;
              return;
            }
            if (typeof node.scrollBy === "function") {
              node.scrollBy(
                typeof coords.x === "number" ? coords.x : 0,
                typeof coords.y === "number" ? coords.y : 0,
              );
              return;
            }
            node.scrollIntoView({ block: "center", inline: "nearest" });
          },
          { x, y },
        );
        return { ok: true, targetId: resolved.targetId };
      }
      case "select": {
        const locator = await resolveLocatorCandidate(locatorCandidates);
        if (!locator) throw new Error("select requires ref or selector");
        const values = Array.isArray(request.values) ? request.values.map(String) : [];
        await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
        await locator.selectOption(values, { timeout: 5_000 });
        return { ok: true, targetId: resolved.targetId };
      }
      case "wait": {
        const timeMs =
          typeof request.timeMs === "number" && Number.isFinite(request.timeMs) ? request.timeMs : 1000;
        await resolved.page.waitForTimeout(timeMs);
        return { ok: true, targetId: resolved.targetId };
      }
      case "evaluate": {
        const expression = compileEvaluateSource(request.fn);
        const value = await resolved.page.evaluate(expression);
        return { ok: true, targetId: resolved.targetId, value };
      }
      case "close":
        await resolved.page.close();
        return { ok: true, targetId: resolved.targetId };
      default:
        throw new Error(`Unsupported browser act kind "${kind}"`);
    }
  } finally {
    await closeBrowserConnection(resolved.browser);
  }
}

export async function browserScreenshotAction(
  _baseUrl: string | undefined,
  opts?: { profile?: string; targetId?: string; fullPage?: boolean; selector?: string },
) {
  const resolved = await resolvePage({ profile: opts?.profile, targetId: opts?.targetId });
  try {
    const dir = path.join(os.tmpdir(), "runtime-browser-shots");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${slug(resolved.targetId)}-${Date.now()}.png`);
    if (opts?.selector) {
      await resolved.page.locator(opts.selector).first().screenshot({ path: filePath });
    } else {
      await resolved.page.screenshot({ path: filePath, fullPage: opts?.fullPage === true });
    }
    return { ok: true, targetId: resolved.targetId, path: filePath, imagePath: filePath, imageType: "image/png" };
  } finally {
    await closeBrowserConnection(resolved.browser);
  }
}

export async function browserPdfSave(_baseUrl: string | undefined, opts?: { profile?: string; targetId?: string }) {
  const resolved = await resolvePage({ profile: opts?.profile, targetId: opts?.targetId });
  try {
    const dir = path.join(os.tmpdir(), "runtime-browser-pdf");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${slug(resolved.targetId)}-${Date.now()}.pdf`);
    await resolved.page.pdf({ path: filePath });
    return { ok: true, targetId: resolved.targetId, path: filePath };
  } finally {
    await closeBrowserConnection(resolved.browser);
  }
}

export async function browserStart() {
  return { ok: true };
}

export async function browserStop() {
  return { ok: true };
}

export async function browserArmFileChooser() {
  return { ok: true };
}

export async function browserArmDialog() {
  return { ok: true };
}

export async function persistBrowserProxyFiles(files?: Array<{ path: string; base64: string }>) {
  const mapping = new Map<string, string>();
  for (const file of files ?? []) {
    mapping.set(file.path, file.path);
  }
  return mapping;
}

export function applyBrowserProxyPaths(_result: unknown, _mapping: Map<string, string>) {}

export async function resolveExistingPathsWithinRoot(params: {
  rootDir: string;
  requestedPaths: string[];
  scopeLabel?: string;
}): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  const rootDir = path.resolve(params.rootDir);
  const allowedPaths: string[] = [];

  for (const requestedPath of params.requestedPaths) {
    const candidate = path.resolve(rootDir, requestedPath);
    const relative = path.relative(rootDir, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return {
        ok: false,
        error: `Path "${requestedPath}" is outside the allowed ${params.scopeLabel ?? "directory"}.`,
      };
    }
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) {
        return {
          ok: false,
          error: `Path "${requestedPath}" is not a file in ${params.scopeLabel ?? rootDir}.`,
        };
      }
    } catch {
      return {
        ok: false,
        error: `Path "${requestedPath}" was not found in ${params.scopeLabel ?? rootDir}.`,
      };
    }
    allowedPaths.push(candidate);
  }

  return { ok: true, paths: allowedPaths };
}

export function trackSessionBrowserTab(params: {
  sessionKey?: string;
  targetId: string;
  baseUrl?: string;
  profile?: string;
}) {
  if (!params.sessionKey) {
    return;
  }
  SESSION_TAB_TRACKER.set(params.sessionKey, {
    targetId: params.targetId,
    baseUrl: params.baseUrl,
    profile: params.profile,
  });
}

export function trackedSessionBrowserTab(params: {
  sessionKey?: string;
}): BrowserTabRef | null {
  if (!params.sessionKey) {
    return null;
  }
  return SESSION_TAB_TRACKER.get(params.sessionKey) ?? null;
}

export function untrackSessionBrowserTab(params: { sessionKey?: string; targetId?: string }) {
  if (!params.sessionKey) {
    return;
  }
  const current = SESSION_TAB_TRACKER.get(params.sessionKey);
  if (params.targetId && current?.targetId && current.targetId !== params.targetId) {
    return;
  }
  SESSION_TAB_TRACKER.delete(params.sessionKey);
}
