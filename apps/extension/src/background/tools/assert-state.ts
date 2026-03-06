import type { StateAssertionInput, StateAssertionResult, UiToolRuntime } from "./interfaces";

export async function assertState(
  runtime: UiToolRuntime,
  tabId: number,
  expected: StateAssertionInput,
): Promise<StateAssertionResult> {
  const raw = (await runtime.cdpEval(
    tabId,
    `(() => ({ url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 12000) }))()`,
  )) as { url?: string; title?: string; text?: string };

  const url = String(raw?.url || "").toLowerCase();
  const title = String(raw?.title || "").toLowerCase();
  const text = String(raw?.text || "").toLowerCase();

  const urlOk = !(expected.expectedUrlContains?.length)
    || expected.expectedUrlContains.some((m) => url.includes(m.toLowerCase()));
  const titleOk = !(expected.expectedTitleContains?.length)
    || expected.expectedTitleContains.some((m) => title.includes(m.toLowerCase()));
  const markersOk = !(expected.requiredMarkers?.length)
    || expected.requiredMarkers.every((m) => text.includes(m.toLowerCase()));

  return {
    ok: urlOk && titleOk && markersOk,
    evidence: `url_ok=${urlOk} title_ok=${titleOk} markers_ok=${markersOk}`,
  };
}
