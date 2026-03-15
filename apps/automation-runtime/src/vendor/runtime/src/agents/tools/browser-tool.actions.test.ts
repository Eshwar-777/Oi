import assert from "node:assert/strict";
import test from "node:test";
import { executeActAction, executeSnapshotAction } from "./browser-tool.actions.js";

test("selector-only click is rejected before browser mutation executes", async () => {
  let executed = false;
  const result = await executeActAction({
    request: {
      kind: "click",
      selector: "button",
    },
    proxyRequest: async () => {
      executed = true;
      return { ok: true };
    },
  });

  assert.equal(executed, false);
  assert.deepEqual(result.details, {
    ok: false,
    recoverable: true,
    requiresObservation: true,
    reason:
      "Mutating browser actions must use a ref from the latest interactive snapshot. Capture a fresh focused foreground snapshot and retry with a concrete ref instead of a selector or generic page target.",
    snapshotRequest: {
      interactive: true,
      compact: true,
      refs: "aria",
      selector:
        "[aria-modal='true'], [role='dialog'], dialog, form, [role='main'], main, [role='list'], [role='grid'], [role='table'], [role='listbox']",
      ambiguous: false,
    },
    retryGuidance:
      "Capture a fresh scoped interactive snapshot of the active surface and continue only from concrete refs produced by that observation.",
    retryContract: {
      requiresScopedObservation: true,
      refOnly: true,
      disallowGenericPageActionsUntilRefs: true,
    },
    invalidRequest: {
      kind: "click",
      missing: ["ref"],
    },
  });
});

test("ref-based click still reaches browser execution", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "ref-click-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-0",
      url: "https://example.com",
      snapshot: '- button "Continue" [ref=e11]',
      refs: {
        e11: { role: "button", name: "Continue" },
      },
    }),
  });

  let executed = false;
  const result = await executeActAction({
    request: {
      kind: "click",
      ref: "e11",
    },
    profile: "ref-click-test",
    proxyRequest: async () => {
      executed = true;
      return { ok: true, clicked: true };
    },
  });

  assert.equal(executed, true);
  assert.deepEqual(result.details, {
    ok: true,
    clicked: true,
  });
});

test("ref-based actions inherit the latest snapshot target id when omitted", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "grounded-target-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-compose",
      url: "https://example.com/compose",
      snapshot: '- combobox "To recipients" [ref=e5]',
      refs: {
        e5: { role: "combobox", name: "To recipients" },
      },
    }),
  });

  let capturedBody: Record<string, unknown> | null = null;
  const result = await executeActAction({
    request: {
      kind: "type",
      ref: "e5",
      text: "demo@example.com",
    },
    profile: "grounded-target-test",
    proxyRequest: async ({ body }) => {
      capturedBody = (body ?? null) as Record<string, unknown> | null;
      return { ok: true, typed: true };
    },
  });

  assert.deepEqual(capturedBody, {
    kind: "type",
    ref: "e5",
    text: "demo@example.com",
    targetId: "page-compose",
  });
  assert.deepEqual(result.details, {
    ok: true,
    typed: true,
  });
});

test("container ref click is rejected before browser mutation executes", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "container-click-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-4",
      url: "https://example.com/results",
      snapshot: '- main "Results" [ref=e40]\n- button "Add" [ref=e41]',
      refs: {
        e40: { role: "main", name: "Results" },
        e41: { role: "button", name: "Add" },
      },
    }),
  });

  let executed = false;
  const result = await executeActAction({
    request: {
      kind: "click",
      ref: "e40",
      targetId: "page-4",
    },
    profile: "container-click-test",
    proxyRequest: async () => {
      executed = true;
      return { ok: true };
    },
  });

  assert.equal(executed, false);
  assert.deepEqual(result.details, {
    ok: false,
    recoverable: true,
    requiresObservation: true,
    reason:
      "The chosen ref points to a structural container rather than a concrete interactive target. Capture a fresh scoped snapshot and choose the specific button, link, option, or field inside that surface.",
    snapshotRequest: {
      interactive: true,
      compact: true,
      refs: "aria",
      selector:
        "[aria-modal='true'], [role='dialog'], dialog, form, [role='main'], main, [role='list'], [role='grid'], [role='table'], [role='listbox']",
      ambiguous: false,
    },
    retryGuidance:
      "Capture a fresh scoped interactive snapshot of the active surface and continue only from concrete refs produced by that observation.",
    retryContract: {
      requiresScopedObservation: true,
      refOnly: true,
      disallowGenericPageActionsUntilRefs: true,
    },
    invalidRequest: {
      kind: "click",
      missing: ["ref"],
    },
  });
});

test("non-clickable heading ref click is rejected before browser mutation executes", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "heading-click-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-4",
      url: "https://example.com/results",
      snapshot: '- heading "Fastening" [ref=e149]\n- checkbox "Lace-Up" [ref=e150]',
      refs: {
        e149: { role: "heading", name: "Fastening" },
        e150: { role: "checkbox", name: "Lace-Up" },
      },
    }),
  });

  let executed = false;
  const result = await executeActAction({
    request: {
      kind: "click",
      ref: "e149",
      targetId: "page-4",
    },
    profile: "heading-click-test",
    proxyRequest: async () => {
      executed = true;
      return { ok: true };
    },
  });

  assert.equal(executed, false);
  assert.equal(result.details.ok, false);
  assert.equal(result.details.recoverable, true);
  assert.equal(result.details.requiresObservation, true);
  assert.match(String(result.details.reason || ""), /not a clickable target in the latest snapshot/i);
  assert.deepEqual(result.details.invalidRequest, {
    kind: "click",
    missing: ["ref"],
  });
});

