export function buildFindScript(target: unknown): string {
  const serialized = JSON.stringify(target);
  return `
(function() {
  let parsed = ${serialized};
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch {}
  }

  function escSel(s) { return CSS.escape ? CSS.escape(s) : s.replace(/"/g, '\\\\"'); }

  function isSafeCss(selector) {
    if (!selector || typeof selector !== "string") return false;
    const s = selector.trim();
    if (!s) return false;
    if (/\\s[>+~]|[>+~]|:nth-|\\./.test(s)) return false;
    if (/^#[A-Za-z0-9_-]+$/.test(s)) return true;
    if (/^\\[data-testid=["'][^"'\\]]+["']\\]$/.test(s)) return true;
    if (/^\\[aria-label=["'][^"'\\]]+["']\\]$/i.test(s)) return true;
    if (/^input\\[type=["']file["']\\]$/i.test(s)) return true;
    return false;
  }

  function findByString(s) {
    if (!s || typeof s !== 'string') return null;
    try { const e = document.querySelector('[name="' + escSel(s) + '"]'); if (e) return e; } catch {}
    try { const e = document.querySelector('[aria-label="' + escSel(s) + '" i]'); if (e) return e; } catch {}
    try { const e = document.querySelector('[placeholder="' + escSel(s) + '" i]'); if (e) return e; } catch {}
    const labels = document.querySelectorAll('label');
    for (const label of labels) {
      const text = (label.textContent || '').trim().toLowerCase();
      if (!text) continue;
      if (text === s.toLowerCase() || text.includes(s.toLowerCase())) {
        const control = label.control
          || (label.getAttribute('for') ? document.getElementById(label.getAttribute('for')) : null)
          || label.querySelector('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"]');
        if (control) return control;
      }
    }
    const byId = document.getElementById(s);
    if (byId) return byId;
    return findByText(s);
  }

  function findByText(text) {
    const t = text.toLowerCase();
    const candidates = document.querySelectorAll('button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], label');
    let best = null;
    let bestLen = Infinity;
    for (const el of candidates) {
      if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const al = (el.getAttribute('aria-label') || '').toLowerCase();
      const tx = (el.textContent || '').trim().toLowerCase();
      const ph = (el.getAttribute('placeholder') || '').toLowerCase();
      const tt = (el.getAttribute('title') || '').toLowerCase();
      if (al === t || tx === t || ph === t || tt === t) {
        if (tx.length < bestLen) { best = el; bestLen = tx.length; }
      }
      if (!best && (al.includes(t) || ph.includes(t) || tt.includes(t))) return el;
      if (!best && tx.includes(t) && (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link'))
        return el;
    }
    return best;
  }

  function find(p) {
    if (typeof p === 'string') return findByString(p);
    if (!p || typeof p !== 'object') return null;

    if (p.by === 'coords' && typeof p.x === 'number') return document.elementFromPoint(p.x, p.y);

    if (p.by === 'name' && p.value) {
      return document.querySelector('[name="' + escSel(p.value) + '"]') || document.getElementById(p.value);
    }

    if (p.by === 'testid' && p.value) {
      return (
        document.querySelector('[data-testid="' + escSel(p.value) + '"]') ||
        document.querySelector('[data-test-id="' + escSel(p.value) + '"]')
      );
    }

    if (p.by === 'label' && p.value) {
      const direct = document.querySelector('[aria-label="' + escSel(p.value) + '" i]') ||
        document.querySelector('[title="' + escSel(p.value) + '" i]');
      if (direct) return direct;
      return findByString(p.value);
    }

    if (p.by === 'placeholder' && p.value) {
      return document.querySelector('[placeholder="' + escSel(p.value) + '" i]');
    }

    if (p.by === 'css' && p.value) {
      if (!isSafeCss(p.value)) return null;
      try { return document.querySelector(p.value); } catch {}
      return null;
    }

    if (p.by === 'text' && p.value) return findByText(p.value) || findByString(p.value);

    if (p.by === 'role' && p.value) {
      const els = document.querySelectorAll('[role="' + p.value + '"]');
      const tagMap = { button: 'button', link: 'a', textbox: 'input,textarea', combobox: 'select', checkbox: 'input[type="checkbox"]', radio: 'input[type="radio"]' };
      const extra = tagMap[p.value] ? document.querySelectorAll(tagMap[p.value]) : [];
      const all = [...els, ...extra];
      if (p.name) {
        const n = p.name.toLowerCase();
        for (const el of all) {
          const al = (el.getAttribute('aria-label') || '').toLowerCase();
          const tx = (el.textContent || '').trim().toLowerCase();
          const ph = (el.getAttribute('placeholder') || '').toLowerCase();
          if (al === n || al.includes(n) || tx === n || ph.includes(n)) return el;
        }
      }
      for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return el;
      }
      return null;
    }

    if (p.value) return findByString(p.value);
    if (p.selector) return findByString(p.selector);
    return null;
  }

  const el = find(parsed);
  if (!el) return { found: false, x: 0, y: 0, width: 0, height: 0, description: 'Not found: ' + JSON.stringify(parsed) };
  el.scrollIntoView({ behavior: 'instant', block: 'center' });
  const r = el.getBoundingClientRect();
  const tag = el.tagName.toLowerCase();
  const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent?.trim().substring(0, 40) || '';
  return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, description: '<' + tag + '> ' + label };
})()
`;
}

