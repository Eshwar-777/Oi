import test from "node:test";
import assert from "node:assert/strict";
import { executeActAction } from "./browser-tool.actions.ts";

test("executeActAction requests re-observation for incomplete click request", async () => {
  const result = await executeActAction({
    request: { kind: "click" },
    proxyRequest: null,
  });
  assert.equal((result.details as Record<string, unknown>).requiresObservation, true);
  assert.equal((result.details as Record<string, unknown>).recoverable, true);
  assert.deepEqual((result.details as Record<string, unknown>).invalidRequest, {
    kind: "click",
    missing: ["ref|selector"],
  });
});

test("executeActAction requests re-observation for incomplete fill request", async () => {
  const result = await executeActAction({
    request: { kind: "fill" },
    proxyRequest: null,
  });
  assert.equal((result.details as Record<string, unknown>).requiresObservation, true);
  assert.equal((result.details as Record<string, unknown>).recoverable, true);
  assert.deepEqual((result.details as Record<string, unknown>).invalidRequest, {
    kind: "fill",
    missing: ["fields"],
  });
});