test("text entry ref must point to an editable control from the latest snapshot", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "editable-ref-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-5",
      url: "https://example.com/form",
      snapshot: '- group "Shipping details" [ref=e50]\n- textbox "Email" [ref=e51]',
      refs: {
        e50: { role: "group", name: "Shipping details" },
        e51: { role: "textbox", name: "Email" },
      },
    }),
  });

  let executed = false;
  const result = await executeActAction({
    request: {
      kind: "type",
      ref: "e50",
      text: "demo@example.com",
      targetId: "page-5",
    },
    profile: "editable-ref-test",
    proxyRequest: async () => {
      executed = true;
      return { ok: true };
    },
  });

  assert.equal(executed, false);
  assert.equal(result.details.ok, false);
  assert.equal(result.details.recoverable, true);
  assert.equal(result.details.requiresObservation, true);
  assert.match(
    String(result.details.reason || ""),
    /Use one of the visible named editable refs from the latest snapshot, for example: e51 "Email"/i,
  );
  assert.deepEqual(result.details.snapshotRequest, {
    interactive: true,
    compact: true,
    refs: "aria",
    selector:
      "[aria-modal='true']:has(:focus), [role='dialog']:has(:focus), dialog:has(:focus), form:has(:focus), [contenteditable='true']:focus, textarea:focus, input:focus, [role='textbox']:focus, [role='combobox']:focus",
    ambiguous: false,
  });
  assert.equal(
    result.details.retryGuidance,
    "Capture a fresh focused foreground snapshot and continue only from the actual editable control refs produced by that observation.",
  );
  assert.deepEqual(result.details.retryContract, {
    requiresFocusedForegroundSnapshot: true,
    refOnly: true,
    disallowGenericPageActionsUntilRefs: true,
  });
  assert.deepEqual(result.details.invalidRequest, {
    kind: "type",
    missing: ["ref"],
  });
});

test("fill is rejected on a ref-rich multi-editable form surface", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "fill-rich-form-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-form",
      url: "https://example.com/form",
      snapshot:
        '- textbox "Email" [ref=e51]\n- textbox "Subject" [ref=e52]\n- textbox "Details" [ref=e53]',
      refs: {
        e51: { role: "textbox", name: "Email" },
        e52: { role: "textbox", name: "Subject" },
        e53: { role: "textbox", name: "Details" },
      },
    }),
  });

  let executed = false;
  const result = await executeActAction({
    request: {
      kind: "fill",
      targetId: "page-form",
      fields: [{ ref: "e51", value: "a@example.com" }],
    },
    profile: "fill-rich-form-test",
    proxyRequest: async () => {
      executed = true;
      return { ok: true };
    },
  });

  assert.equal(executed, false);
  assert.match(
    String((result.details as Record<string, unknown>).reason || ""),
    /use concrete type or select actions/i,
  );
});

test("single-target fill is rejected on a ref-rich multi-editable form surface", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "single-fill-rich-form",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-13",
      url: "https://example.com/compose",
      snapshot:
        '- textbox "To" [ref=e21]\n- textbox "Subject" [ref=e22]\n- textbox "Body" [ref=e23]',
      refs: {
        e21: { role: "textbox", name: "To" },
        e22: { role: "textbox", name: "Subject" },
        e23: { role: "textbox", name: "Body" },
      },
    }),
  });

  const result = await executeActAction({
    request: {
      kind: "fill",
      ref: "@e21",
      text: "ada@example.com",
    },
    profile: "single-fill-rich-form",
    proxyRequest: async () => ({ ok: true }),
  });

  assert.equal(result.details?.ok, false);
  assert.match(
    String((result.details as Record<string, unknown>)?.reason || ""),
    /Do not use generic fill/i,
  );
});

test("multi-field fill without concrete field refs is rejected", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "fill-missing-refs",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-13b",
      url: "https://example.com/compose",
      snapshot:
        '- region "Compose" [ref=e1]\n- textbox "To recipients" [ref=e21]\n- textbox "Subject" [ref=e22]\n- textbox "Body" [ref=e23]',
      refs: {
        e1: { role: "region", name: "Compose" },
        e21: { role: "textbox", name: "To recipients" },
        e22: { role: "textbox", name: "Subject" },
        e23: { role: "textbox", name: "Body" },
      },
    }),
  });

  const result = await executeActAction({
    request: {
      kind: "fill",
      fields: [{ name: "To recipients", value: "ada@example.com" }],
      targetId: "page-13b",
    },
    profile: "fill-missing-refs",
    proxyRequest: async () => ({ ok: true }),
  });

  assert.equal(result.details?.ok, false);
  assert.match(
    String((result.details as Record<string, unknown>)?.reason || ""),
    /do not use fill on this surface/i,
  );
});

