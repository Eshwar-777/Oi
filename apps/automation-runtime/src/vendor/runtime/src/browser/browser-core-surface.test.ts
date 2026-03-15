import test from "node:test";
import assert from "node:assert/strict";
import { __testOnly } from "./browser-core-surface.ts";

test("blocked top-level navigation errors are recognized", () => {
  assert.equal(
    __testOnly.isBlockedTopLevelNavigationError(
      'page.goto: net::ERR_BLOCKED_BY_RESPONSE at https://developer.mozilla.org/',
    ),
    true,
  );
});

test("non-blocked navigation errors are not misclassified", () => {
  assert.equal(
    __testOnly.isBlockedTopLevelNavigationError(
      "page.goto: net::ERR_NAME_NOT_RESOLVED at https://developer.mozilla.org/",
    ),
    false,
  );
});

test("editable roles are recognized for richer locator resolution", () => {
  assert.equal(
    __testOnly.entryMayBeEditable({ xpath: "/html/body/div[1]", role: "combobox", name: "To recipients" }),
    true,
  );
  assert.equal(
    __testOnly.entryMayBeEditable({ xpath: "/html/body/div[1]", role: "button", name: "Compose" }),
    false,
  );
});

test("scoped snapshot candidate selection prefers the largest visible match", () => {
  assert.equal(
    __testOnly.selectBestScopedCandidateIndex([
      { visible: false, area: 5 },
      { visible: true, area: 25 },
      { visible: true, area: 100 },
    ]),
    1,
  );
});

test("scoped snapshot candidate selection prefers the active surface over size", () => {
  assert.equal(
    __testOnly.selectBestScopedCandidateIndex([
      { visible: true, area: 500 },
      { visible: true, area: 100, containsActive: true },
    ]),
    1,
  );
});

test("ref-shaped scoped snapshot selectors are recognized", () => {
  assert.equal(__testOnly.selectorRefToken("[ref='e70']"), "e70");
  assert.equal(__testOnly.selectorRefToken('@e12'), "e12");
  assert.equal(__testOnly.selectorRefToken("section.results"), undefined);
});

test("reusable page scoring prefers exact matches over opening a duplicate tab", () => {
  assert.equal(
    __testOnly.reusablePageScore(
      "https://www.myntra.com/black-running-shoes-for-men?rawQuery=test",
      "https://www.myntra.com/black-running-shoes-for-men?rawQuery=test",
    ) > __testOnly.reusablePageScore(
      "https://www.myntra.com/",
      "https://www.myntra.com/black-running-shoes-for-men?rawQuery=test",
    ),
    true,
  );
});

test("reusable page scoring treats same-site tabs as reusable candidates", () => {
  assert.equal(
    __testOnly.reusablePageScore(
      "https://www.myntra.com/",
      "https://www.myntra.com/black-running-shoes-for-men?rawQuery=test",
    ) > 0,
    true,
  );
  assert.equal(
    __testOnly.reusablePageScore(
      "https://developer.mozilla.org/",
      "https://www.myntra.com/black-running-shoes-for-men?rawQuery=test",
    ),
    0,
  );
});

test("bounding box click point targets the visual center", () => {
  assert.deepEqual(
    __testOnly.boundingBoxClickPoint({ x: 10, y: 20, width: 100, height: 40 }),
    { x: 60, y: 40 },
  );
});
