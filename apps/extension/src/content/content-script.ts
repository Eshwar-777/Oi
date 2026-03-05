/**
 * Content script injected into web pages.
 *
 * Handles DOM automation commands from the background service worker:
 * click, type, scroll, hover, wait, select, keyboard, read_dom,
 * extract_structured, and highlight.
 *
 * Supports multiple targeting strategies:
 * - CSS selector: "button.submit"
 * - Text match:   {"by": "text", "value": "Add to Cart"}
 * - Role/ARIA:    {"by": "role", "value": "button", "name": "Submit"}
 * - Coordinates:  {"by": "coords", "x": 100, "y": 200}
 */

chrome.runtime.onMessage.addListener(
  (message: Record<string, unknown>, _sender, sendResponse) => {
    const action = message.action as string;

    (async () => {
      try {
        switch (action) {
          case "click":
            handleClick(message);
            break;
          case "type":
            handleType(message);
            break;
          case "scroll":
            handleScroll(message);
            break;
          case "hover":
            handleHover(message);
            break;
          case "wait":
            await handleWait(message);
            break;
          case "select":
            handleSelect(message);
            break;
          case "keyboard":
            handleKeyboard(message);
            break;
          case "read_dom":
            handleReadDom(message);
            break;
          case "extract_structured":
            handleExtractStructured();
            break;
          case "highlight":
            handleHighlight(message);
            break;
          default:
            reportResult("error", `Unknown action: ${action}`);
        }
      } catch (err) {
        reportResult("error", `${action} failed: ${err}`);
      }
    })();

    sendResponse({ received: true });
    return true;
  },
);

// ---------------------------------------------------------------------------
// Element resolution — supports CSS, text, role, and coordinate targeting
// ---------------------------------------------------------------------------

interface TargetSpec {
  by?: "text" | "role" | "css" | "coords";
  value?: string;
  name?: string;
  x?: number;
  y?: number;
}

function resolveTarget(raw: unknown): TargetSpec {
  if (typeof raw === "string") {
    return { by: "css", value: raw };
  }
  if (raw && typeof raw === "object") {
    return raw as TargetSpec;
  }
  return { by: "css", value: "" };
}