test("auxiliary link clicks are rejected on a rich editable foreground surface", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "rich-editable-click-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-14",
      url: "https://example.com/compose",
      snapshot:
        '- region "New Message" [ref=e1]\n- link "To - Select contacts" [ref=e3]\n- combobox "To recipients" [ref=e5]\n- input "Subject" [ref=e8]\n- textbox "Message Body" [ref=e9]',
      refs: {
        e1: { role: "region", name: "New Message" },
        e3: { role: "link", name: "To - Select contacts" },
        e5: { role: "combobox", name: "To recipients" },
        e8: { role: "textbox", name: "Subject" },
        e9: { role: "textbox", name: "Message Body" },
      },
    }),
  });

  const result = await executeActAction({
    request: {
      kind: "click",
      ref: "@e3",
      targetId: "page-14",
    },
    profile: "rich-editable-click-test",
    proxyRequest: async () => ({ ok: true }),
  });

  assert.equal(result.details?.ok, false);
  assert.match(
    String((result.details as Record<string, unknown>)?.reason || ""),
    /multiple editable fields/i,
  );
});

test("selector-only click is rejected when the latest snapshot already has refs", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "selector-rich-ref-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-14b",
      url: "https://example.com/compose",
      snapshot:
        '- region "New Message" [ref=e1]\n- combobox "To recipients" [ref=e5]\n- input "Subject" [ref=e8]\n- textbox "Message Body" [ref=e9]',
      refs: {
        e1: { role: "region", name: "New Message" },
        e5: { role: "combobox", name: "To recipients" },
        e8: { role: "textbox", name: "Subject" },
        e9: { role: "textbox", name: "Message Body" },
      },
    }),
  });

  const result = await executeActAction({
    request: {
      kind: "click",
      selector: "[role='button']",
      targetId: "page-14b",
    },
    profile: "selector-rich-ref-test",
    proxyRequest: async () => ({ ok: true }),
  });

  assert.equal(result.details?.ok, false);
  assert.match(
    String((result.details as Record<string, unknown>)?.reason || ""),
    /concrete ref instead of a selector or generic page target/i,
  );
});

test("typing into weak helper fields is rejected when better named editable peers exist", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "helper-field-reject",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-15",
      url: "https://example.com/compose",
      snapshot:
        '- region "New Message" [ref=e1]\n- searchbox "Search field" [ref=e4]\n- combobox "To recipients" [ref=e5]\n- textbox "Subject" [ref=e8]\n- textbox "Message Body" [ref=e9]',
      refs: {
        e1: { role: "region", name: "New Message" },
        e4: { role: "searchbox", name: "Search field" },
        e5: { role: "combobox", name: "To recipients" },
        e8: { role: "textbox", name: "Subject" },
        e9: { role: "textbox", name: "Message Body" },
      },
    }),
  });

  const result = await executeActAction({
    request: {
      kind: "type",
      ref: "@e4",
      text: "ada@example.com",
      targetId: "page-15",
    },
    profile: "helper-field-reject",
    proxyRequest: async () => ({ ok: true }),
  });

  assert.equal(result.details?.ok, false);
  assert.match(
    String((result.details as Record<string, unknown>)?.reason || ""),
    /better-labeled editable fields/i,
  );
});

test("named destination editable fields are not rejected as weak helper fields", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "destination-field-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-compose",
      url: "https://example.com/compose",
      snapshot:
        '- searchbox "Search field" [ref=e4]\n- combobox "To recipients" [ref=e5]\n- textbox "Message Body" [ref=e9]',
      refs: {
        e4: { role: "searchbox", name: "Search field" },
        e5: { role: "combobox", name: "To recipients" },
        e9: { role: "textbox", name: "Message Body" },
      },
    }),
  });

  let executed = false;
  const result = await executeActAction({
    request: {
      kind: "type",
      ref: "e5",
      text: "demo@example.com",
    },
    profile: "destination-field-test",
    proxyRequest: async () => {
      executed = true;
      return { ok: true, typed: true };
    },
  });

  assert.equal(executed, true);
  assert.deepEqual(result.details, {
    ok: true,
    typed: true,
  });
});

test("subject input fields are treated as editable controls", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "subject-input-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-compose-3",
      url: "https://example.com/compose",
      snapshot:
        '- combobox "To recipients" [ref=e5]\n- input "Subject" [ref=e8]\n- textbox "Message Body" [ref=e9]',
      refs: {
        e5: { role: "combobox", name: "To recipients" },
        e8: { role: "input", name: "Subject" },
        e9: { role: "textbox", name: "Message Body" },
      },
    }),
  });

  let executed = false;
  const result = await executeActAction({
    request: {
      kind: "type",
      ref: "e8",
      text: "hi",
      targetId: "page-compose-3",
    },
    profile: "subject-input-test",
    proxyRequest: async () => {
      executed = true;
      return { ok: true, typed: true };
    },
  });

  assert.equal(executed, true);
  assert.deepEqual(result.details, {
    ok: true,
    typed: true,
  });
});

test("repeating the same text entry into the same live field is rejected", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "repeat-type-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-repeat",
      url: "https://example.com/form",
      snapshot: '- textbox "Email" [ref=e51]\n- textbox "Subject" [ref=e52]',
      refs: {
        e51: { role: "textbox", name: "Email" },
        e52: { role: "textbox", name: "Subject" },
      },
    }),
  });

  let executed = 0;
  const request = {
    kind: "type",
    ref: "e51",
    text: "a@example.com",
    targetId: "page-repeat",
  } as const;

  const first = await executeActAction({
    request,
    profile: "repeat-type-test",
    proxyRequest: async () => {
      executed += 1;
      return { ok: true };
    },
  });
  assert.equal((first.details as Record<string, unknown>).ok, true);

  const second = await executeActAction({
    request,
    profile: "repeat-type-test",
    proxyRequest: async () => {
      executed += 1;
      return { ok: true };
    },
  });

  assert.equal(executed, 1);
  assert.match(
    String((second.details as Record<string, unknown>).reason || ""),
    /same text entry was just attempted/i,
  );
});