export function buildUiBlockerScanScript(targetPoint?: { x: number; y: number }): string {
  const tx = targetPoint ? Math.round(targetPoint.x) : null;
  const ty = targetPoint ? Math.round(targetPoint.y) : null;
  return `
    (function() {
      function isVisible(el) {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        return true;
      }
      function centerOf(el, label) {
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: label || "" };
      }
      function textOf(el) {
        return (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "").trim().toLowerCase();
      }

      const captchaIframes = Array.from(document.querySelectorAll("iframe[src]"))
        .filter((el) => {
          const src = (el.getAttribute("src") || "").toLowerCase();
          return src.includes("recaptcha") || src.includes("hcaptcha") || src.includes("arkoselabs") || src.includes("turnstile");
        });
      const captchaNodes = Array.from(document.querySelectorAll('[id*="captcha" i], [class*="captcha" i], [name*="captcha" i]'));
      if (captchaIframes.length > 0 || captchaNodes.length > 0) {
        return { blockerClass: "security_gate", reason: "security-verification", closePoints: [], backdropPoint: null, targetCovered: false, hitTag: "" };
      }

      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog, .modal, [class*="modal"], .popup, [class*="popup"]')).filter(isVisible);
      const overlays = Array.from(document.querySelectorAll('.overlay, .backdrop, [class*="overlay"], [class*="backdrop"], [class*="scrim"], [data-testid*="modal"]')).filter(isVisible);
      const loading = Array.from(document.querySelectorAll('[aria-busy="true"], [role="progressbar"], .spinner, [class*="loading"], [class*="skeleton"]')).filter(isVisible);
      const closeCandidates = Array.from(document.querySelectorAll('button, [role="button"], a, [aria-label]'))
        .filter(isVisible)
        .map((el) => ({ el, text: textOf(el) }))
        .filter((row) => !!row.text)
        .slice(0, 200);

      const cookieNodes = Array.from(document.querySelectorAll(
        '[id*="cookie" i], [class*="cookie" i], [data-testid*="cookie" i], [id*="consent" i], [class*="consent" i], [data-testid*="consent" i], [aria-modal="true"][data-consent], [role="dialog"][data-consent]'
      )).filter(isVisible);
      const tourNodes = Array.from(document.querySelectorAll(
        '[id*="tour" i], [class*="tour" i], [data-testid*="tour" i], [id*="onboard" i], [class*="onboard" i], [data-testid*="onboard" i], [data-tour], [data-onboarding], [data-walkthrough]'
      )).filter(isVisible);

      let targetCovered = false;
      let hitTag = "";
      if (${tx === null ? "false" : "true"}) {
        const hit = document.elementFromPoint(${tx ?? 0}, ${ty ?? 0});
        if (hit) {
          hitTag = (hit.tagName || "").toLowerCase();
          const hitStyle = getComputedStyle(hit);
          const isLikelyCover = hitStyle.pointerEvents !== "none" && (hitStyle.position === "fixed" || hitStyle.position === "sticky" || hit.closest('[role="dialog"], [aria-modal="true"], .overlay, .backdrop, [class*="overlay"], [class*="modal"]'));
          if (isLikelyCover) targetCovered = true;
        }
      }

      const closeKeywords = ["close", "dismiss", "skip", "got it", "not now", "later", "cancel", "no thanks", "continue", "ok", "understand", "accept", "reject", "deny"];
      const closePoints = closeCandidates
        .filter((row) => closeKeywords.some((k) => row.text.includes(k)))
        .slice(0, 12)
        .map((row) => centerOf(row.el, row.text));

      let backdropPoint = null;
      const biggestOverlay = [...dialogs, ...overlays]
        .map((el) => ({ el, area: el.getBoundingClientRect().width * el.getBoundingClientRect().height }))
        .sort((a, b) => b.area - a.area)[0];
      if (biggestOverlay) backdropPoint = centerOf(biggestOverlay.el, "backdrop");

      const hasCookie = cookieNodes.length > 0;
      const hasTour = tourNodes.length > 0;
      const topSurfaceIsCookie = hasCookie && (
        (dialogs.length > 0 && cookieNodes.some((n) => dialogs.some((d) => d === n || d.contains(n) || n.contains(d)))) ||
        (overlays.length > 0 && cookieNodes.some((n) => overlays.some((o) => o === n || o.contains(n) || n.contains(o))))
      );
      const topSurfaceIsTour = hasTour && (
        (dialogs.length > 0 && tourNodes.some((n) => dialogs.some((d) => d === n || d.contains(n) || n.contains(d)))) ||
        (overlays.length > 0 && tourNodes.some((n) => overlays.some((o) => o === n || o.contains(n) || n.contains(o))))
      );

      if (loading.length > 0) {
        return { blockerClass: "loading_mask", reason: "loading-visible", closePoints, backdropPoint, targetCovered, hitTag };
      }
      if (dialogs.length > 0) {
        return { blockerClass: topSurfaceIsCookie ? "cookie_banner" : topSurfaceIsTour ? "onboarding_tour" : "modal_dialog", reason: "dialog-visible", closePoints, backdropPoint, targetCovered, hitTag };
      }
      if (targetCovered && overlays.length > 0) {
        return { blockerClass: "popover_menu", reason: "target-covered-by-overlay", closePoints, backdropPoint, targetCovered, hitTag };
      }
      if (targetCovered) {
        return { blockerClass: "click_intercept", reason: "target-covered", closePoints, backdropPoint, targetCovered, hitTag };
      }
      if (overlays.length > 0) {
        return { blockerClass: topSurfaceIsCookie ? "cookie_banner" : topSurfaceIsTour ? "onboarding_tour" : "unknown_overlay", reason: "overlay-visible", closePoints, backdropPoint, targetCovered, hitTag };
      }
      return { blockerClass: "none", reason: "clear", closePoints: [], backdropPoint: null, targetCovered: false, hitTag: "" };
    })()
  `;
}

