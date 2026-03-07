import type { ElementBox, LocateTargetResult, UiToolRuntime } from "./interfaces";

interface CoordsTarget {
  by: "coords";
  x: number;
  y: number;
}

interface DisambiguationSpec {
  max_matches?: number;
  must_be_visible?: boolean;
  must_be_enabled?: boolean;
  prefer_topmost?: boolean;
}

export function parseCoordsTarget(target: unknown): CoordsTarget | null {
  if (!target || typeof target !== "object") return null;
  const maybe = target as Record<string, unknown>;
  if (maybe.by !== "coords") return null;
  const x = Number(maybe.x);
  const y = Number(maybe.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { by: "coords", x, y };
}

export async function normalizeViewportPoint(
  runtime: UiToolRuntime,
  tabId: number,
  rawX: number,
  rawY: number,
): Promise<{ x: number; y: number }> {
  return await runtime.cdpEval(tabId, `
    (function() {
      const rawX = ${Math.round(rawX)};
      const rawY = ${Math.round(rawY)};
      const vw = Math.max(1, window.innerWidth || 1);
      const vh = Math.max(1, window.innerHeight || 1);
      let x = rawX;
      let y = rawY;

      if (y < 0 || y > vh - 1) {
        const top = Math.max(0, rawY - Math.floor(vh * 0.4));
        window.scrollTo({ top, behavior: "instant" });
        y = rawY - window.scrollY;
      }

      x = Math.max(1, Math.min(vw - 1, x));
      y = Math.max(1, Math.min(vh - 1, y));
      return { x: Math.round(x), y: Math.round(y) };
    })()
  `) as { x: number; y: number };
}

function buildFindScript(target: unknown): string {
  const serialized = JSON.stringify(target);
  return `
(function() {
  let parsed = ${serialized};
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch {}
  }
  const disambiguation = (parsed && typeof parsed === 'object' && parsed.disambiguation && typeof parsed.disambiguation === 'object')
    ? parsed.disambiguation
    : {};
  const maxMatches = Number.isFinite(Number(disambiguation.max_matches)) ? Math.max(1, Number(disambiguation.max_matches)) : 1;
  const mustBeVisible = disambiguation.must_be_visible !== false;
  const mustBeEnabled = disambiguation.must_be_enabled !== false;
  const preferTopmost = disambiguation.prefer_topmost !== false;

  function escSel(s) { return CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\"'); }
  function isSafeCss(selector) {
    if (!selector || typeof selector !== 'string') return false;
    const s = selector.trim();
    if (!s) return false;
    if (/\\s[>+~]|[>+~]|:nth-|\\./.test(s)) return false;
    if (/^#[A-Za-z0-9_-]+$/.test(s)) return true;
    if (/^\\[data-testid=["'][^"'\\]]+["']\\]$/.test(s)) return true;
    if (/^\\[aria-label=["'][^"'\\]]+["']\\]$/i.test(s)) return true;
    if (/^input\\[type=["']file["']\\]$/i.test(s)) return true;
    return false;
  }
  function isUsable(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (mustBeVisible && (rect.width <= 0 || rect.height <= 0)) return false;
    if (mustBeVisible) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
    }
    if (mustBeEnabled && !!el.closest('[disabled],[aria-disabled="true"]')) return false;
    return true;
  }
  function uniquePush(arr, el) { if (el && !arr.includes(el)) arr.push(el); }
  function labelControl(labelEl) {
    if (!labelEl) return null;
    if (labelEl.control) return labelEl.control;
    const htmlFor = labelEl.getAttribute('for');
    if (htmlFor) {
      const byFor = document.getElementById(htmlFor);
      if (byFor) return byFor;
    }
    return labelEl.querySelector('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"]');
  }
  function findByAssociatedLabelAll(text) {
    const out = [];
    if (!text || typeof text !== 'string') return out;
    const t = text.toLowerCase();
    const labels = document.querySelectorAll('label, [aria-label], [title]');
    for (const el of labels) {
      const labelText = (
        el.tagName === 'LABEL'
          ? (el.textContent || '')
          : (el.getAttribute('aria-label') || el.getAttribute('title') || '')
      ).trim().toLowerCase();
      if (!labelText) continue;
      if (labelText === t || labelText.includes(t)) {
        uniquePush(out, el.tagName === 'LABEL' ? labelControl(el) : el);
      }
    }
    return out;
  }
  function topmostOk(el) {
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    if (!hit) return false;
    return hit === el || el.contains(hit) || hit.contains(el);
  }

  function findByStringAll(s) {
    const out = [];
    if (!s || typeof s !== 'string') return out;
    try { document.querySelectorAll('[name="' + escSel(s) + '"]').forEach((e) => uniquePush(out, e)); } catch {}
    try { document.querySelectorAll('[aria-label="' + escSel(s) + '" i]').forEach((e) => uniquePush(out, e)); } catch {}
    try { document.querySelectorAll('[placeholder="' + escSel(s) + '" i]').forEach((e) => uniquePush(out, e)); } catch {}
    const byId = document.getElementById(s);
    uniquePush(out, byId);
    for (const e of findByAssociatedLabelAll(s)) uniquePush(out, e);
    for (const e of findByTextAll(s)) uniquePush(out, e);
    return out;
  }

  function findByTextAll(text) {
    const out = [];
    const t = text.toLowerCase();
    const candidates = document.querySelectorAll('button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], label');
    for (const el of candidates) {
      if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const al = (el.getAttribute('aria-label') || '').toLowerCase();
      const tx = (el.textContent || '').trim().toLowerCase();
      const ph = (el.getAttribute('placeholder') || '').toLowerCase();
      const tt = (el.getAttribute('title') || '').toLowerCase();
      if (al === t || tx === t || ph === t || tt === t) uniquePush(out, el);
      else if (al.includes(t) || ph.includes(t) || tt.includes(t)) uniquePush(out, el);
      else if (tx.includes(t) && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link')) uniquePush(out, el);
    }
    return out;
  }

  function findAll(p) {
    if (typeof p === 'string') return findByStringAll(p);
    if (!p || typeof p !== 'object') return [];

    if (p.by === 'coords' && typeof p.x === 'number') {
      const el = document.elementFromPoint(p.x, p.y);
      return el ? [el] : [];
    }
    if (p.by === 'name' && p.value) {
      return Array.from(document.querySelectorAll('[name="' + escSel(p.value) + '"]'));
    }
    if (p.by === 'testid' && p.value) {
      return [
        ...Array.from(document.querySelectorAll('[data-testid="' + escSel(p.value) + '"]')),
        ...Array.from(document.querySelectorAll('[data-test-id="' + escSel(p.value) + '"]')),
      ];
    }
    if (p.by === 'label' && p.value) {
      return [
        ...Array.from(document.querySelectorAll('[aria-label="' + escSel(p.value) + '" i]')),
        ...Array.from(document.querySelectorAll('[title="' + escSel(p.value) + '" i]')),
        ...findByAssociatedLabelAll(p.value),
      ];
    }
    if (p.by === 'placeholder' && p.value) {
      return Array.from(document.querySelectorAll('[placeholder="' + escSel(p.value) + '" i]'));
    }
    if (p.by === 'css' && p.value) {
      if (!isSafeCss(p.value)) return [];
      try { return Array.from(document.querySelectorAll(p.value)); } catch {}
      return [];
    }
    if (p.by === 'text' && p.value) return findByTextAll(p.value);

    if (p.by === 'role' && p.value) {
      const els = document.querySelectorAll('[role="' + p.value + '"]');
      const tagMap = { button: 'button', link: 'a', textbox: 'input,textarea', combobox: 'select', checkbox: 'input[type="checkbox"]', radio: 'input[type="radio"]' };
      const extra = tagMap[p.value] ? document.querySelectorAll(tagMap[p.value]) : [];
      const all = [...els, ...extra];
      if (p.name) {
        const n = p.name.toLowerCase();
        const named = [];
        for (const el of all) {
          const al = (el.getAttribute('aria-label') || '').toLowerCase();
          const tx = (el.textContent || '').trim().toLowerCase();
          const ph = (el.getAttribute('placeholder') || '').toLowerCase();
          if (al === n || al.includes(n) || tx === n || ph.includes(n)) uniquePush(named, el);
        }
        return named;
      }
      return all;
    }

    if (p.value) return findByStringAll(p.value);
    if (p.selector) return findByStringAll(p.selector);
    return [];
  }

  const candidatesRaw = findAll(parsed);
  const candidates = candidatesRaw.filter((el) => isUsable(el));
  if (!candidates.length) return { found: false, x: 0, y: 0, width: 0, height: 0, description: 'Not found: ' + JSON.stringify(parsed), matchCount: 0 };
  const preferred = preferTopmost ? candidates.filter((el) => topmostOk(el)) : candidates;
  const selectedPool = preferred.length > 0 ? preferred : candidates;
  if (selectedPool.length > maxMatches) {
    return { found: false, x: 0, y: 0, width: 0, height: 0, description: 'Ambiguous target: matched ' + selectedPool.length + ' elements (max ' + maxMatches + ')', matchCount: selectedPool.length };
  }
  const el = selectedPool[0];
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  const r = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent?.trim().substring(0, 40) || '';
  return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, description: '<' + tag + '> ' + label, matchCount: selectedPool.length };
})()
`;
}

export async function locateTarget(
  runtime: UiToolRuntime,
  tabId: number,
  target: unknown,
  disambiguation?: DisambiguationSpec,
): Promise<LocateTargetResult> {
  const coords = parseCoordsTarget(target);
  if (coords) {
    const pt = await normalizeViewportPoint(runtime, tabId, coords.x, coords.y);
    return { ok: true, reason: "coords", x: pt.x, y: pt.y };
  }
  const targetWithDisambiguation =
    target && typeof target === "object"
      ? ({ ...(target as Record<string, unknown>), disambiguation: disambiguation ?? (target as Record<string, unknown>).disambiguation } as unknown)
      : target;
  const box = (await runtime.cdpEval(tabId, buildFindScript(targetWithDisambiguation))) as ElementBox;
  if (!box?.found) {
    return { ok: false, reason: `Element not found: ${box?.description || "Not found"}` };
  }
  return {
    ok: true,
    reason: "located",
    box,
    x: Math.round(box.x),
    y: Math.round(box.y),
  };
}