test("generic page scroll is rejected when the latest snapshot already has actionable refs", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "scroll-grounding-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-1",
      url: "https://example.com/product",
      snapshot: '- button "Add to Cart" [ref=e11]',
      refs: {
        e11: { role: "button", name: "Add to Cart" },
      },
    }),
  });

  let executed = false;
  const result = await executeActAction({
    request: {
      kind: "scroll",
      y: "pageEnd",
      targetId: "page-1",
    },
    profile: "scroll-grounding-test",
    proxyRequest: async () => {
      executed = true;
      return { ok: true };
    },
  });

  assert.equal(executed, false);
  assert.deepEqual(result.details, {
    ok: false,
    recoverable: true,
    requiresObservation: true,
    reason:
      "When the latest snapshot already exposes actionable refs, do not use a generic page-level scroll. Choose a concrete ref-backed target from the latest snapshot or capture a fresh observation if the target is no longer visible.",
    snapshotRequest: {
      interactive: true,
      compact: true,
      refs: "aria",
      selector:
        "[aria-modal='true'], [role='dialog'], dialog, form, [role='main'], main, [role='list'], [role='grid'], [role='table'], [role='listbox']",
      ambiguous: false,
    },
    retryGuidance:
      "Capture a fresh scoped interactive snapshot of the active surface and continue only from concrete refs produced by that observation.",
    retryContract: {
      requiresScopedObservation: true,
      refOnly: true,
      disallowGenericPageActionsUntilRefs: true,
    },
    invalidRequest: {
      kind: "scroll",
      missing: ["ref"],
    },
  });
});

test("ref-based scroll is rejected in favor of scrollIntoView", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "scroll-ref-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-scroll-ref",
      url: "https://example.com/results",
      snapshot: '- button "Size 9" [ref=e71]',
      refs: {
        e71: { role: "button", name: "Size 9" },
      },
    }),
  });

  let executed = false;
  const result = await executeActAction({
    request: {
      kind: "scroll",
      ref: "e71",
      y: 500,
      targetId: "page-scroll-ref",
    },
    profile: "scroll-ref-test",
    proxyRequest: async () => {
      executed = true;
      return { ok: true };
    },
  });

  assert.equal(executed, false);
  assert.equal((result.details as Record<string, unknown>).ok, false);
  assert.match(
    String((result.details as Record<string, unknown>).reason || ""),
    /scrollIntoView on a concrete ref/i,
  );
  assert.deepEqual((result.details as Record<string, unknown>).invalidRequest, {
    kind: "scroll",
    missing: ["kind"],
  });
});

test("scrollIntoView requires a grounded ref from the latest snapshot", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "scroll-into-view-grounding-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-scroll-into-view",
      url: "https://example.com/results",
      snapshot: '- button "Size 9" [ref=e71]',
      refs: {
        e71: { role: "button", name: "Size 9" },
      },
    }),
  });

  let executed = false;
  const result = await executeActAction({
    request: {
      kind: "scrollIntoView",
      ref: "e999",
      targetId: "page-scroll-into-view",
    },
    profile: "scroll-into-view-grounding-test",
    proxyRequest: async () => {
      executed = true;
      return { ok: true };
    },
  });

  assert.equal(executed, false);
  assert.equal((result.details as Record<string, unknown>).ok, false);
  assert.match(
    String((result.details as Record<string, unknown>).reason || ""),
    /not grounded in the latest interactive snapshot/i,
  );
});

test("generic page scroll on a catalog surface fails fast with a scoped snapshot contract", async () => {
  const queries: Array<Record<string, unknown>> = [];
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "catalog-auto-scroll-recovery-test",
    proxyRequest: async ({ query }) => {
      queries.push({ ...(query || {}) });
      return {
        format: "ai",
        targetId: "page-catalog-auto",
        url: "https://example.com/shoes",
        snapshot:
          '- button "Size 9" [ref=e71]\n- button "4 Stars & Above" [ref=e72]\n- link "Black Running Shoe" [ref=e73]',
        refs: {
          e71: { role: "button", name: "Size 9" },
          e72: { role: "button", name: "4 Stars & Above" },
          e73: { role: "link", name: "Black Running Shoe" },
        },
      };
    },
  });

  const result = await executeActAction({
    request: {
      kind: "scroll",
      y: "pageEnd",
      targetId: "page-catalog-auto",
    },
    profile: "catalog-auto-scroll-recovery-test",
    proxyRequest: async ({ path, query }) => {
      if (path === "/snapshot") {
        queries.push({ ...(query || {}) });
      }
      throw new Error(`unexpected proxy path: ${path}`);
    },
  });

  assert.ok(queries.length >= 1);
  assert.equal((result.details as Record<string, unknown>).ok, false);
  assert.equal((result.details as Record<string, unknown>).recoverable, true);
  assert.match(
    String((result.details as Record<string, unknown>).reason || ""),
    /do not use a generic page-level scroll/i,
  );
  assert.deepEqual((result.details as Record<string, unknown>).snapshotRequest, {
    snapshotFormat: "aria",
    interactive: true,
    compact: true,
    refs: "aria",
    selector:
      "[aria-modal='true'], [role='dialog'], dialog, aside, [role='complementary'], [role='search'], form, [role='main'], main, [role='list'], [role='grid'], [role='table'], [role='listbox'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter']",
    ambiguous: false,
  });
});

