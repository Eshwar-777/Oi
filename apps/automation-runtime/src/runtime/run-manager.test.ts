import test from "node:test";
import assert from "node:assert/strict";
import { RunManager } from "./run-manager.ts";

test("run manager marks prompt-run failures as failed instead of leaving them running", async () => {
  const manager = new RunManager();
  const { run } = await manager.startRun({
    runId: "run-manager-1",
    sessionId: "session-1",
    text: "send email",
    browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:1" },
    context: { userId: "user-1", timezone: "UTC", locale: "en-US" },
  });

  assert.equal(run.state, "queued");

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stored = manager.getRun("run-manager-1");
    if (stored?.state === "failed") {
      assert.match(String(stored.error || ""), /connect/i);
      return;
    }
  }

  assert.fail("run manager did not transition the thrown prompt run into a failed state");
});
