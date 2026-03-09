import test from "node:test";
import assert from "node:assert/strict";

import type { AssistantState } from "./assistantStore.ts";
import type { RunDetailResponse } from "@/domain/automation";

import { assistantReducer, initialState } from "./assistantStore.ts";

test("UPSERT_RUN_DETAIL refreshes active run and active plan when they match", () => {
  const detail = {
    run: {
      run_id: "run-1",
      plan_id: "plan-1",
      session_id: "session-1",
      state: "failed",
      execution_mode: "immediate",
      executor_mode: "local_runner",
      automation_engine: "agent_browser",
      browser_session_id: "browser-1",
      current_step_index: 1,
      total_steps: 2,
      created_at: "2026-03-09T00:00:00Z",
      updated_at: "2026-03-09T00:00:01Z",
      last_error: {
        code: "MODEL_UNCERTAIN",
        message: "Planner could not produce actionable follow-up browser steps.",
        retryable: true,
      },
    },
    plan: {
      plan_id: "plan-1",
      intent_id: "intent-1",
      execution_mode: "immediate",
      summary: "send message",
      targets: [],
      steps: [
        {
          step_id: "s1",
          label: "Type dippa",
          description: "Type dippa",
          status: "completed",
        },
        {
          step_id: "s2",
          label: "Extract structure",
          description: "Extract structure",
          status: "failed",
        },
      ],
      requires_confirmation: false,
    },
    artifacts: [],
  } satisfies RunDetailResponse;

  const state: AssistantState = {
    ...initialState,
    activeRun: {
      ...detail.run,
      state: "running",
      total_steps: 0,
      current_step_index: 0,
      updated_at: "2026-03-09T00:00:00Z",
      last_error: null,
    },
    activePlan: {
      ...detail.plan,
      steps: [],
    },
  };

  const next = assistantReducer(state, { type: "UPSERT_RUN_DETAIL", detail });

  assert.equal(next.activeRun?.state, "failed");
  assert.equal(next.activeRun?.total_steps, 2);
  assert.equal(next.activePlan?.steps.length, 2);
  assert.equal(next.runDetails["run-1"]?.run.state, "failed");
});

test("APPEND_TIMELINE keeps items ordered by timestamp", () => {
  const stateWithLatest = assistantReducer(initialState, {
    type: "APPEND_TIMELINE",
    item: {
      id: "user-2",
      type: "user",
      timestamp: "2026-03-09T00:00:02Z",
      text: "later",
      attachments: [],
    },
  });

  const next = assistantReducer(stateWithLatest, {
    type: "APPEND_TIMELINE",
    item: {
      id: "user-1",
      type: "user",
      timestamp: "2026-03-09T00:00:01Z",
      text: "earlier",
      attachments: [],
    },
  });

  assert.deepEqual(next.timeline.map((item) => item.id), ["user-1", "user-2"]);
});