test("text-only click is rejected when the latest snapshot already has actionable refs", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "text-only-click-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-6",
      url: "https://example.com/results",
      snapshot:
        '- button "Filters" [ref=e61]\n- link "Maroon shirt" [ref=e62]\n- link "Blue shirt" [ref=e63]',
      refs: {
        e61: { role: "button", name: "Filters" },
        e62: { role: "link", name: "Maroon shirt" },
        e63: { role: "link", name: "Blue shirt" },
      },
    }),
  });

  let executed = false;
  const result = await executeActAction({
    request: {
      kind: "click",
      text: "+ 44 more",
      targetId: "page-6",
    } as never,
    profile: "text-only-click-test",
    proxyRequest: async () => {
      executed = true;
      return { ok: true };
    },
  });

  assert.equal(executed, false);
  assert.deepEqual(result.details, {
    ok: false,
    recoverable: true,
    requiresObservation: true,
    reason:
      "The latest interactive snapshot already exposes actionable refs for this surface. Do not use a text-only, targetId-only, or generic page-level browser action here. Capture a fresh focused snapshot if needed and continue only with a concrete ref from that observation.",
    snapshotRequest: {
      snapshotFormat: "aria",
      interactive: true,
      compact: true,
      refs: "aria",
      selector:
        "[aria-modal='true'], [role='dialog'], dialog, aside, [role='complementary'], [role='search'], form, [role='main'], main, [role='list'], [role='grid'], [role='table'], [role='listbox'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter']",
      ambiguous: false,
    },
    retryGuidance:
      "Capture a fresh interactive snapshot of the filter rail, sidebar, complementary region, or results container. If the desired control is off-screen, use scrollIntoView on a concrete ref from that new observation instead of a generic page scroll.",
    retryContract: {
      requiresScopedObservation: true,
      refOnly: true,
      preferScrollIntoView: true,
      disallowGenericPageActionsUntilRefs: true,
    },
    invalidRequest: {
      kind: "click",
      missing: ["ref"],
    },
  });
});

test("catalog-surface text-only click recovery scopes observation to filter and results regions", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "catalog-text-only-click-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-catalog",
      url: "https://example.com/shoes",
      snapshot:
        '- button "Size 9" [ref=e71]\n- button "4 Stars & Above" [ref=e72]\n- link "Black Running Shoe" [ref=e73]',
      refs: {
        e71: { role: "button", name: "Size 9" },
        e72: { role: "button", name: "4 Stars & Above" },
        e73: { role: "link", name: "Black Running Shoe" },
      },
    }),
  });

  const result = await executeActAction({
    request: {
      kind: "click",
      text: "size 9",
      targetId: "page-catalog",
    } as never,
    profile: "catalog-text-only-click-test",
    proxyRequest: async () => ({ ok: true }),
  });

  assert.equal((result.details as Record<string, unknown>).ok, false);
  assert.deepEqual((result.details as Record<string, unknown>).snapshotRequest, {
    snapshotFormat: "aria",
    interactive: true,
    compact: true,
    refs: "aria",
    selector:
      "[aria-modal='true'], [role='dialog'], dialog, aside, [role='complementary'], [role='search'], form, [role='main'], main, [role='list'], [role='grid'], [role='table'], [role='listbox'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter']",
    ambiguous: false,
  });
  assert.match(
    String((result.details as Record<string, unknown>).retryGuidance || ""),
    /scrollIntoView on a concrete ref/i,
  );
  assert.deepEqual((result.details as Record<string, unknown>).retryContract, {
    requiresScopedObservation: true,
    refOnly: true,
    preferScrollIntoView: true,
    disallowGenericPageActionsUntilRefs: true,
  });
});

