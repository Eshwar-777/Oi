import assert from "node:assert/strict";
import test from "node:test";
import { __testOnly } from "./browser-tool.js";

test("normalizes top-level type action into explicit act request", () => {
  const normalized = __testOnly.normalizeBrowserToolParams({
    action: "type",
    ref: "e5",
    text: "black running shoes for men",
  });

  assert.equal(normalized.action, "act");
  assert.deepEqual(normalized.request, {
    kind: "type",
    ref: "e5",
    text: "black running shoes for men",
  });

  const request = __testOnly.readActRequestParam(normalized);
  assert.deepEqual(request, {
    kind: "type",
    ref: "e5",
    text: "black running shoes for men",
  });
});

test("normalizes top-level click action into explicit act request", () => {
  const normalized = __testOnly.normalizeBrowserToolParams({
    action: "click",
    ref: "@e12",
    targetId: "tab-1",
  });

  assert.equal(normalized.action, "act");
  assert.deepEqual(normalized.request, {
    kind: "click",
    ref: "@e12",
    targetId: "tab-1",
  });
});

test("normalizes top-level scroll action into explicit act request", () => {
  const normalized = __testOnly.normalizeBrowserToolParams({
    action: "scroll",
    x: 0,
    y: "document.body.scrollHeight",
  });

  assert.equal(normalized.action, "act");
  assert.deepEqual(normalized.request, {
    kind: "scroll",
    x: 0,
    y: "page_end",
  });
});

test("normalizes top-level scrollIntoView action into explicit act request", () => {
  const normalized = __testOnly.normalizeBrowserToolParams({
    action: "scrollIntoView",
    ref: "e116",
  });

  assert.equal(normalized.action, "act");
  assert.deepEqual(normalized.request, {
    kind: "scrollIntoView",
    ref: "e116",
  });
});
