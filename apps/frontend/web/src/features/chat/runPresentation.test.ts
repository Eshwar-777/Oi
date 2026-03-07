import test from "node:test";
import assert from "node:assert/strict";

import {
  getRunActionLabel,
  getRunSummary,
  shouldSimulateManualAction,
} from "./runPresentation.ts";

test("waiting for user action uses confirm and resume language", () => {
  assert.equal(getRunActionLabel("waiting_for_user_action"), "Confirm & Resume");
  assert.equal(getRunActionLabel("paused"), "Resume");
});

test("run summary prioritizes backend manual action reason", () => {
  assert.deepEqual(
    getRunSummary("waiting_for_user_action", "Press Send in WhatsApp Web, then continue."),
    {
      title: "Manual action required",
      subtitle: "Press Send in WhatsApp Web, then continue.",
    },
  );
});

test("manual action simulation is triggered by real-world boundary keywords", () => {
  assert.equal(shouldSimulateManualAction("Send a message to Dippa on WhatsApp"), true);
  assert.equal(shouldSimulateManualAction("Play the current video"), true);
  assert.equal(shouldSimulateManualAction("Open the dashboard"), false);
});