function findElement(spec: TargetSpec): HTMLElement | null {
  if (spec.by === "coords" && spec.x !== undefined && spec.y !== undefined) {
    return document.elementFromPoint(spec.x, spec.y) as HTMLElement | null;
  }

  if (spec.by === "name" && spec.value) {
    const el = document.querySelector(`[name="${spec.value}"]`) as HTMLElement | null;
    if (el) return el;
    const byId = document.getElementById(spec.value);
    if (byId) return byId;
    return null;
  }

  if (spec.by === "text" && spec.value) {
    const text = spec.value.toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node: Node | null = walker.nextNode();
    while (node) {
      const el = node as HTMLElement;
      const elText = el.textContent?.trim().toLowerCase() ?? "";
      const ariaLabel = el.getAttribute("aria-label")?.toLowerCase() ?? "";
      if (
        elText === text ||
        ariaLabel === text ||
        ariaLabel.includes(text) ||
        ((el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button") && elText.includes(text))
      ) {
        if (el.offsetParent !== null || el.tagName === "BODY") {
          return el;
        }
      }
      node = walker.nextNode();
    }
    return null;
  }

  if (spec.by === "role" && spec.value) {
    const elements = document.querySelectorAll(`[role="${spec.value}"]`);
    if (spec.name) {
      const name = spec.name.toLowerCase();
      for (const el of elements) {
        const ariaLabel = el.getAttribute("aria-label")?.toLowerCase() ?? "";
        const elText = el.textContent?.trim().toLowerCase() ?? "";
        const placeholder = el.getAttribute("placeholder")?.toLowerCase() ?? "";
        if (ariaLabel.includes(name) || elText === name || placeholder.includes(name)) {
          return el as HTMLElement;
        }
      }
    }
    return elements[0] as HTMLElement | null;
  }

  if (spec.value) {
    try {
      const el = document.querySelector(spec.value) as HTMLElement | null;
      if (el) return el;
    } catch { /* invalid selector */ }

    const byAria = document.querySelector(`[aria-label="${spec.value}" i]`) as HTMLElement | null;
    if (byAria) return byAria;

    const byName = document.querySelector(`[name="${spec.value}"]`) as HTMLElement | null;
    if (byName) return byName;

    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

function simulateClick(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const shared: MouseEventInit = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
  el.dispatchEvent(new PointerEvent("pointerdown", { ...shared, pointerId: 1 }));
  el.dispatchEvent(new MouseEvent("mousedown", shared));
  el.dispatchEvent(new PointerEvent("pointerup", { ...shared, pointerId: 1 }));
  el.dispatchEvent(new MouseEvent("mouseup", shared));
  el.dispatchEvent(new MouseEvent("click", shared));
}

function handleClick(msg: Record<string, unknown>): void {
  const spec = resolveTarget(msg.selector ?? msg.target);
  const el = findElement(spec);
  if (!el) {
    reportResult("error", `Element not found: ${JSON.stringify(spec)}`);
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  flashHighlight(el);
  simulateClick(el);
  reportResult("done", `Clicked: ${describeElement(el)}`);
}

function handleType(msg: Record<string, unknown>): void {
  const spec = resolveTarget(msg.selector ?? msg.target);
  const value = (msg.value as string) ?? "";
  const el = findElement(spec);
  if (!el) {
    reportResult("error", `Input not found: ${JSON.stringify(spec)}`);
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  flashHighlight(el);
  el.focus();

  const isContentEditable = el.isContentEditable || el.getAttribute("contenteditable") === "true";
  const isInput = el.tagName === "INPUT" || el.tagName === "TEXTAREA";

  if (isContentEditable) {
    if (!msg.append) {
      el.textContent = "";
    }
    document.execCommand("insertText", false, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (isInput) {
    const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
    if (msg.append) {
      inputEl.value += value;
    } else {
      inputEl.value = value;
    }
    const nativeSet = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(inputEl), "value",
    )?.set;
    if (nativeSet) {
      nativeSet.call(inputEl, inputEl.value);
    }
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    el.textContent = msg.append ? (el.textContent ?? "") + value : value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  reportResult("done", `Typed into: ${describeElement(el)}`);
}

function handleScroll(msg: Record<string, unknown>): void {
  const spec = resolveTarget(msg.selector ?? msg.target);
  if (spec.value) {
    const el = findElement(spec);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      reportResult("done", `Scrolled to: ${describeElement(el)}`);
      return;
    }
  }
  const dy = (msg.y as number) ?? 300;
  const dx = (msg.x as number) ?? 0;
  window.scrollBy({ left: dx, top: dy, behavior: "smooth" });
  reportResult("done", `Scrolled by (${dx}, ${dy})`);
}

function handleHover(msg: Record<string, unknown>): void {
  const spec = resolveTarget(msg.selector ?? msg.target);
  const el = findElement(spec);
  if (!el) {
    reportResult("error", `Element not found: ${JSON.stringify(spec)}`);
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  flashHighlight(el);
  reportResult("done", `Hovered: ${describeElement(el)}`);
}

async function handleWait(msg: Record<string, unknown>): Promise<void> {
  const rawTarget = msg.selector ?? msg.target;
  const hasTarget = rawTarget && typeof rawTarget === "string" && rawTarget.length > 0;
  const spec = hasTarget ? resolveTarget(rawTarget) : { by: undefined, value: undefined };
  const timeoutMs = ((msg.timeout as number) ?? 10) * 1000;
  const interval = 500;
  const start = Date.now();

  if (!hasTarget || (!spec.value && !spec.by)) {
    const ms = (msg.value as number) ?? (msg.ms as number) ?? 2000;
    await sleep(ms);
    reportResult("done", `Waited ${ms}ms`);
    return;
  }

  while (Date.now() - start < timeoutMs) {
    const el = findElement(spec);
    if (el && el.offsetParent !== null) {
      reportResult("done", `Found: ${describeElement(el)} after ${Date.now() - start}ms`);
      return;
    }
    await sleep(interval);
  }

  reportResult("error", `Timeout waiting for: ${JSON.stringify(spec)} after ${timeoutMs}ms`);
}

function handleSelect(msg: Record<string, unknown>): void {
  const spec = resolveTarget(msg.selector ?? msg.target);
  const el = findElement(spec) as HTMLSelectElement | null;
  if (!el || el.tagName !== "SELECT") {
    reportResult("error", `Select element not found: ${JSON.stringify(spec)}`);
    return;
  }
  const value = (msg.value as string) ?? "";
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  flashHighlight(el);
  reportResult("done", `Selected "${value}" in: ${describeElement(el)}`);
}

function handleKeyboard(msg: Record<string, unknown>): void {
  const key = (msg.key as string) ?? (msg.value as string) ?? "";
  const target = document.activeElement ?? document.body;

  const opts: KeyboardEventInit = {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    ctrlKey: !!(msg.ctrl),
    shiftKey: !!(msg.shift),
    altKey: !!(msg.alt),
    metaKey: !!(msg.meta),
  };

  target.dispatchEvent(new KeyboardEvent("keydown", opts));
  target.dispatchEvent(new KeyboardEvent("keypress", opts));
  target.dispatchEvent(new KeyboardEvent("keyup", opts));
  reportResult("done", `Key pressed: ${key}`);
}

function handleReadDom(msg: Record<string, unknown>): void {
  const spec = resolveTarget(msg.selector ?? msg.target);
  const el = spec.value ? findElement(spec) : document.body;
  if (!el) {
    reportResult("error", `Element not found: ${JSON.stringify(spec)}`);
    return;
  }
  const text = el.textContent?.substring(0, 5000) ?? "";
  reportResult("done", text);
}

function handleExtractStructured(): void {
  const elements: Record<string, unknown>[] = [];
  const interactable = document.querySelectorAll(
    "a, button, input, select, textarea, [role='button'], [role='link'], [role='textbox'], [role='combobox'], [onclick]"
  );

  interactable.forEach((el, idx) => {
    if (idx > 200) return;
    const htmlEl = el as HTMLElement;
    if (htmlEl.offsetParent === null && htmlEl.tagName !== "BODY") return;

    const rect = htmlEl.getBoundingClientRect();
    elements.push({
      tag: htmlEl.tagName.toLowerCase(),
      role: htmlEl.getAttribute("role") ?? "",
      type: (htmlEl as HTMLInputElement).type ?? "",
      text: htmlEl.textContent?.trim().substring(0, 100) ?? "",
      ariaLabel: htmlEl.getAttribute("aria-label") ?? "",
      placeholder: htmlEl.getAttribute("placeholder") ?? "",
      href: (htmlEl as HTMLAnchorElement).href ?? "",
      name: htmlEl.getAttribute("name") ?? "",
      id: htmlEl.id ?? "",
      className: htmlEl.className?.toString().substring(0, 80) ?? "",
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      visible: rect.width > 0 && rect.height > 0,
    });
  });

  reportResult("done", JSON.stringify({
    url: window.location.href,
    title: document.title,
    elements,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scrollY: window.scrollY,
  }));
}

function handleHighlight(msg: Record<string, unknown>): void {
  const spec = resolveTarget(msg.selector ?? msg.target);
  const el = findElement(spec);
  if (!el) {
    reportResult("error", `Element not found: ${JSON.stringify(spec)}`);
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  flashHighlight(el, 2000);
  reportResult("done", `Highlighted: ${describeElement(el)}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flashHighlight(el: HTMLElement, duration = 800): void {
  const prev = el.style.outline;
  const prevTransition = el.style.transition;
  el.style.transition = "outline 0.15s ease";
  el.style.outline = "3px solid #4285f4";
  setTimeout(() => {
    el.style.outline = prev;
    el.style.transition = prevTransition;
  }, duration);
}

function describeElement(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  const text = el.textContent?.trim().substring(0, 40) ?? "";
  const id = el.id ? `#${el.id}` : "";
  return `<${tag}${id}>${text}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function reportResult(status: string, data: string): void {
  chrome.runtime.sendMessage({
    source: "oi-content-script",
    payload: { status, data, url: window.location.href, timestamp: new Date().toISOString() },
  });
}