test("generic catalog scroll auto-recovers with a scoped snapshot when filter refs can be grounded", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "catalog-scroll-auto-recover",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-catalog-auto",
      url: "https://example.com/catalog",
      snapshot:
        '- input "Search products" [ref=e1]\n- link "Product 1" [ref=e2]\n- link "Product 2" [ref=e3]\n- link "Product 3" [ref=e4]\n- link "Product 4" [ref=e5]\n- link "Product 5" [ref=e6]\n- link "Product 6" [ref=e7]\n- link "Product 7" [ref=e8]\n- link "Product 8" [ref=e9]',
      refs: {
        e1: { role: "input", name: "Search products" },
        e2: { role: "link", name: "Product 1" },
        e3: { role: "link", name: "Product 2" },
        e4: { role: "link", name: "Product 3" },
        e5: { role: "link", name: "Product 4" },
        e6: { role: "link", name: "Product 5" },
        e7: { role: "link", name: "Product 6" },
        e8: { role: "link", name: "Product 7" },
        e9: { role: "link", name: "Product 8" },
      },
    }),
  });

  const queries: Array<Record<string, unknown>> = [];
  const result = await executeActAction({
    request: {
      kind: "scroll",
      y: 500,
      targetId: "page-catalog-auto",
    },
    profile: "catalog-scroll-auto-recover",
    proxyRequest: async ({ method, path, query }) => {
      if (method === "GET" && path === "/snapshot") {
        const snapshotQuery = (query ?? {}) as Record<string, unknown>;
        queries.push(snapshotQuery);
        if (
          snapshotQuery.selector ===
          "fieldset, aside, [role='complementary'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter'], [role='group'], section, label, li"
        ) {
          return {
            format: "ai",
            targetId: "page-catalog-auto",
            url: "https://example.com/catalog",
            snapshot: '- checkbox "Size 9" [ref=e11]\n- button "Price" [ref=e12]',
            refs: {
              e11: { role: "checkbox", name: "Size 9" },
              e12: { role: "button", name: "Price" },
            },
            stats: { nodeCount: 4, textLength: 52 },
          };
        }
        return {
          format: "ai",
          targetId: "page-catalog-auto",
          url: "https://example.com/catalog",
          snapshot: "",
          refs: {},
          stats: { nodeCount: 0, textLength: 0 },
        };
      }
      throw new Error(`unexpected browser call: ${method} ${path}`);
    },
  });

  assert.equal(
    queries[0]?.selector,
    "fieldset, aside, [role='complementary'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter'], [role='group'], section, label, li",
  );
  assert.equal(result.details?.ok, true);
  assert.equal((result.details as Record<string, unknown>)?.autoRecoveredFromInvalidAct, true);
  assert.equal((result.details as Record<string, unknown>)?.requiresObservation, true);
  assert.equal((result.details as Record<string, unknown>)?.recoveredFromInvalidAct, true);
  assert.match(
    String((result.details as Record<string, unknown>)?.recoveryReason || ""),
    /do not use a generic page-level scroll/i,
  );
  assert.deepEqual((result.details as Record<string, unknown>)?.invalidRequest, {
    kind: "scroll",
    missing: ["ref"],
  });
  assert.deepEqual((result.details as Record<string, unknown>)?.recoveredObservation?.refs, {
    e11: { role: "checkbox", name: "Size 9" },
    e12: { role: "button", name: "Price" },
  });
});

test("generic evaluate is rejected when the latest snapshot already has actionable refs", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "evaluate-grounding-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-8",
      url: "https://example.com/results",
      snapshot: '- button "Add to Cart" [ref=e81]',
      refs: {
        e81: { role: "button", name: "Add to Cart" },
      },
    }),
  });

  let executed = false;
  const result = await executeActAction({
    request: {
      kind: "evaluate",
      fn: "window.scrollBy(0, 500)",
      targetId: "page-8",
    },
    profile: "evaluate-grounding-test",
    proxyRequest: async () => {
      executed = true;
      return { ok: true };
    },
  });

  assert.equal(executed, false);
  assert.deepEqual(result.details, {
    ok: false,
    recoverable: true,
    requiresObservation: true,
    reason:
      "When the latest snapshot already exposes actionable refs, do not use generic browser evaluate recovery. Choose a concrete ref-backed target from the latest snapshot or capture a fresh scoped observation if the target is no longer visible.",
    snapshotRequest: {
      interactive: true,
      compact: true,
      refs: "aria",
      selector:
        "[aria-modal='true'], [role='dialog'], dialog, form, [role='main'], main, [role='list'], [role='grid'], [role='table'], [role='listbox']",
      ambiguous: false,
    },
    retryGuidance:
      "Capture a fresh scoped interactive snapshot of the active surface and continue only from concrete refs produced by that observation.",
    retryContract: {
      requiresScopedObservation: true,
      refOnly: true,
      disallowGenericPageActionsUntilRefs: true,
    },
    invalidRequest: {
      kind: "evaluate",
      missing: ["ref"],
    },
  });
});

test("short query typing is rejected on a ref-rich catalog surface when not targeting a search field", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "catalog-query-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-9",
      url: "https://example.com/shirts",
      snapshot:
        '- textbox "Sort by" [ref=e91]\n- button "Roadster Shirt" [ref=e92]\n- button "Arrow Shirt" [ref=e93]\n- button "HIGHLANDER Shirt" [ref=e94]',
      refs: {
        e91: { role: "textbox", name: "Sort by" },
        e92: { role: "button", name: "Roadster Shirt" },
        e93: { role: "button", name: "Arrow Shirt" },
        e94: { role: "button", name: "HIGHLANDER Shirt" },
      },
    }),
  });

  let executed = false;
  const result = await executeActAction({
    request: {
      kind: "type",
      ref: "e91",
      text: "shirt",
      targetId: "page-9",
    },
    profile: "catalog-query-test",
    proxyRequest: async () => {
      executed = true;
      return { ok: true };
    },
  });

  assert.equal(executed, false);
  assert.deepEqual(result.details, {
    ok: false,
    recoverable: true,
    requiresObservation: true,
    reason:
      "The latest snapshot already exposes a ref-rich results surface. Do not keep typing a short query into a generic field. Choose a concrete result, filter, or CTA ref from the latest snapshot, or capture a fresh focused search-field snapshot if the search control is truly the next target.",
    snapshotRequest: {
      interactive: true,
      compact: true,
      refs: "aria",
      selector:
        "[aria-modal='true']:has(:focus), [role='dialog']:has(:focus), dialog:has(:focus), form:has(:focus), [contenteditable='true']:focus, textarea:focus, input:focus, [role='textbox']:focus, [role='combobox']:focus",
      ambiguous: false,
    },
    retryGuidance:
      "Capture a fresh focused foreground snapshot and continue only from the actual editable control refs produced by that observation.",
    retryContract: {
      requiresFocusedForegroundSnapshot: true,
      refOnly: true,
      disallowGenericPageActionsUntilRefs: true,
    },
    invalidRequest: {
      kind: "type",
      missing: ["ref"],
    },
  });
});

