import test from "node:test";
import assert from "node:assert/strict";
import { __testOnly } from "./runtime-agent-bridge.ts";

test("browser task prompt warns against read-only churn and vague control retries", () => {
  const prompt = __testOnly.browserTaskPrompt({
    request: {
      runId: "run-1",
      text: "Open Myntra and place the order for the first maroon shirt under 1000 rupees.",
      goalHints: {
        taskMode: "browser_automation",
        app: "Myntra",
        entities: { app: "Myntra", target: "shirt" },
      },
    },
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    workspaceDir: process.cwd(),
  });

  assert.match(prompt, /Avoid read-only churn/i);
  assert.match(prompt, /generic current-page-control or evaluate step fails/i);
  assert.match(prompt, /only mutating actions with a concrete ref are acceptable/i);
  assert.match(prompt, /do not put visible labels like COLOR or \+ 44 more into the ref field/i);
});

test("browser task extra system prompt stays focused on the thin browser contract", () => {
  const prompt = __testOnly.browserTaskExtraSystemPrompt({
    request: {
      runId: "run-2",
      text: "Open Myntra and continue through checkout for the selected shirt.",
      goalHints: {
        taskMode: "browser_automation",
        app: "Myntra",
        entities: { app: "Myntra", target: "shirt" },
      },
    },
    sessionId: "session-2",
    sessionKey: "agent:main:session-2",
    workspaceDir: process.cwd(),
  });

  assert.ok(prompt);
  assert.match(prompt!, /at most three consecutive read-only browser actions/i);
  assert.match(prompt!, /primary visible next-step control over broad exploratory evaluation/i);
  assert.match(prompt!, /every mutating click, type, hover, or select action must name a concrete ref/i);
  assert.match(prompt!, /use the ref token exactly as shown/i);
  assert.doesNotMatch(prompt!, /multi-stage cross-app browser workflow/i);
});

test("browser task extra system prompt includes the active execution step contract when present", () => {
  const prompt = __testOnly.browserTaskExtraSystemPrompt({
    request: {
      runId: "run-2b",
      text: "Apply the remaining filters on Myntra.",
      goalHints: {
        taskMode: "browser_automation",
        app: "Myntra",
        executionContract: {
          ui_surface: { kind: "listing" },
          current_execution_step: {
            kind: "filter",
            label: "Capture a scoped filter-surface snapshot before the next catalog action",
            allowed_actions: ["snapshot"],
            snapshot_sequence: [
              { selector: "aside", interactive: true, compact: true, snapshotFormat: "aria", refs: "aria" },
            ],
          },
        },
      },
    },
    sessionId: "session-2b",
    sessionKey: "agent:main:session-2b",
    workspaceDir: process.cwd(),
  });

  assert.ok(prompt);
  assert.match(prompt!, /Current step kind: filter/i);
  assert.match(prompt!, /Use this scoped snapshot sequence exactly/i);
  assert.match(prompt!, /Do not work on later steps until the current step verifies/i);
});

test("browser task prompt stays thin even when backend execution step metadata is present", () => {
  const prompt = __testOnly.browserTaskPrompt({
    request: {
      runId: "run-3",
      text: "Find a shirt on Myntra.",
      goalHints: {
        taskMode: "browser_automation",
        app: "Myntra",
        entities: { app: "Myntra", target: "shirt" },
        executionContract: {
          ui_surface: { kind: "listing" },
          current_execution_step: {
            kind: "search",
            label: "Search for 'shirt'",
            verification_rules: [{ kind: "search_query", value: "shirt" }],
          },
        },
      },
    },
    sessionId: "session-3",
    sessionKey: "agent:main:session-3",
    workspaceDir: process.cwd(),
  });

  assert.doesNotMatch(prompt, /Current step kind:/i);
  assert.doesNotMatch(prompt, /Only perform actions that directly advance the search step/i);
  assert.match(prompt, /Complete this task through the live browser session using the browser tool/i);
});

test("browser task prompt does not inject navigate-step prose into the runtime task prompt", () => {
  const prompt = __testOnly.browserTaskPrompt({
    request: {
      runId: "run-4",
      text: "Open Myntra.",
      goalHints: {
        taskMode: "browser_automation",
        app: "Myntra",
        executionContract: {
          current_execution_step: {
            kind: "navigate",
            label: "Go to Myntra.com",
          },
        },
      },
    },
    sessionId: "session-4",
    sessionKey: "agent:main:session-4",
    workspaceDir: process.cwd(),
  });

  assert.doesNotMatch(prompt, /Current step kind: navigate/i);
  assert.doesNotMatch(prompt, /Intended target site or app: Myntra/i);
  assert.match(prompt, /Open Myntra\./i);
});

test("current execution step block includes explicit scoped snapshot sequence instructions", () => {
  const block = __testOnly.currentExecutionStepBlock({
    request: {
      runId: "run-5",
      text: "Apply the remaining filters on Myntra.",
      goalHints: {
        taskMode: "browser_automation",
        app: "Myntra",
        executionContract: {
          ui_surface: { kind: "listing" },
          current_execution_step: {
            kind: "filter",
            label: "Capture a scoped filter-surface snapshot before the next catalog action",
            allowed_actions: ["snapshot"],
            snapshot_sequence: [
              { selector: "aside", interactive: true, compact: true, snapshotFormat: "aria", refs: "aria" },
              { selector: "[role='complementary']", interactive: true, compact: true, snapshotFormat: "aria", refs: "aria" },
            ],
          },
        },
      },
    },
    sessionId: "session-5",
    sessionKey: "agent:main:session-5",
    workspaceDir: process.cwd(),
  });

  assert.match(block, /Use this scoped snapshot sequence exactly/i);
  assert.match(block, /selector "aside"/i);
  assert.match(block, /snapshotFormat=aria, refs=aria/i);
  assert.match(block, /Do not use generic page scrolling, vague clicks, or evaluate/i);
});
