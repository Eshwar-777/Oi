/**
 * Content script injected into web pages.
 *
 * Receives commands from the background service worker to interact
 * with the page DOM (click elements, type into inputs, read text).
 */

chrome.runtime.onMessage.addListener(
  (message: Record<string, string>, _sender, sendResponse) => {
    const action = message.action;
    const selector = message.selector ?? "";
    const value = message.value ?? "";

    switch (action) {
      case "click":
        handleClick(selector);
        break;
      case "type":
        handleType(selector, value);
        break;
      case "read_dom":
        handleReadDom(selector);
        break;
      default:
        reportResult("error", `Unknown action: ${action}`);
    }

    sendResponse({ received: true });
    return true;
  },
);

function handleClick(selector: string): void {
  try {
    const element = document.querySelector(selector) as HTMLElement | null;
    if (!element) {
      reportResult("error", `Element not found: ${selector}`);
      return;
    }
    element.click();
    reportResult("done", `Clicked: ${selector}`);
  } catch (error) {
    reportResult("error", `Click failed: ${error}`);
  }
}

function handleType(selector: string, value: string): void {
  try {
    const element = document.querySelector(selector) as HTMLInputElement | null;
    if (!element) {
      reportResult("error", `Input not found: ${selector}`);
      return;
    }
    element.focus();
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    reportResult("done", `Typed into: ${selector}`);
  } catch (error) {
    reportResult("error", `Type failed: ${error}`);
  }
}

function handleReadDom(selector: string): void {
  try {
    const element = selector
      ? document.querySelector(selector)
      : document.body;

    if (!element) {
      reportResult("error", `Element not found: ${selector}`);
      return;
    }

    const text = element.textContent?.substring(0, 5000) ?? "";
    reportResult("done", text);
  } catch (error) {
    reportResult("error", `Read failed: ${error}`);
  }
}

function reportResult(status: string, data: string): void {
  chrome.runtime.sendMessage({
    source: "oi-content-script",
    payload: { status, data },
  });
}