test("short query typing is allowed on a rich editable compose surface", async () => {
  await executeSnapshotAction({
    input: {
      snapshotFormat: "ai",
    },
    profile: "compose-query-allow-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-compose-2",
      url: "https://example.com/compose",
      snapshot:
        '- region "New Message" [ref=e1]\n- combobox "To recipients" [ref=e5]\n- textbox "Subject" [ref=e8]\n- textbox "Message Body" [ref=e9]\n- button "Send" [ref=e10]',
      refs: {
        e1: { role: "region", name: "New Message" },
        e5: { role: "combobox", name: "To recipients" },
        e8: { role: "textbox", name: "Subject" },
        e9: { role: "textbox", name: "Message Body" },
        e10: { role: "button", name: "Send" },
      },
    }),
  });

  let executed = false;
  const result = await executeActAction({
    request: {
      kind: "type",
      ref: "e5",
      text: "ada@example.com",
      targetId: "page-compose-2",
    },
    profile: "compose-query-allow-test",
    proxyRequest: async () => {
      executed = true;
      return { ok: true, typed: true };
    },
  });

  assert.equal(executed, true);
  assert.deepEqual(result.details, {
    ok: true,
    typed: true,
  });
});

test("snapshot defaults request interactive compact aria refs for automation grounding", async () => {
  let snapshotQuery: Record<string, unknown> | null = null;
  await executeSnapshotAction({
    input: {},
    profile: "snapshot-defaults-test",
    proxyRequest: async (opts) => {
      snapshotQuery = opts.query ? { ...opts.query } : null;
      return {
        format: "ai",
        targetId: "page-2",
        url: "https://example.com",
        snapshot: '- button "Continue" [ref=e21]',
        refs: {
          e21: { role: "button", name: "Continue" },
        },
      };
    },
  });

  assert.deepEqual(snapshotQuery, {
    format: "aria",
    targetId: undefined,
    limit: undefined,
    refs: "aria",
    interactive: true,
    compact: true,
    depth: undefined,
    selector: undefined,
    frame: undefined,
    labels: false,
    mode: undefined,
  });
});

test("selector-scoped interactive snapshots default to aria format and refs", async () => {
  let snapshotQuery: Record<string, unknown> | null = null;
  await executeSnapshotAction({
    input: {
      selector: "[role='search']",
    },
    profile: "snapshot-selector-defaults-test",
    proxyRequest: async (opts) => {
      snapshotQuery = opts.query ? { ...opts.query } : null;
      return {
        format: "aria",
        targetId: "page-scope-1",
        url: "https://example.com/catalog",
        snapshot: '- searchbox "Search products" [ref=e8]',
        nodes: [],
        refs: {
          e8: { role: "searchbox", name: "Search products" },
        },
      };
    },
  });

  assert.deepEqual(snapshotQuery, {
    format: "aria",
    targetId: undefined,
    limit: undefined,
    refs: "aria",
    interactive: true,
    compact: true,
    depth: undefined,
    selector: "[role='search']",
    frame: undefined,
    labels: false,
    mode: undefined,
  });
});

test("interactive snapshot without refs returns a grounding recovery result", async () => {
  const result = await executeSnapshotAction({
    input: {},
    profile: "snapshot-no-refs-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-3",
      url: "https://example.com/results",
      snapshot: "Results page without stable refs",
      refs: {},
    }),
  });

  assert.deepEqual(result.details, {
    ok: false,
    recoverable: true,
    requiresObservation: true,
    reason:
      "The interactive snapshot did not expose any actionable refs. Narrow the observation to the active surface or result region before acting, and do not continue with generic page-level scroll or click recovery from this snapshot.",
    snapshotRequest: {
      snapshotFormat: "aria",
      interactive: true,
      compact: true,
      refs: "aria",
      selector:
        "[aria-modal='true'], [role='dialog'], dialog, aside, [role='complementary'], [role='search'], form, [role='main'], main, [role='list'], [role='grid'], [role='table'], [role='listbox'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter']",
      ambiguous: false,
    },
    retryGuidance:
      "Retry with a narrower structural observation of the filter rail, sidebar, complementary region, or results container. If the desired control is off-screen, use scrollIntoView on a concrete ref from that scoped snapshot instead of a generic page scroll.",
    retryContract: {
      requiresScopedObservation: true,
      refOnly: true,
      preferScrollIntoView: true,
      disallowGenericPageActionsUntilRefs: true,
    },
    error: undefined,
  });
});

test("interactive catalog snapshot without refs requests filter-aware scoped recovery", async () => {
  const result = await executeSnapshotAction({
    input: {},
    profile: "snapshot-no-refs-catalog-test",
    proxyRequest: async () => ({
      format: "ai",
      targetId: "page-4",
      url: "https://example.com/catalog",
      snapshot: "Catalog results without stable refs",
      refs: {},
    }),
  });

  assert.deepEqual(result.details, {
    ok: false,
    recoverable: true,
    requiresObservation: true,
    reason:
      "The interactive snapshot did not expose any actionable refs. Narrow the observation to the active surface or result region before acting, and do not continue with generic page-level scroll or click recovery from this snapshot.",
    snapshotRequest: {
      snapshotFormat: "aria",
      interactive: true,
      compact: true,
      refs: "aria",
      selector:
        "[aria-modal='true'], [role='dialog'], dialog, aside, [role='complementary'], [role='search'], form, [role='main'], main, [role='list'], [role='grid'], [role='table'], [role='listbox'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter']",
      ambiguous: false,
    },
    retryGuidance:
      "Retry with a narrower structural observation of the filter rail, sidebar, complementary region, or results container. If the desired control is off-screen, use scrollIntoView on a concrete ref from that scoped snapshot instead of a generic page scroll.",
    retryContract: {
      requiresScopedObservation: true,
      refOnly: true,
      preferScrollIntoView: true,
      disallowGenericPageActionsUntilRefs: true,
    },
    error: undefined,
  });
});

