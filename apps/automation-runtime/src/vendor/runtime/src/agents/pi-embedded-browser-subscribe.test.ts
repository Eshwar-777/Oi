import test from "node:test";
import assert from "node:assert/strict";

import { __testOnly } from "./pi-embedded-browser-subscribe.js";

test("recoverable invalid tool payloads are treated as tool errors", () => {
  assert.equal(
    __testOnly.isToolResultError({
      details: {
        ok: false,
        recoverable: true,
        requiresObservation: true,
        reason: "Use a concrete ref from a fresh snapshot.",
      },
    }),
    true,
  );
});

test("successful tool payloads are not treated as tool errors", () => {
  assert.equal(
    __testOnly.isToolResultError({
      details: {
        ok: true,
      },
    }),
    false,
  );
});

test("auto-recovered invalid browser mutations are treated as tool errors", () => {
  assert.equal(
    __testOnly.isToolResultError({
      details: {
        ok: true,
        autoRecoveredFromInvalidAct: true,
        autoRecoveryKind: "catalog_scoped_snapshot",
        recoveryReason:
          "A generic page-level action was replaced with a scoped catalog snapshot so the next step can use concrete filter or result refs.",
      },
    }),
    true,
  );
});
