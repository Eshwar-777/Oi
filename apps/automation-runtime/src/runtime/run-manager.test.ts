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

test("run manager treats duplicate active run starts as idempotent", async () => {
  const manager = new RunManager();
  const internal = manager as unknown as {
    runs: Map<
      string,
      {
        record: {
          runId: string;
          sessionId: string;
          state: "running";
          createdAt: string;
          updatedAt: string;
          error: null;
          result: null;
        };
        events: Array<{ seq: number }>;
      }
    >;
  };
  internal.runs.set("run-manager-dup", {
    record: {
      runId: "run-manager-dup",
      sessionId: "session-dup",
      state: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
      result: null,
    },
    events: [{ seq: 0 }],
  } as never);

  const second = await manager.startRun({
    runId: "run-manager-dup",
    sessionId: "session-dup",
    text: "open browser",
    browser: { mode: "cdp", cdpUrl: "http://127.0.0.1:1" },
    context: { userId: "user-dup", timezone: "UTC", locale: "en-US" },
  });
  assert.equal(second.run.runId, "run-manager-dup");
  assert.equal(second.run.state, "running");
  assert.equal(second.cursor, 1);
});