export function buildFindByRoleScript(role: string, name: string, nth = 0): string {
  return `
(function() {
  const ROLE = ${JSON.stringify(role)};
  const NAME = ${JSON.stringify(name)};
  const NTH = ${Number.isFinite(nth) ? Math.max(0, Math.floor(nth)) : 0};

  const roleTagMap = {
    button: 'button,[role="button"]',
    link: 'a,[role="link"]',
    textbox: 'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]),textarea,[role="textbox"],[contenteditable="true"]',
    searchbox: 'input[type="search"],[role="searchbox"]',
    combobox: 'select,[role="combobox"]',
    checkbox: 'input[type="checkbox"],[role="checkbox"]',
    radio: 'input[type="radio"],[role="radio"]',
    tab: '[role="tab"]',
    menuitem: '[role="menuitem"]',
    option: 'option,[role="option"]',
    heading: 'h1,h2,h3,h4,h5,h6,[role="heading"]',
    img: 'img,[role="img"]',
    navigation: 'nav,[role="navigation"]',
    search: '[role="search"]',
    dialog: 'dialog,[role="dialog"],[role="alertdialog"]',
    slider: 'input[type="range"],[role="slider"]',
    switch: '[role="switch"]',
  };

  function getAccessibleName(el) {
    return el.getAttribute('aria-label')
      || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent?.trim()
      || el.getAttribute('placeholder')
      || el.getAttribute('title')
      || el.getAttribute('alt')
      || (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
        ? (el.labels?.[0]?.textContent?.trim() || '')
        : el.textContent?.trim().substring(0, 100))
      || '';
  }

  const selector = roleTagMap[ROLE] || ('[role="' + ROLE + '"]');
  const candidates = Array.from(document.querySelectorAll(selector));
  const visible = candidates.filter((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
    return true;
  });

  const matches = [];
  for (const el of visible) {
    const accName = getAccessibleName(el) || '';
    if (!NAME) {
      matches.push(el);
      continue;
    }
    const loweredAccName = accName.toLowerCase();
    const loweredNeedle = NAME.toLowerCase();
    if (accName === NAME || loweredAccName === loweredNeedle || loweredAccName.includes(loweredNeedle)) {
      matches.push(el);
    }
  }

  const chosen = matches[NTH] || null;
  if (chosen) {
    chosen.scrollIntoView({ behavior: 'instant', block: 'center' });
    const r = chosen.getBoundingClientRect();
    const acc = getAccessibleName(chosen);
    return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, description: '<' + chosen.tagName.toLowerCase() + '> ' + String(acc || '').substring(0, 40) };
  }

  return { found: false, x: 0, y: 0, width: 0, height: 0, description: 'Not found: ' + ROLE + ' "' + NAME + '" [nth=' + NTH + ']' };
})()
`;
}