test("empty scoped interactive snapshot falls back to structural catalog probes", async () => {
  const queries: Array<Record<string, unknown>> = [];
  const result = await executeSnapshotAction({
    input: {
      interactive: true,
      selector: ".filters-container",
    },
    profile: "snapshot-scoped-fallback-test",
    proxyRequest: async ({ query }) => {
      const snapshotQuery = (query ?? {}) as Record<string, unknown>;
      queries.push(snapshotQuery);
      if (snapshotQuery.selector === ".filters-container") {
        return {
          format: "ai",
          targetId: "page-5",
          url: "https://example.com/catalog",
          snapshot: "",
          refs: {},
          stats: { nodeCount: 0, textLength: 0 },
        };
      }
      if (snapshotQuery.selector === "[role='main'], main") {
        return {
          format: "ai",
          targetId: "page-5",
          url: "https://example.com/catalog",
          snapshot: '- checkbox "Size 9" [ref=e11]',
          refs: {
            e11: { role: "checkbox", name: "Size 9" },
          },
          stats: { nodeCount: 4, textLength: 32 },
        };
      }
      return {
        format: "ai",
        targetId: "page-5",
        url: "https://example.com/catalog",
        snapshot: "",
        refs: {},
        stats: { nodeCount: 0, textLength: 0 },
      };
    },
  });

  assert.equal(queries[0]?.selector, ".filters-container");
  assert.equal(queries.at(-1)?.selector, "[role='main'], main");
  assert.equal(result.details?.ok, true);
  assert.equal(result.details?.refCount, 1);
  assert.equal(result.details?.nodeCount, 4);
  assert.deepEqual(result.details?.refs, {
    e11: { role: "checkbox", name: "Size 9" },
  });
});

test("broad interactive catalog snapshot probes scoped filter regions when it only exposes result links", async () => {
  const queries: Array<Record<string, unknown>> = [];
  const result = await executeSnapshotAction({
    input: {
      interactive: true,
    },
    profile: "snapshot-catalog-probe-test",
    proxyRequest: async ({ query }) => {
      const snapshotQuery = (query ?? {}) as Record<string, unknown>;
      queries.push(snapshotQuery);
      if (!snapshotQuery.selector) {
        return {
          format: "ai",
          targetId: "page-catalog",
          url: "https://example.com/catalog",
          snapshot:
            '- input "Search products" [ref=e1]\n- link "Product 1" [ref=e2]\n- link "Product 2" [ref=e3]\n- link "Product 3" [ref=e4]\n- link "Product 4" [ref=e5]\n- link "Product 5" [ref=e6]\n- link "Product 6" [ref=e7]\n- link "Product 7" [ref=e8]\n- link "Product 8" [ref=e9]',
          refs: {
            e1: { role: "input", name: "Search products" },
            e2: { role: "link", name: "Product 1" },
            e3: { role: "link", name: "Product 2" },
            e4: { role: "link", name: "Product 3" },
            e5: { role: "link", name: "Product 4" },
            e6: { role: "link", name: "Product 5" },
            e7: { role: "link", name: "Product 6" },
            e8: { role: "link", name: "Product 7" },
            e9: { role: "link", name: "Product 8" },
          },
          stats: { nodeCount: 18, textLength: 240 },
        };
      }
      if (
        snapshotQuery.selector ===
        "fieldset, aside, [role='complementary'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter'], [role='group'], section, label, li"
      ) {
        return {
          format: "ai",
          targetId: "page-catalog",
          url: "https://example.com/catalog",
          snapshot:
            '- checkbox "Size 9" [ref=e11]\n- checkbox "4 stars & above" [ref=e12]\n- button "Price" [ref=e13]',
          refs: {
            e11: { role: "checkbox", name: "Size 9" },
            e12: { role: "checkbox", name: "4 stars & above" },
            e13: { role: "button", name: "Price" },
          },
          stats: { nodeCount: 7, textLength: 96 },
        };
      }
      return {
        format: "ai",
        targetId: "page-catalog",
        url: "https://example.com/catalog",
        snapshot: "",
        refs: {},
        stats: { nodeCount: 0, textLength: 0 },
      };
    },
  });

  assert.equal(queries[0]?.selector, undefined);
  assert.equal(
    queries[1]?.selector,
    "fieldset, aside, [role='complementary'], [aria-label*='filter' i], [aria-labelledby*='filter' i], [class*='filter'], [data-testid*='filter'], [role='group'], section, label, li",
  );
  assert.equal(result.details?.ok, true);
  assert.deepEqual(result.details?.refs, {
    e11: { role: "checkbox", name: "Size 9" },
    e12: { role: "checkbox", name: "4 stars & above" },
    e13: { role: "button", name: "Price" },
  });
});
