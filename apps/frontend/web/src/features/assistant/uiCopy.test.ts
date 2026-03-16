import test from "node:test";
import assert from "node:assert/strict";

import {
  decisionLabel,
  errorCopy,
  missingFieldLabel,
  runStateLabel,
} from "./uiCopy.ts";

test("schedule decisions use schedule-specific labels", () => {
  assert.equal(decisionLabel("READY_TO_SCHEDULE"), "Ready to schedule");
  assert.equal(decisionLabel("READY_FOR_MULTI_TIME_SCHEDULE"), "Ready for repeated schedule");
});

test("timing_mode missing field is human-readable", () => {
  assert.equal(missingFieldLabel("timing_mode"), "When and how to run it");
});

test("scheduled run state has explicit schedule wording", () => {
  assert.equal(runStateLabel("scheduled"), "Scheduled");
});

test("schedule misfire error has actionable copy", () => {
  assert.equal(
    errorCopy("SCHEDULE_MISFIRED"),
    "The scheduled run did not start at the expected time.",
  );
});
