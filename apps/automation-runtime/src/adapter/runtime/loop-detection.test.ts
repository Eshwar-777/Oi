import test from "node:test";
import assert from "node:assert/strict";
import { createLoopState, recordLoopObservation } from "./loop-detection.ts";

test("loop detection flags identical repeated observations", () => {
  const state = createLoopState();
  assert.deepEqual(recordLoopObservation(state, "snapshot:ai::", "same"), { stuck: false });
  assert.deepEqual(recordLoopObservation(state, "snapshot:ai::", "same"), { stuck: false });
  const result = recordLoopObservation(state, "snapshot:ai::", "same");
  assert.equal(result.stuck, true);
  if (result.stuck) {
    assert.equal(result.detector, "generic_repeat");
  }
});

test("loop detection flags ping pong observations with no progress", () => {
  const state = createLoopState();
  recordLoopObservation(state, "snapshot:ai::", "same");
  recordLoopObservation(state, "snapshot:role:dialog:", "same");
  recordLoopObservation(state, "snapshot:ai::", "same");
  const result = recordLoopObservation(state, "snapshot:role:dialog:", "same");
  assert.equal(result.stuck, true);
  if (result.stuck) {
    assert.equal(result.detector, "ping_pong");
  }
});
